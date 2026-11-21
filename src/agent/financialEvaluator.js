/**
 * ============================================================================
 * AGENTE DE INTELIGENCIA FINANCIERA - BANCO DE CHILE & PUENTE FINTUAL ACCIONES
 * Clasificación automática de categorías, evaluación de necesidad (Semáforo),
 * detector de recurrencia, cálculo de reserva mensual para Tarjeta de Crédito,
 * Dashboard General 360° y puente de liquidez hacia Fintual Acciones.
 * ============================================================================
 */

const LLM_SYSTEM_PROMPT = `Eres un Agente de Finanzas Personales Senior especializado en banca chilena (Banco de Chile) e integrado con un Agente de Inversiones en Fintual Acciones.
Tu tarea es analizar el contenido limpio de cada correo entrante de notificación del Banco de Chile en tiempo real y devolver ÚNICAMENTE un objeto JSON válido con la siguiente estructura:

{
  "transaction_date": "YYYY-MM-DDTHH:mm:ss-03:00",
  "display_date": "DD/MM/YYYY HH:mm",
  "amount": 5740,
  "currency": "CLP",
  "flow_type": "EGRESO" | "INGRESO",
  "instrument": "DEBITO_CUENTA" | "CREDITO",
  "card_last4": "Cuenta ****0401" | "Crédito ****4114",
  "installments_current": 1,
  "installments_total": 1,
  "merchant": "Nombre limpio del comercio o destinatario",
  "voucher_number": "Código de comprobante",
  "category": "Supermercado" | "Alimentación / Cafetería" | "Minimarket y Almacén" | "Transporte y Metro" | "Salud y Gimnasio" | "Pago Tarjeta de Crédito" | "Compras y Retail" | "Restaurantes y Fast Food" | "Suscripciones y Apps" | "Ocio y Entretenimiento" | "Transferencias" | "Cajero Automático" | "Ingresos / Abonos",
  "necessity_level": "Necesario" | "Opcional / Prescindible" | "Gasto Hormiga" | "Ingreso",
  "ai_justification": "Justificación financiera concisa de 1 sola línea (máximo 140 caracteres)."
}`;

