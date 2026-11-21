/**
 * ============================================================================
 * MÓDULO DE PARSING DEL BANCO DE CHILE (GMAIL -> JSON ESTRUCTURADO)
 * Soporta el 100% de las plantillas reales de Banco de Chile en:
 *  - enviodigital@bancochile.cl (Cargo en Cuenta ****0401, Compra con Tarjeta
 *    de Crédito ****4114, Giro con Tarjeta de Débito)
 *  - serviciodetransferencias@bancochile.cl (Transferencia a Terceros,
 *    Banca Empresa REM/BH, Pago de Tarjeta de Crédito Nacional, Aviso TEF)
 * ============================================================================
 */

const { LLM_SYSTEM_PROMPT, evaluateTransaction } = require('../agent/financialEvaluator');

const OFFICIAL_BCH_DOMAINS = [
  'bancochile.cl',
  'serviciodetransferencias@bancochile.cl',
  'enviodigital@bancochile.cl',
  'notificaciones@bancochile.cl'
];

function isOfficialBancoChileSender(fromHeader = '') {
  const lower = String(fromHeader).toLowerCase();
  // Excluir correos publicitarios / marketing de contacto@comunicaciones.bancochile.cl
  if (lower.includes('comunicaciones.bancochile.cl')) return false;
  return /@([a-z0-9-]+\.)?bancochile\.cl\b/.test(lower) || OFFICIAL_BCH_DOMAINS.some((d) => lower.includes(d));
}

