/**
 * ============================================================================
 * MOTOR 24/7 BLINDADO EN LA NUBE (GOOGLE APPS SCRIPT) - BCH FINANZAS IA
 * Incluye Autenticación por Token Secreto (API_SECRET_TOKEN) y Sanitización
 * de Datos Personales (Zero-PII: sin RUTs, sin números de cuenta completos).
 * ============================================================================
 */

// 1. CAMBIA ESTA CLAVE POR UN PIN O CONTRASEÑA SECRETA QUE SOLO TÚ CONOZCAS:
const API_SECRET_TOKEN = 'BCH-2026-CLAVE-SECRETA';

const GMAIL_QUERY = 'newer_than:60d (from:enviodigital@bancochile.cl OR from:serviciodetransferencias@bancochile.cl) -subject:Cartola -subject:"Estado de Cuenta"';

function doGet(e) {
  const providedToken = (e && e.parameter && e.parameter.token) || '';

  // Verificación estricta de seguridad: rechazar cualquier petición sin el Token Secreto
  if (!providedToken || providedToken !== API_SECRET_TOKEN) {
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: false,
        error: '401 Unauthorized: Token de seguridad inválido o ausente.'
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const transactions = syncBancoChileEmails();
  return ContentService
    .createTextOutput(JSON.stringify({
      ok: true,
      syncedAt: new Date().toISOString(),
      count: transactions.length,
      transactions: transactions
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function instalarTriggerAutomatico24x7() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncBancoChileEmails') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('syncBancoChileEmails')
    .timeBased()
    .everyMinutes(5)
    .create();
  syncBancoChileEmails();
}

function syncBancoChileEmails() {
  const threads = GmailApp.search(GMAIL_QUERY, 0, 100);
  const results = [];

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      const msg = messages[j];
      const parsed = parseBchMessage(msg);
      if (parsed) {
        results.push(parsed);
      }
    }
  }

  results.sort(function(a, b) {
    return b.transaction_date.localeCompare(a.transaction_date);
  });

  return results;
}

function parseBchMessage(msg) {
  const subject = msg.getSubject() || '';
  const from = msg.getFrom() || '';
  if (/comunicaciones\.bancochile\.cl/i.test(from)) return null;
  if (/Cartola|Estado de Cuenta/i.test(subject)) return null;

  const id = msg.getId();
  const dateObj = msg.getDate();
  const plain = (msg.getPlainBody() || msg.getBody().replace(/<[^>]+>/g, ' '))
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (/Comprobante de Pago/i.test(subject) && /Tarjeta de Cr[ée]dito/i.test(plain)) {
    return null;
  }

  let amount = 0;
  let flow_type = 'EGRESO';
  let instrument = 'DEBITO_CUENTA';
  let card_last4 = 'Cuenta ****0401';
  let merchant = 'Comercio Banco de Chile';
  let display_date = Utilities.formatDate(dateObj, 'America/Santiago', 'dd/MM/yyyy HH:mm');
  let transaction_date = Utilities.formatDate(dateObj, 'America/Santiago', "yyyy-MM-dd'T'HH:mm:ss'-03:00'");

  const cargoMatch = plain.match(/compra por \$([\d.]+)\s+con cargo a Cuenta\s+(\*{3,4}\d{4})\s+en\s+(.+?)\s+el\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/i);
  const creditoMatch = plain.match(/compra por \$([\d.]+)\s+con Tarjeta de Cr[ée]dito\s+(\*{3,4}\d{4})\s+en\s+(.+?)\s+el\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/i);
  const giroMatch = plain.match(/giro en Cajero por \$([\d.]+)\s+con cargo a Cuenta\s+(\*{3,4}\d{4})\s+el\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/i);
  const empresaMatch = plain.match(/Te informamos que\s+(.+?)\s+ha instruido la siguiente transferencia/i);
  const tefRecibidaMatch = plain.match(/Le informamos que\s+(.+?)\s+le ha transferido\s+\$([\d.]+)/i);

  if (cargoMatch) {
    amount = parseInt(cargoMatch[1].replace(/\./g, ''), 10);
    instrument = 'DEBITO_CUENTA';
    card_last4 = 'Cuenta ' + cargoMatch[2];
    merchant = cargoMatch[3].trim();
    display_date = cargoMatch[4] + ' ' + cargoMatch[5];
  } else if (creditoMatch) {
    amount = parseInt(creditoMatch[1].replace(/\./g, ''), 10);
    instrument = 'CREDITO';
    card_last4 = 'Tarjeta Crédito ' + creditoMatch[2];
    merchant = creditoMatch[3].trim();
    display_date = creditoMatch[4] + ' ' + creditoMatch[5];
  } else if (giroMatch) {
    amount = parseInt(giroMatch[1].replace(/\./g, ''), 10);
    instrument = 'DEBITO_CUENTA';
    card_last4 = 'Cuenta ' + giroMatch[2];
    merchant = 'Giro en Cajero Automático';
    display_date = giroMatch[3] + ' ' + giroMatch[4];
  } else if (empresaMatch) {
    const mMonto = plain.match(/Monto Operaci[óo]n\s*\$([\d.]+)/i) || plain.match(/\$([\d.]+)/);
    amount = mMonto ? parseInt(mMonto[1].replace(/\./g, ''), 10) : 0;
    flow_type = 'INGRESO';
    // Sanitizar razón social por privacidad
    merchant = /REM/i.test(subject) ? 'Abono Remuneración Mensual' : 'Abono Honorarios (BH)';
  } else if (tefRecibidaMatch) {
    amount = parseInt(tefRecibidaMatch[2].replace(/\./g, ''), 10);
    flow_type = 'INGRESO';
    merchant = 'Transferencia Recibida en Cuenta';
  } else if (/Pago de Tarjeta de Cr[ée]dito Nacional/i.test(subject)) {
    const mMonto = plain.match(/Monto\s*\$([\d.]+)/i);
    amount = mMonto ? parseInt(mMonto[1].replace(/\./g, ''), 10) : 0;
    merchant = 'Pago Tarjeta de Crédito Nacional ****4114';
  } else if (/Transferencia a terceros/i.test(subject)) {
    const mMonto = plain.match(/Monto\s*\$([\d.]+)/i);
    const mBanco = plain.match(/Banco\s+([A-Za-zÁÉÍÓÚÑáéíóúñ ]+?)\s+Email/i);
    amount = mMonto ? parseInt(mMonto[1].replace(/\./g, ''), 10) : 0;
    merchant = 'Transferencia a Tercero' + (mBanco ? ' (' + mBanco[1].trim() + ')' : '');
  } else {
    const mMonto = plain.match(/Monto\s*\$([\d.]+)/i);
    if (!mMonto) return null;
    amount = parseInt(mMonto[1].replace(/\./g, ''), 10);
    if (/transferencia de fondos a tu cuenta/i.test(plain)) {
      flow_type = 'INGRESO';
      merchant = 'Transferencia Recibida en Cuenta';
    }
  }

  if (!amount) return null;
  const ev = classifyTx(merchant, amount, flow_type);

  return {
    id: id,
    gmail_message_id: id,
    transaction_date: transaction_date,
    display_date: display_date,
    amount: amount,
    flow_type: flow_type,
    instrument: instrument,
    card_last4: card_last4,
    merchant: merchant,
    category: ev.category,
    necessity_level: ev.necessity_level,
    ai_justification: ev.ai_justification,
    source: 'GMAIL_REAL'
  };
}

function classifyTx(merchant, amount, flowType) {
  if (flowType === 'INGRESO') {
    return { category: 'Ingresos / Abonos', necessity_level: 'Ingreso', ai_justification: 'Abono verificado en Cuenta Corriente ****0401.' };
  }
  const u = merchant.toUpperCase();
  if (u.indexOf('PAGO TARJETA') !== -1) return { category: 'Pago Tarjeta de Crédito', necessity_level: 'Necesario', ai_justification: 'Pago estado de cuenta Tarjeta ****4114.' };
  if (u.indexOf('TOTTUS') !== -1 || u.indexOf('LIDER') !== -1 || u.indexOf('SANTA ISABEL') !== -1 || u.indexOf('SUPERMERCADO') !== -1 || u.indexOf('VERDULERIA') !== -1) {
    return { category: 'Supermercado', necessity_level: 'Necesario', ai_justification: 'Abastecimiento esencial en supermercado.' };
  }
  if (u.indexOf('PLAZA EGANA L4') !== -1 || u.indexOf('LAS TORRES') !== -1) {
    return { category: 'Transporte y Metro', necessity_level: 'Necesario', ai_justification: 'Recarga transporte público Metro Bip!.' };
  }
  if (u.indexOf('FARMACEUTICA') !== -1 || u.indexOf('CV 1179') !== -1) {
    return { category: 'Salud y Farmacia', necessity_level: 'Necesario', ai_justification: 'Gasto prioritario de salud / farmacia.' };
  }
  if (u.indexOf('SMART FIT') !== -1) {
    return { category: 'Salud y Gimnasio', necessity_level: 'Opcional / Prescindible', ai_justification: 'Cargo recurrente gimnasio Smart Fit.' };
  }
  if (u.indexOf('SERVICIOS Y COMER') !== -1) {
    return { category: 'Alimentación / Cafetería', necessity_level: 'Gasto Hormiga', ai_justification: 'Gasto hormiga matutino altamente recurrente.' };
  }
  const isAnt = amount <= 8000;
  return {
    category: isAnt ? 'Minimarket y Almacén' : 'Compras y Retail',
    necessity_level: isAnt ? 'Gasto Hormiga' : 'Opcional / Prescindible',
    ai_justification: isAnt ? 'Micro-gasto detectado como gasto hormiga.' : 'Gasto discrecional.'
  };
}