const CHILEAN_MERCHANT_KNOWLEDGE = [
  {
    keywords: ['pago tarjeta de crédito', 'pago de tarjeta de credito'],
    category: 'Pago Tarjeta de Crédito',
    necessity: 'Necesario',
    justification: 'Pago de estado de cuenta de Tarjeta de Crédito Nacional ****4114 desde Cuenta Corriente.'
  },
  {
    keywords: ['tottus', 'hip lider', 'lider', 'líder', 'santa isabel', 'supermercado el m', 'verduleria dylam', 'jumbo', 'unimarc'],
    category: 'Supermercado',
    necessity: 'Necesario',
    justification: 'Abastecimiento esencial de alimentación y hogar en supermercado / verdulería.'
  },
  {
    keywords: ['plaza egana l4', 'las torres (macd', 'metro', 'carga bip', 'red movilidad', 'copec', 'shell'],
    category: 'Transporte y Metro',
    necessity: 'Necesario',
    justification: 'Recarga de transporte público (Metro de Santiago / Bip!) para movilidad esencial.'
  },
  {
    keywords: ['farmaceutica', 'cv 1179', 'cruz verde', 'salcobrand', 'ahumada', 'dr. simi'],
    category: 'Salud y Farmacia',
    necessity: 'Necesario',
    justification: 'Compra prioritaria de medicamentos o productos de salud en farmacia (Cruz Verde / Farmacéutica).'
  },
  {
    keywords: ['smart fit'],
    category: 'Salud y Gimnasio',
    necessity: 'Opcional / Prescindible',
    justification: 'Cargos recurrentes en Smart Fit Gimnasios; saludable pero importante auditar cobros múltiples en el ciclo.'
  },
  {
    keywords: ['servicios y comer'],
    category: 'Alimentación / Cafetería',
    necessity: 'Gasto Hormiga',
    justification: 'Gasto hormiga altamente recurrente (cafetería/casino matutino ~08:20 hrs); principal fuga acumulada del bimestre.'
  },
  {
    keywords: [
      'almacen y bazar', 'merpago*duble', 'genesis', 'merpago*andreapaz',
      'minimarket aimar', 'minimarket agusti', 'kkos kentucky', 'kioskos kentucky',
      'snackcenter', 'top market', 'fresh market', 'merpago*duandylar', 'merpago*stankopag',
      '620-san bernardo'
    ],
    category: 'Minimarket y Almacén',
    necessity: (amount) => (amount <= 12000 ? 'Gasto Hormiga' : 'Opcional / Prescindible'),
    justification: (amount, tx) =>
      `Compra rápida de bajo monto en almacén/kiosco (${tx.merchant}); su alta repetición semanal actúa como gasto hormiga.`
  },
  {
    keywords: [
      '20073-bk plaza eg', 'tb mall plaza ega', 'southern franchis', 'doc popcorn',
      'cafe australis', 'lbb costanera', 'licorera central', 'uber eats', 'pedidosya', 'mcdonalds', 'starbucks'
    ],
    category: 'Restaurantes y Fast Food',
    necessity: (amount) => (amount <= 8000 ? 'Gasto Hormiga' : 'Opcional / Prescindible'),
    justification: (amount) =>
      amount <= 8000
        ? 'Snack, fast food o consumo individual fuera de casa clasificado como gasto hormiga.'
        : 'Consumo gastronómico en restaurante, cafetería o fast food totalmente discrecional.'
  },
  {
    keywords: ['payu *uber trip', 'uber trip', 'cabify', 'didi'],
    category: 'Transporte y Metro',
    necessity: (amount) => (amount <= 7500 ? 'Gasto Hormiga' : 'Opcional / Prescindible'),
    justification: 'Traslado corto en app privada (Uber Trip); gasto hormiga evitable cuando existe alternativa en Metro.'
  },
  {
    keywords: ['google *tinder', 'google *bumble', 'google *google one', 'netflix', 'spotify', 'apple.com/bill'],
    category: 'Suscripciones y Apps',
    necessity: (amount) => (amount <= 7000 ? 'Gasto Hormiga' : 'Opcional / Prescindible'),
    justification: 'Suscripción o micro-pago digital en Google Play / App que se descuenta automáticamente.'
  },
  {
    keywords: ['cineplanet', 'cinepolis', 'cinépolis', 'cinemark'],
    category: 'Ocio y Entretenimiento',
    necessity: 'Opcional / Prescindible',
    justification: 'Entradas de cine o entretenimiento recreativo de fin de semana.'
  },
  {
    keywords: [
      'aliexpress', 'zara', 'falabella', 'fashions park', 'mall plaza sur', 'mallplaza egana',
      'merpago*viparomas', 'comercializadora cs', 'tip top metro', 'mercadolibre'
    ],
    category: 'Compras y Retail',
    necessity: (amount) => (amount <= 5000 ? 'Gasto Hormiga' : 'Opcional / Prescindible'),
    justification: 'Compra discrecional en retail, vestuario o e-commerce (AliExpress / Mall / Tienda).'
  },
  {
    keywords: ['giro en cajero'],
    category: 'Cajero Automático',
    necessity: 'Opcional / Prescindible',
    justification: 'Retiro de efectivo ($10.000) en cajero automático; el efectivo suele diluirse en gastos hormiga sin trazabilidad.'
  }
];

function evaluateTransaction(txData, userRules = []) {
  if (txData.flow_type === 'INGRESO') {
    return {
      category: txData.category || 'Ingresos / Abonos',
      necessity_level: 'Ingreso',
      ai_justification:
        txData.ai_justification ||
        'Abono de fondos en Cuenta Corriente Banco de Chile (remuneración, honorarios o transferencia recibida).',
      user_overridden: 0
    };
  }

  const merchantLower = (txData.merchant || '').toLowerCase();
  const bankLower = (txData.destination_bank || '').toLowerCase();
  const subjectLower = (txData.transfer_subject || '').toLowerCase();
  const combinedText = `${merchantLower} ${bankLower} ${subjectLower}`.trim();

  for (const rule of userRules) {
    const pattern = (rule.merchant_pattern || '').toLowerCase().trim();
    if (pattern && combinedText.includes(pattern)) {
      return {
        category: rule.assigned_category || txData.category || 'General',
        necessity_level: rule.assigned_necessity,
        ai_justification:
          rule.custom_note ||
          `Clasificado como "${rule.assigned_necessity}" según tu regla personalizada para "${rule.merchant_pattern}".`,
        user_overridden: 1
      };
    }
  }

  const amount = Number(txData.amount) || 0;
  if (/^transferencia a /i.test(txData.merchant)) {
    const isMicro = amount <= 8000;
    return {
      category: 'Transferencias',
      necessity_level: isMicro ? 'Gasto Hormiga' : 'Opcional / Prescindible',
      ai_justification: isMicro
        ? `Micro-transferencia a tercero (${txData.merchant}); pago menor en efectivo digital.`
        : `Transferencia electrónica a tercero desde Cuenta Corriente ****0401.`,
      user_overridden: 0
    };
  }

  for (const item of CHILEAN_MERCHANT_KNOWLEDGE) {
    if (item.keywords.some((kw) => combinedText.includes(kw))) {
      const necessity = typeof item.necessity === 'function' ? item.necessity(amount, txData) : item.necessity;
      const justification =
        typeof item.justification === 'function' ? item.justification(amount, txData) : item.justification;
      return {
        category: item.category,
        necessity_level: necessity,
        ai_justification: justification,
        user_overridden: 0
      };
    }
  }

  const isAnt = amount <= 7500;
  return {
    category: txData.category || 'Compras y Retail',
    necessity_level: isAnt ? 'Gasto Hormiga' : 'Opcional / Prescindible',
    ai_justification: isAnt
      ? `Micro-cargo por $${amount.toLocaleString('es-CL')} en ${txData.merchant} detectado como gasto hormiga.`
      : `Gasto discrecional en ${txData.merchant}.`,
    user_overridden: 0
  };
}