function htmlToStructuredLines(rawHtml = '') {
  const withoutStyles = rawHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');

  const unescaped = withoutStyles
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/&bull;/gi, '•')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#169;/g, '©')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/[\u200B-\u200F\uFEFF]/g, '');

  return unescaped
    .replace(/<\/(tr|td|p|div|br|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function findValueAfterLabel(lines, labelRegex) {
  for (let i = 0; i < lines.length; i++) {
    if (labelRegex.test(lines[i])) {
      const inlineMatch = lines[i].match(/:\s*(.+)$/);
      if (inlineMatch && inlineMatch[1].trim() && !labelRegex.test(inlineMatch[1].trim())) {
        return inlineMatch[1].trim();
      }
      if (i + 1 < lines.length) {
        return lines[i + 1].trim();
      }
    }
  }
  return '';
}

function parseChileanAmount(rawAmount = '') {
  const clean = String(rawAmount).replace(/[^\d]/g, '');
  return clean ? parseInt(clean, 10) : 0;
}

function normalizeTransactionDate(headerDate, dmyString, timeString) {
  let dateObj = headerDate ? new Date(headerDate) : new Date();
  if (isNaN(dateObj.getTime())) dateObj = new Date();

  const timeMatch = (timeString || dmyString || '').match(/(\d{1,2}:\d{2})/);
  const timePart = timeMatch
    ? timeMatch[1].padStart(5, '0')
    : dateObj.toTimeString().slice(0, 5);

  const dmyMatch = (dmyString || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (dmyMatch) {
    const [, dd, mm, yyyy] = dmyMatch;
    return {
      iso: `${yyyy}-${mm}-${dd}T${timePart}:00-03:00`,
      display: `${dd}/${mm}/${yyyy} ${timePart}`
    };
  }

  const dd = String(dateObj.getDate()).padStart(2, '0');
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const yyyy = dateObj.getFullYear();
  return {
    iso: `${yyyy}-${mm}-${dd}T${timePart}:00-03:00`,
    display: `${dd}/${mm}/${yyyy} ${timePart}`
  };
}

/**
 * Parser determinístico para todos los formatos reales del Banco de Chile
 * Devuelve null si el correo es un resumen informativo no transaccional o duplicado de recibo App
 */
function parseBancoChileEmail({
  messageId,
  threadId,
  from,
  subject,
  dateHeader,
  rawBody,
  userRules = [],
  source = 'GMAIL_REAL'
}) {
  if (!isOfficialBancoChileSender(from)) {
    return null;
  }

  // Excluir cartolas y estados de cuenta informativos
  if (/Cartola|Estado de Cuenta/i.test(subject)) {
    return null;
  }

  const lines = htmlToStructuredLines(rawBody);
  const fullText = lines.join(' ');
  const pipeText = lines.join(' | ');

  // Excluir "Comprobante de Pago" cuando el medio de pago fue Tarjeta de Crédito
  // (ya que llega simultáneamente el correo "Compra con Tarjeta de Crédito")
  if (/Comprobante de Pago/i.test(subject) && /Medio de pago\s*\|\s*Tarjeta de Cr[ée]dito/i.test(pipeText)) {
    return null;
  }

  let amount = 0;
  let flow_type = 'EGRESO';
  let instrument = 'DEBITO_CUENTA';
  let card_last4 = 'Cuenta ****0401';
  let installments_current = 1;
  let installments_total = 1;
  let merchant = 'Movimiento Banco de Chile';
  let destination_bank = null;
  let destination_account = null;
  let transfer_subject = null;
  let voucher_number = `BCH-${messageId.slice(-10).toUpperCase()}`;
  let transaction_date = '';
  let display_date = '';

  // CASO 1: "Cargo en Cuenta" (enviodigital@bancochile.cl)
  // "Te informamos que se ha realizado una compra por $5.740 con cargo a Cuenta ****0401 en SERVICIOS Y COMER el 20/11/2026 08:20."
  const cargoMatch = fullText.match(
    /compra por \$([\d.]+)\s+con cargo a Cuenta\s+(\*{3,4}\d{4})\s+en\s+(.+?)\s+el\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/i
  );

  // CASO 2: "Compra con Tarjeta de Crédito" (enviodigital@bancochile.cl)
  // "Te informamos que se ha realizado una compra por $10.000 con Tarjeta de Crédito ****4114 en LAS TORRES (MACD 1) el 18/11/2026 08:08."
  const creditoMatch = fullText.match(
    /compra por \$([\d.]+)\s+con Tarjeta de Cr[ée]dito\s+(\*{3,4}\d{4})\s+en\s+(.+?)\s+el\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/i
  );

  // CASO 3: "Giro con Tarjeta de Débito" (enviodigital@bancochile.cl)
  // "Te informamos que se ha realizado un giro en Cajero por $10.000 con cargo a Cuenta ****0401 el 07/10/2026 19:17."
  const giroMatch = fullText.match(
    /giro en Cajero por \$([\d.]+)\s+con cargo a Cuenta\s+(\*{3,4}\d{4})\s+el\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/i
  );

  // CASO 4: "Banca Empresa | Comprobante de Transferencia" (REM 202610, BH mes de septiembre)
  const empresaMatch = fullText.match(/Te informamos que\s+(.+?)\s+ha instruido la siguiente transferencia/i);

  // CASO 5: "Transferencias de Fondos de ..." ("Le informamos que Carlos Estelmo Sepulveda Candia le ha transferido $100.000")
  const tefRecibidaMatch = fullText.match(/Le informamos que\s+(.+?)\s+le ha transferido\s+\$([\d.]+)/i);

  if (cargoMatch) {
    amount = parseChileanAmount(cargoMatch[1]);
    instrument = 'DEBITO_CUENTA';
    card_last4 = `Cuenta ${cargoMatch[2]}`;
    merchant = cargoMatch[3].replace(/\s+/g, ' ').trim();
    const norm = normalizeTransactionDate(dateHeader, cargoMatch[4], cargoMatch[5]);
    transaction_date = norm.iso;
    display_date = norm.display;
    voucher_number = `DEB-${cargoMatch[4].replace(/\//g, '')}-${cargoMatch[5].replace(':', '')}-${messageId.slice(-4).toUpperCase()}`;
  } else if (creditoMatch) {
    amount = parseChileanAmount(creditoMatch[1]);
    instrument = 'CREDITO';
    card_last4 = `Tarjeta Crédito ${creditoMatch[2]}`;
    merchant = creditoMatch[3].replace(/\s+/g, ' ').trim();
    const norm = normalizeTransactionDate(dateHeader, creditoMatch[4], creditoMatch[5]);
    transaction_date = norm.iso;
    display_date = norm.display;
    voucher_number = `TC-${creditoMatch[4].replace(/\//g, '')}-${creditoMatch[5].replace(':', '')}-${messageId.slice(-4).toUpperCase()}`;
  } else if (giroMatch) {
    amount = parseChileanAmount(giroMatch[1]);
    instrument = 'DEBITO_CUENTA';
    card_last4 = `Cuenta ${giroMatch[2]}`;
    merchant = 'Giro en Cajero Automático';
    const norm = normalizeTransactionDate(dateHeader, giroMatch[3], giroMatch[4]);
    transaction_date = norm.iso;
    display_date = norm.display;
    voucher_number = `ATM-${giroMatch[3].replace(/\//g, '')}-${giroMatch[4].replace(':', '')}`;
  } else if (empresaMatch) {
    const empresa = empresaMatch[1].trim();
    const montoOp = findValueAfterLabel(lines, /^Monto Operaci[óo]n$/i);
    amount = parseChileanAmount(montoOp || fullText);
    flow_type = 'INGRESO';
    instrument = 'DEBITO_CUENTA';
    card_last4 = 'Cuenta Corriente 00-800-69904-01';
    transfer_subject = findValueAfterLabel(lines, /^Mensaje$/i) || subject;
    const fh = findValueAfterLabel(lines, /^Fecha y hora:?$/i);
    const norm = normalizeTransactionDate(dateHeader, fh, fh);
    transaction_date = norm.iso;
    display_date = norm.display;
    voucher_number = findValueAfterLabel(lines, /^ID de la operaci[óo]n:?$/i) || voucher_number;
    merchant = `${empresa} (${transfer_subject})`;
  } else if (tefRecibidaMatch) {
    const senderName = tefRecibidaMatch[1].trim();
    amount = parseChileanAmount(tefRecibidaMatch[2]);
    flow_type = 'INGRESO';
    instrument = 'DEBITO_CUENTA';
    card_last4 = 'Cuenta Corriente 00-800-69904-01';
    const fechaStr = findValueAfterLabel(lines, /^Fecha$/i);
    transfer_subject = findValueAfterLabel(lines, /^Mensaje$/i);
    voucher_number = findValueAfterLabel(lines, /^ID$/i) || voucher_number;
    const norm = normalizeTransactionDate(dateHeader, fechaStr, '');
    transaction_date = norm.iso;
    display_date = norm.display;
    merchant = `Transferencia de ${senderName}${transfer_subject ? ` ("${transfer_subject}")` : ''}`;
  } else if (/Pago de Tarjeta de Cr[ée]dito Nacional/i.test(subject + ' ' + fullText)) {
    const montoStr = findValueAfterLabel(lines, /^Monto$/i);
    amount = parseChileanAmount(montoStr);
    flow_type = 'EGRESO';
    instrument = 'DEBITO_CUENTA';
    card_last4 = 'Cuenta Corriente 00-800-69904-01';
    const fh = findValueAfterLabel(lines, /^Fecha y Hora:?$/i);
    const norm = normalizeTransactionDate(dateHeader, '', fh);
    transaction_date = norm.iso;
    display_date = norm.display;
    voucher_number = findValueAfterLabel(lines, /^Transacci[óo]n:?$/i) || voucher_number;
    merchant = 'Pago Tarjeta de Crédito Nacional ****4114';
  } else if (/Transferencia a terceros/i.test(subject + ' ' + fullText)) {
    const destName = findValueAfterLabel(lines, /^Nombre y Apellido$/i);
    const destBank = findValueAfterLabel(lines, /^Banco$/i);
    const montoStr = findValueAfterLabel(lines, /^Monto$/i);
    const rawMsg = findValueAfterLabel(lines, /^Mensaje$/i);
    transfer_subject = rawMsg && !/^Fecha y Hora/i.test(rawMsg) ? rawMsg : '';
    amount = parseChileanAmount(montoStr);
    flow_type = 'EGRESO';
    instrument = 'DEBITO_CUENTA';
    card_last4 = 'Cuenta Corriente 00-800-69904-01';
    destination_bank = destBank;
    const fh = findValueAfterLabel(lines, /^Fecha y Hora:?$/i);
    const norm = normalizeTransactionDate(dateHeader, '', fh);
    transaction_date = norm.iso;
    display_date = norm.display;
    voucher_number = findValueAfterLabel(lines, /^Transacci[óo]n:?$/i) || voucher_number;
    merchant = `Transferencia a ${destName || 'Tercero'}${destBank ? ` (${destBank})` : ''}${
      transfer_subject ? ` · "${transfer_subject}"` : ''
    }`;
  } else {
    // Aviso de transferencia de fondos general o simulación
    const montoStr = findValueAfterLabel(lines, /^Monto$/i) || (fullText.match(/\$\s*([\d.]+)/) || [])[0];
    amount = parseChileanAmount(montoStr);
    const fechaCorta = findValueAfterLabel(lines, /^Fecha$/i);
    const fh = findValueAfterLabel(lines, /^Fecha y Hora:?$/i);
    const norm = normalizeTransactionDate(dateHeader, fechaCorta, fh);
    transaction_date = norm.iso;
    display_date = norm.display;
    voucher_number =
      findValueAfterLabel(lines, /^N[úu]mero de comprobante$/i) ||
      findValueAfterLabel(lines, /^Transacci[óo]n:?$/i) ||
      voucher_number;

    const rawAsunto = findValueAfterLabel(lines, /^Asunto$/i);
    transfer_subject = rawAsunto && !/^Datos de destinatario$/i.test(rawAsunto) ? rawAsunto : '';
    const destBank = findValueAfterLabel(lines, /^Banco$/i);
    const destName = findValueAfterLabel(lines, /^Nombre y Apellido$/i);
    const senderMatch = fullText.match(/nuestro\(a\)\s+cliente\s+(.+?)\s+ha efectuado una transferencia/i);
    const senderName = senderMatch ? senderMatch[1].trim() : '';

    if (senderName && !/carlos felipe/i.test(senderName)) {
      flow_type = 'INGRESO';
      instrument = 'DEBITO_CUENTA';
      card_last4 = 'Cuenta Corriente 00-800-69904-01';
      merchant = `Transferencia de ${senderName}${transfer_subject ? ` ("${transfer_subject}")` : ''}`;
    } else if (/Tarjeta de Cr[ée]dito/i.test(subject + ' ' + fullText)) {
      instrument = 'CREDITO';
      card_last4 = 'Tarjeta Crédito ****4114';
      merchant = findValueAfterLabel(lines, /^Comercio$/i) || destName || 'Compra Tarjeta de Crédito';
    } else {
      instrument = 'DEBITO_CUENTA';
      merchant = findValueAfterLabel(lines, /^Comercio$/i) || destName || 'Movimiento Cuenta Banco de Chile';
    }
  }

  const baseTx = {
    gmail_message_id: messageId,
    gmail_thread_id: threadId || messageId,
    voucher_number,
    transaction_date,
    display_date,
    amount,
    currency: 'CLP',
    flow_type,
    instrument,
    card_last4,
    installments_current,
    installments_total,
    merchant,
    destination_bank,
    destination_account,
    transfer_subject,
    source,
    raw_sender: from,
    raw_subject: subject
  };

  const evaluation = evaluateTransaction(baseTx, userRules);

  return {
    ...baseTx,
    category: evaluation.category,
    necessity_level: evaluation.necessity_level,
    ai_justification: evaluation.ai_justification,
    user_overridden: evaluation.user_overridden
  };
}

module.exports = {
  OFFICIAL_BCH_DOMAINS,
  LLM_SYSTEM_PROMPT,
  isOfficialBancoChileSender,
  htmlToStructuredLines,
  parseBancoChileEmail
};