function getMerchantGroupKey(merchant = '') {
  const u = merchant.toUpperCase();
  if (u.includes('SERVICIOS Y COMER')) return 'SERVICIOS Y COMER';
  if (u.includes('TOTTUS')) return 'SUPERMERCADOS TOTTUS';
  if (u.includes('HIP LIDER') || u.includes('LIDER')) return 'SUPERMERCADOS LÍDER';
  if (u.includes('SMART FIT')) return 'SMART FIT GIMNASIOS';
  if (u.includes('PLAZA EGANA L4') || u.includes('LAS TORRES (MACD')) return 'METRO DE SANTIAGO (Carga Bip!)';
  if (u.includes('ALMACEN Y BAZAR')) return 'ALMACÉN Y BAZAR';
  if (u.includes('MERPAGO*DUBLE')) return 'MERPAGO*DUBLE';
  if (u.includes('GENESIS')) return 'ALMACÉN GÉNESIS';
  if (u.includes('MERPAGO*ANDREAPAZ')) return 'MERPAGO*ANDREAPAZ';
  if (u.includes('MINIMARKET AIMAR')) return 'MINIMARKET AIMAR';
  if (u.includes('KENTUCKY')) return 'KIOSCOS KENTUCKY';
  if (u.includes('UBER TRIP')) return 'UBER TRIP';
  if (u.includes('FARMACEUTICA') || u.includes('CV 1179')) return 'FARMACIAS (Cruz Verde / Farmacéutica)';
  if (u.includes('MINIMARKET AGUSTI')) return 'MINIMARKET AGUSTI';
  if (u.includes('SNACKCENTER')) return 'SNACKCENTER';
  if (u.includes('PAGO TARJETA DE CRÉDITO')) return 'PAGO TARJETA DE CRÉDITO ****4114';
  if (u.includes('GIRO EN CAJERO')) return 'GIRO EN CAJERO AUTOMÁTICO';
  return merchant;
}

function getTxMonthKey(tx) {
  if (tx.display_date && tx.display_date.includes('/')) {
    const parts = tx.display_date.split(' ')[0].split('/');
    if (parts.length === 3) return `${parts[2]}-${parts[1]}`;
  }
  return (tx.transaction_date || '').slice(0, 7);
}

/**
 * Calcula cuánto reservar por mes para pagar la Tarjeta de Crédito ****4114
 */
function buildCreditCardMonthlyReservation(allTransactions) {
  const creditTxs = allTransactions.filter((t) => t.instrument === 'CREDITO' && t.flow_type === 'EGRESO');

  const novTxs = creditTxs.filter((t) => getTxMonthKey(t) === '2026-11');
  const octTxs = creditTxs.filter((t) => getTxMonthKey(t) === '2026-10');
  const sepTxs = creditTxs.filter((t) => getTxMonthKey(t) === '2026-09');

  const novCompras = novTxs.reduce((s, t) => s + t.amount, 0);
  const octCompras = octTxs.reduce((s, t) => s + t.amount, 0);
  const sepCompras = sepTxs.reduce((s, t) => s + t.amount, 0);

  const remanentePostPagoOct = 37207;
  const totalReservarNoviembre = novCompras + remanentePostPagoOct;

  return {
    currentCycle: {
      monthKey: '2026-11',
      monthLabel: 'Noviembre 2026 (Ciclo Actual)',
      purchasesThisMonth: novCompras,
      purchasesCount: novTxs.length,
      carryOverFromLastCut: remanentePostPagoOct,
      totalToReserve: totalReservarNoviembre,
      billingCutDate: '~22 al 24 de Noviembre 2026',
      suggestedPayDate: '30 de Noviembre 2026 (junto con abono REM)'
    },
    months: [
      {
        monthKey: '2026-11',
        label: 'Noviembre 2026',
        subLabel: 'Ciclo en Curso · Por Facturar (~23 Nov)',
        status: 'POR_PAGAR',
        statusBadge: '⏳ Reservar para Fin de Mes',
        purchasesAmount: novCompras,
        purchasesCount: novTxs.length,
        carryOverAmount: remanentePostPagoOct,
        billedOrToReserve: totalReservarNoviembre,
        note: `$${novCompras.toLocaleString('es-CL')} en compras de Noviembre + $${remanentePostPagoOct.toLocaleString('es-CL')} remanente tras el pago del 30/10.`
      },
      {
        monthKey: '2026-10',
        label: 'Octubre 2026',
        subLabel: 'Facturado el 24/10 · Pagado el 30/10',
        status: 'PAGADO',
        statusBadge: '✅ Pagado ($157.756 el 30/10)',
        purchasesAmount: octCompras,
        purchasesCount: octTxs.length,
        carryOverAmount: 0,
        billedOrToReserve: 157756,
        utilizedAtPayment: 194963,
        note: `Pagaste $157.756 el 30/10 (de $194.963 utilizados). Las compras hechas entre el 23/10 y 30/10 pasaron al ciclo siguiente.`
      },
      {
        monthKey: '2026-09',
        label: 'Septiembre 2026',
        subLabel: 'Facturado el 22/09 · Pagado el 24/09',
        status: 'PAGADO',
        statusBadge: '✅ Pagado ($69.787 el 24/09)',
        purchasesAmount: sepCompras,
        purchasesCount: sepTxs.length,
        carryOverAmount: 0,
        billedOrToReserve: 69787,
        note: `Estado de cuenta cerrado el 22/09 y pagado íntegramente el 24/09 ($69.787 CLP).`
      }
    ]
  };
}

function generateFinancialAudit(transactions, instrument) {
  const filtered = transactions.filter((t) => t.instrument === instrument);
  const ingresos = filtered.filter((t) => t.flow_type === 'INGRESO');
  const egresos = filtered.filter((t) => t.flow_type === 'EGRESO');

  const totalIngresos = ingresos.reduce((acc, t) => acc + t.amount, 0);
  const totalEgresos = egresos.reduce((acc, t) => acc + t.amount, 0);
  const totalTransferencias = egresos
    .filter((t) => t.category.includes('Transferencia') || t.category.includes('Pago Tarjeta'))
    .reduce((acc, t) => acc + t.amount, 0);
  const totalComprasDebito = totalEgresos - totalTransferencias;

  const necesarioList = egresos.filter((t) => t.necessity_level === 'Necesario');
  const opcionalList = egresos.filter((t) => t.necessity_level === 'Opcional / Prescindible');
  const hormigaList = egresos.filter((t) => t.necessity_level === 'Gasto Hormiga');

  const montoNecesario = necesarioList.reduce((a, t) => a + t.amount, 0);
  const montoOpcional = opcionalList.reduce((a, t) => a + t.amount, 0);
  const montoHormiga = hormigaList.reduce((a, t) => a + t.amount, 0);
  const montoNoEsencial = montoOpcional + montoHormiga;

  const pctNecesario = totalEgresos > 0 ? Math.round((montoNecesario / totalEgresos) * 100) : 0;
  const pctOpcional = totalEgresos > 0 ? Math.round((montoOpcional / totalEgresos) * 100) : 0;
  const pctHormiga = totalEgresos > 0 ? Math.max(0, 100 - pctNecesario - pctOpcional) : 0;
  const pctNoEsencial = pctOpcional + pctHormiga;

  const categoryMap = {};
  for (const t of egresos) {
    if (!categoryMap[t.category]) {
      categoryMap[t.category] = { category: t.category, amount: 0, count: 0 };
    }
    categoryMap[t.category].amount += t.amount;
    categoryMap[t.category].count += 1;
  }
  const topCategories = Object.values(categoryMap)
    .sort((a, b) => b.amount - a.amount)
    .map((c) => ({
      ...c,
      percentage: totalEgresos > 0 ? Math.round((c.amount / totalEgresos) * 100) : 0
    }));

  const merchantMap = {};
  for (const t of egresos) {
    const key = getMerchantGroupKey(t.merchant);
    if (!merchantMap[key]) {
      merchantMap[key] = {
        merchant: key,
        category: t.category,
        necessity_level: t.necessity_level,
        amount: 0,
        count: 0
      };
    }
    merchantMap[key].amount += t.amount;
    merchantMap[key].count += 1;
  }

  const topMerchants = Object.values(merchantMap)
    .sort((a, b) => b.amount - a.amount)
    .map((m) => ({
      ...m,
      avgTicket: Math.round(m.amount / m.count),
      percentage: totalEgresos > 0 ? Math.round((m.amount / totalEgresos) * 100) : 0
    }));

  const recurringMerchants = Object.values(merchantMap)
    .filter((m) => m.count >= 2)
    .sort((a, b) => b.count - a.count || b.amount - a.amount)
    .map((m) => ({
      ...m,
      avgTicket: Math.round(m.amount / m.count),
      percentage: totalEgresos > 0 ? Math.round((m.amount / totalEgresos) * 100) : 0
    }));

  const nonEssentialCatMap = {};
  for (const t of [...opcionalList, ...hormigaList]) {
    nonEssentialCatMap[t.category] = (nonEssentialCatMap[t.category] || 0) + t.amount;
  }
  const topNonEssentialCats = Object.entries(nonEssentialCatMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);

  const ahorroMitad = Math.round(montoNoEsencial / 2);
  const ahorroMensual = Math.round(ahorroMitad / 2);
  const ahorroAnual = ahorroMensual * 12;
  const fmtCLP = (n) => '$' + Math.round(n).toLocaleString('es-CL');

  const topRecurringAnt = recurringMerchants.find((m) => m.necessity_level === 'Gasto Hormiga') || recurringMerchants[0];
  const labelInstrumento =
    instrument === 'CREDITO'
      ? 'tu Tarjeta de Crédito ****4114'
      : 'tu Cuenta Corriente / Débito ****0401';

  let agentSeverity = pctNoEsencial >= 50 ? 'warning' : 'healthy';
  if (pctNoEsencial >= 65) agentSeverity = 'critical';

  const focusCats = topNonEssentialCats.length > 0 ? topNonEssentialCats.join(' y ') : 'consumos discrecionales';
  const recHighlight = topRecurringAnt
    ? ` Destaca el patrón recurrente en "${topRecurringAnt.merchant}" con ${topRecurringAnt.count} cargos que suman ${fmtCLP(topRecurringAnt.amount)} CLP (ticket promedio ${fmtCLP(topRecurringAnt.avgTicket)}).`
    : '';

  const agentAlertTitle = `Auditoría En Vivo: ${pctNoEsencial}% en gastos no esenciales`;
  const agentAlertBody = `En el período monitoreado el ${pctNoEsencial}% de ${labelInstrumento} (${fmtCLP(montoNoEsencial)} CLP en ${opcionalList.length + hormigaList.length} cargos) se ha ido en ${focusCats} (${pctOpcional}% Opcional y ${pctHormiga}% Gasto Hormiga).${recHighlight} Reducir estos gastos no esenciales a la mitad te ahorraría ${fmtCLP(ahorroMitad)} CLP por bimestre (${fmtCLP(ahorroAnual)} CLP al año).`;

  const monthlyBilling = instrument === 'CREDITO' ? buildCreditCardMonthlyReservation(transactions) : null;

  return {
    instrument,
    kpis: {
      saldoNetoMes: totalIngresos - totalEgresos,
      totalIngresos,
      totalEgresos,
      totalTransferencias,
      totalComprasDebito,
      cantidadMovimientos: filtered.length,
      cantidadCompras: egresos.length,
      recurrentesCount: recurringMerchants.length,
      proyeccionFacturacion: monthlyBilling ? monthlyBilling.currentCycle.totalToReserve : Math.round(totalEgresos / 2),
      comprasNoviembreCredito: monthlyBilling ? monthlyBilling.currentCycle.purchasesThisMonth : 0
    },
    monthlyBilling,
    semaphore: {
      necesario: { amount: montoNecesario, percentage: pctNecesario, count: necesarioList.length },
      opcional: { amount: montoOpcional, percentage: pctOpcional, count: opcionalList.length },
      hormiga: { amount: montoHormiga, percentage: pctHormiga, count: hormigaList.length },
      noEsencialTotal: {
        amount: montoNoEsencial,
        percentage: pctNoEsencial,
        potentialMonthlySavings: ahorroMitad,
        potentialAnnualSavings: ahorroAnual
      }
    },
    topCategories,
    topMerchants,
    recurringMerchants,
    agentAlert: {
      severity: agentSeverity,
      title: agentAlertTitle,
      message: agentAlertBody,
      potentialMonthlySavings: ahorroMitad,
      potentialAnnualSavings: ahorroAnual
    }
  };
}

/**
 * Genera la Auditoría Consolidada 360° para la Viñeta "Dashboard General Interactivo"
 * Unifica Cuenta Corriente / Débito ****0401 + Tarjeta de Crédito ****4114
 * (Excluyendo los pagos internos de tarjeta de crédito desde la cuenta corriente para no duplicar gastos)
 */
function generateGlobalDashboardAudit(transactions) {
  const ingresos = transactions.filter((t) => t.flow_type === 'INGRESO');
  const allEgresos = transactions.filter((t) => t.flow_type === 'EGRESO');

  // Excluir el pago interno de la tarjeta de crédito para calcular el consumo real consolidado
  const consumoRealEgresos = allEgresos.filter((t) => !t.category.includes('Pago Tarjeta'));
  const pagosTarjetaInternos = allEgresos.filter((t) => t.category.includes('Pago Tarjeta'));

  const totalIngresos = ingresos.reduce((s, t) => s + t.amount, 0);
  const totalEgresosDebitoBruto = allEgresos
    .filter((t) => t.instrument === 'DEBITO_CUENTA')
    .reduce((s, t) => s + t.amount, 0);
  const totalConsumoDebito = consumoRealEgresos
    .filter((t) => t.instrument === 'DEBITO_CUENTA')
    .reduce((s, t) => s + t.amount, 0);
  const totalConsumoCredito = consumoRealEgresos
    .filter((t) => t.instrument === 'CREDITO')
    .reduce((s, t) => s + t.amount, 0);
  const totalConsumoRealConsolidado = totalConsumoDebito + totalConsumoCredito;
  const totalPagosTarjeta = pagosTarjetaInternos.reduce((s, t) => s + t.amount, 0);

  const balanceCuentaCorriente = totalIngresos - totalEgresosDebitoBruto;
  const creditBilling = buildCreditCardMonthlyReservation(transactions);
  const reservaTarjetaNoviembre = creditBilling.currentCycle.totalToReserve;
  const liquidezLibrePostReservaTC = balanceCuentaCorriente - reservaTarjetaNoviembre;
  const colchonSeguridad = 150000;
  const capitalDisponibleFintual = Math.max(0, liquidezLibrePostReservaTC - colchonSeguridad);

  // Semáforo Global sobre consumo real (Débito + Crédito)
  const necList = consumoRealEgresos.filter((t) => t.necessity_level === 'Necesario');
  const opcList = consumoRealEgresos.filter((t) => t.necessity_level === 'Opcional / Prescindible');
  const horList = consumoRealEgresos.filter((t) => t.necessity_level === 'Gasto Hormiga');

  const mNec = necList.reduce((s, t) => s + t.amount, 0);
  const mOpc = opcList.reduce((s, t) => s + t.amount, 0);
  const mHor = horList.reduce((s, t) => s + t.amount, 0);
  const mNoEs = mOpc + mHor;

  const pNec = totalConsumoRealConsolidado > 0 ? Math.round((mNec / totalConsumoRealConsolidado) * 100) : 0;
  const pOpc = totalConsumoRealConsolidado > 0 ? Math.round((mOpc / totalConsumoRealConsolidado) * 100) : 0;
  const pHor = totalConsumoRealConsolidado > 0 ? Math.max(0, 100 - pNec - pOpc) : 0;

  // Comparativa Mes a Mes (Septiembre vs Octubre vs Noviembre)
  const monthDefs = [
    { key: '2026-09', label: 'Septiembre 2026', short: 'Sep 26' },
    { key: '2026-10', label: 'Octubre 2026', short: 'Oct 26' },
    { key: '2026-11', label: 'Noviembre 2026 (Actual)', short: 'Nov 26' }
  ];

  const monthlyComparison = monthDefs.map((m) => {
    const mTxs = transactions.filter((t) => getTxMonthKey(t) === m.key);
    const mIng = mTxs.filter((t) => t.flow_type === 'INGRESO').reduce((s, t) => s + t.amount, 0);
    const mDeb = mTxs
      .filter((t) => t.flow_type === 'EGRESO' && t.instrument === 'DEBITO_CUENTA' && !t.category.includes('Pago Tarjeta'))
      .reduce((s, t) => s + t.amount, 0);
    const mCred = mTxs
      .filter((t) => t.flow_type === 'EGRESO' && t.instrument === 'CREDITO')
      .reduce((s, t) => s + t.amount, 0);
    const mPagoTC = mTxs
      .filter((t) => t.category.includes('Pago Tarjeta'))
      .reduce((s, t) => s + t.amount, 0);
    const mHorMes = mTxs
      .filter((t) => t.flow_type === 'EGRESO' && t.necessity_level === 'Gasto Hormiga')
      .reduce((s, t) => s + t.amount, 0);

    return {
      ...m,
      ingresos: mIng,
      consumoDebito: mDeb,
      consumoCredito: mCred,
      consumoTotal: mDeb + mCred,
      pagoTarjetaCredito: mPagoTC,
      gastoHormiga: mHorMes,
      txCount: mTxs.length
    };
  });

  // Top Categorías Globales
  const catMap = {};
  for (const t of consumoRealEgresos) {
    if (!catMap[t.category]) catMap[t.category] = { category: t.category, amount: 0, count: 0 };
    catMap[t.category].amount += t.amount;
    catMap[t.category].count += 1;
  }
  const topCategories = Object.values(catMap)
    .sort((a, b) => b.amount - a.amount)
    .map((c) => ({
      ...c,
      percentage: totalConsumoRealConsolidado > 0 ? Math.round((c.amount / totalConsumoRealConsolidado) * 100) : 0
    }));

  // Top Recurrencia Global (Débito + Crédito)
  const merMap = {};
  for (const t of consumoRealEgresos) {
    const k = getMerchantGroupKey(t.merchant);
    if (!merMap[k]) {
      merMap[k] = {
        merchant: k,
        category: t.category,
        necessity_level: t.necessity_level,
        instrument: t.instrument,
        amount: 0,
        count: 0
      };
    }
    merMap[k].amount += t.amount;
    merMap[k].count += 1;
  }

  const recurringMerchants = Object.values(merMap)
    .filter((m) => m.count >= 2)
    .sort((a, b) => b.count - a.count || b.amount - a.amount)
    .map((m) => ({
      ...m,
      avgTicket: Math.round(m.amount / m.count),
      percentage: totalConsumoRealConsolidado > 0 ? Math.round((m.amount / totalConsumoRealConsolidado) * 100) : 0
    }));

  const topMerchants = Object.values(merMap)
    .sort((a, b) => b.amount - a.amount)
    .map((m) => ({
      ...m,
      avgTicket: Math.round(m.amount / m.count),
      percentage: totalConsumoRealConsolidado > 0 ? Math.round((m.amount / totalConsumoRealConsolidado) * 100) : 0
    }));

  const ahorroMitadGlobal = Math.round(mNoEs / 2);

  return {
    kpis: {
      totalIngresos,
      totalConsumoRealConsolidado,
      totalConsumoDebito,
      totalConsumoCredito,
      totalPagosTarjeta,
      balanceCuentaCorriente,
      reservaTarjetaNoviembre,
      liquidezLibrePostReservaTC,
      colchonSeguridad,
      capitalDisponibleFintual,
      totalMovimientos: transactions.length
    },
    semaphore: {
      necesario: { amount: mNec, percentage: pNec, count: necList.length },
      opcional: { amount: mOpc, percentage: pOpc, count: opcList.length },
      hormiga: { amount: mHor, percentage: pHor, count: horList.length },
      noEsencialTotal: {
        amount: mNoEs,
        percentage: pOpc + pHor,
        potentialBimonthlySavings: ahorroMitadGlobal,
        potentialMonthlySavings: Math.round(ahorroMitadGlobal / 2),
        potentialAnnualSavings: Math.round(ahorroMitadGlobal / 2) * 12
      }
    },
    monthlyComparison,
    topCategories,
    topMerchants,
    recurringMerchants
  };
}

/**
 * Construye el estado del Hub de Fintual Acciones & Puente con el Segundo Agente de Inversiones
 */
function buildFintualIntegrationOverview(transactions, positions = [], signals = []) {
  const globalAudit = generateGlobalDashboardAudit(transactions);
  const usdRate = 970; // Tipo de cambio referencial Dólar Fintual Acciones (CLP/USD)

  const enrichedPositions = positions.map((p) => {
    const costBasisUsd = Number((p.shares * p.avg_buy_price_usd).toFixed(2));
    const marketValueUsd = Number((p.shares * p.current_price_usd).toFixed(2));
    const marketValueClp = Math.round(marketValueUsd * usdRate);
    const pnlUsd = Number((marketValueUsd - costBasisUsd).toFixed(2));
    const pnlClp = Math.round(pnlUsd * usdRate);
    const pnlPct = costBasisUsd > 0 ? Number(((pnlUsd / costBasisUsd) * 100).toFixed(2)) : 0;

    return {
      ...p,
      costBasisUsd,
      marketValueUsd,
      marketValueClp,
      pnlUsd,
      pnlClp,
      pnlPct
    };
  });

  const totalPortfolioUsd = Number(
    enrichedPositions.reduce((s, p) => s + p.marketValueUsd, 0).toFixed(2)
  );
  const totalCostUsd = Number(
    enrichedPositions.reduce((s, p) => s + p.costBasisUsd, 0).toFixed(2)
  );
  const totalPortfolioClp = Math.round(totalPortfolioUsd * usdRate);
  const totalPnlUsd = Number((totalPortfolioUsd - totalCostUsd).toFixed(2));
  const totalPnlClp = Math.round(totalPnlUsd * usdRate);
  const totalPnlPct = totalCostUsd > 0 ? Number(((totalPnlUsd / totalCostUsd) * 100).toFixed(2)) : 0;

  const positionsWithActualWeight = enrichedPositions.map((p) => ({
    ...p,
    actualWeightPct: totalPortfolioUsd > 0 ? Math.round((p.marketValueUsd / totalPortfolioUsd) * 100) : 0
  }));

  const capitalInmediatoClp = globalAudit.kpis.capitalDisponibleFintual;
  const capitalInmediatoUsd = Number((capitalInmediatoClp / usdRate).toFixed(2));
  const ahorroHormigaMensualClp = globalAudit.semaphore.noEsencialTotal.potentialMonthlySavings;
  const ahorroHormigaMensualUsd = Number((ahorroHormigaMensualClp / usdRate).toFixed(2));

  return {
    usdRate,
    contractStatus: 'ACTIVO · Enrutamiento de Órdenes Fintual Acciones (DriveWealth / NYSE & NASDAQ)',
    portfolioSummary: {
      totalPortfolioUsd,
      totalPortfolioClp,
      totalCostUsd,
      totalPnlUsd,
      totalPnlClp,
      totalPnlPct,
      positionsCount: enrichedPositions.length
    },
    liquidityBridge: {
      balanceCuentaCorrienteClp: globalAudit.kpis.balanceCuentaCorriente,
      reservaTarjetaCreditoNovClp: globalAudit.kpis.reservaTarjetaNoviembre,
      liquidezPostTarjetaClp: globalAudit.kpis.liquidezLibrePostReservaTC,
      colchonSeguridadClp: globalAudit.kpis.colchonSeguridad,
      capitalDisponibleInvertirHoyClp: capitalInmediatoClp,
      capitalDisponibleInvertirHoyUsd: capitalInmediatoUsd,
      potencialAhorroNoEsencialMensualClp: ahorroHormigaMensualClp,
      potencialAhorroNoEsencialMensualUsd: ahorroHormigaMensualUsd
    },
    positions: positionsWithActualWeight,
    signals,
    multiAgentApiSpec: {
      contextEndpoint: 'GET /api/fintual/context',
      signalWebhookEndpoint: 'POST /api/fintual/agent-signal',
      positionUpdateEndpoint: 'POST /api/fintual/positions',
      samplePayload: {
        agent_id: 'fintual-invest-agent-v1',
        action_type: 'BUY',
        ticker: 'VOO',
        suggested_amount_clp: 100000,
        confidence_pct: 91,
        reasoning: 'Compra escalonada S&P 500 usando excedente libre post-reserva de Tarjeta de Crédito.'
      }
    }
  };
}

module.exports = {
  LLM_SYSTEM_PROMPT,
  evaluateTransaction,
  getMerchantGroupKey,
  buildCreditCardMonthlyReservation,
  generateFinancialAudit,
  generateGlobalDashboardAudit,
  buildFintualIntegrationOverview
};
