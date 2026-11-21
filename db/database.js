/**
 * ============================================================================
 * CAPA DE PERSISTENCIA SQLITE (node:sqlite DatabaseSync)
 * Gestiona transacciones deduplicadas por gmail_message_id, reglas de usuario,
 * logs de sincronización continua y el módulo multi-agente de Fintual Acciones.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { evaluateTransaction } = require('../src/agent/financialEvaluator');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'finanzas.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const insertTxStmt = db.prepare(`
  INSERT OR IGNORE INTO transactions (
    gmail_message_id, gmail_thread_id, voucher_number, transaction_date, display_date,
    amount, currency, flow_type, instrument, card_last4, installments_current, installments_total,
    merchant, destination_bank, destination_account, transfer_subject,
    category, necessity_level, ai_justification, user_overridden, source, raw_sender, raw_subject
  ) VALUES (
    :gmail_message_id, :gmail_thread_id, :voucher_number, :transaction_date, :display_date,
    :amount, :currency, :flow_type, :instrument, :card_last4, :installments_current, :installments_total,
    :merchant, :destination_bank, :destination_account, :transfer_subject,
    :category, :necessity_level, :ai_justification, :user_overridden, :source, :raw_sender, :raw_subject
  )
`);

function insertTransactionIfNew(tx) {
  const result = insertTxStmt.run({
    gmail_message_id: tx.gmail_message_id,
    gmail_thread_id: tx.gmail_thread_id || tx.gmail_message_id,
    voucher_number: tx.voucher_number || null,
    transaction_date: tx.transaction_date,
    display_date: tx.display_date,
    amount: Math.round(Number(tx.amount) || 0),
    currency: tx.currency || 'CLP',
    flow_type: tx.flow_type || 'EGRESO',
    instrument: tx.instrument || 'DEBITO_CUENTA',
    card_last4: tx.card_last4 || 'Cuenta ****0401',
    installments_current: tx.installments_current || 1,
    installments_total: tx.installments_total || 1,
    merchant: tx.merchant,
    destination_bank: tx.destination_bank || null,
    destination_account: tx.destination_account || null,
    transfer_subject: tx.transfer_subject || null,
    category: tx.category,
    necessity_level: tx.necessity_level,
    ai_justification: tx.ai_justification,
    user_overridden: tx.user_overridden ? 1 : 0,
    source: tx.source || 'GMAIL_REAL',
    raw_sender: tx.raw_sender || 'enviodigital@bancochile.cl',
    raw_subject: tx.raw_subject || 'Cargo en Cuenta'
  });
  return result.changes > 0;
}

function getAllTransactions({ sourceFilter = 'ALL' } = {}) {
  if (sourceFilter === 'GMAIL_REAL') {
    return db
      .prepare(`SELECT * FROM transactions WHERE source = 'GMAIL_REAL' ORDER BY transaction_date DESC, id DESC`)
      .all();
  }
  return db.prepare(`SELECT * FROM transactions ORDER BY transaction_date DESC, id DESC`).all();
}

function getClassificationRules() {
  return db.prepare(`SELECT * FROM classification_rules ORDER BY updated_at DESC`).all();
}

function overrideTransactionNecessity({
  transactionId,
  necessityLevel,
  category,
  customNote,
  applyRuleToMerchant,
  merchantPattern
}) {
  const tx = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(transactionId);
  if (!tx) {
    throw new Error(`Transacción #${transactionId} no encontrada`);
  }

  const finalCategory = category || tx.category;
  const finalNote =
    customNote || `Clasificación ajustada manualmente por el usuario como "${necessityLevel}".`;

  db.prepare(`
    UPDATE transactions
    SET necessity_level = ?, category = ?, ai_justification = ?, user_overridden = 1
    WHERE id = ?
  `).run(necessityLevel, finalCategory, finalNote, transactionId);

  let affectedCount = 1;

  if (applyRuleToMerchant) {
    const pattern = (merchantPattern || tx.destination_bank || tx.merchant || '')
      .toLowerCase()
      .split('·')[0]
      .replace(/\(.*?\)/g, '')
      .trim();

    if (pattern) {
      db.prepare(`
        INSERT INTO classification_rules (merchant_pattern, assigned_category, assigned_necessity, custom_note, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(merchant_pattern) DO UPDATE SET
          assigned_category = excluded.assigned_category,
          assigned_necessity = excluded.assigned_necessity,
          custom_note = excluded.custom_note,
          updated_at = datetime('now')
      `).run(pattern, finalCategory, necessityLevel, finalNote);

      const allEgresos = db.prepare(`SELECT * FROM transactions WHERE flow_type = 'EGRESO'`).all();
      const updateStmt = db.prepare(`
        UPDATE transactions
        SET necessity_level = ?, category = ?, ai_justification = ?, user_overridden = 1
        WHERE id = ?
      `);

      for (const item of allEgresos) {
        const hay = `${item.merchant} ${item.destination_bank || ''}`.toLowerCase();
        if (hay.includes(pattern)) {
          updateStmt.run(necessityLevel, finalCategory, finalNote, item.id);
          affectedCount++;
        }
      }
    }
  }

  return { updatedTransactionId: transactionId, affectedCount };
}

function deleteClassificationRule(ruleId) {
  db.prepare(`DELETE FROM classification_rules WHERE id = ?`).run(ruleId);
  const rules = getClassificationRules();
  const allTxs = db.prepare(`SELECT * FROM transactions WHERE flow_type = 'EGRESO'`).all();
  const updateStmt = db.prepare(`
    UPDATE transactions
    SET category = ?, necessity_level = ?, ai_justification = ?, user_overridden = ?
    WHERE id = ?
  `);

  for (const tx of allTxs) {
    const ev = evaluateTransaction(tx, rules);
    updateStmt.run(ev.category, ev.necessity_level, ev.ai_justification, ev.user_overridden, tx.id);
  }
}

function logSyncEvent({
  syncType,
  emailsScanned,
  newTransactions,
  duplicatesSkipped,
  status = 'SUCCESS',
  details = ''
}) {
  db.prepare(`
    INSERT INTO sync_logs (sync_type, emails_scanned, new_transactions, duplicatesSkipped, status, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(syncType, emailsScanned, newTransactions, duplicatesSkipped, status, details);
}

// Corregir nombre de columna en logSyncEvent
function safeLogSyncEvent({
  syncType,
  emailsScanned,
  newTransactions,
  duplicatesSkipped,
  status = 'SUCCESS',
  details = ''
}) {
  db.prepare(`
    INSERT INTO sync_logs (sync_type, emails_scanned, new_transactions, duplicates_skipped, status, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(syncType, emailsScanned, newTransactions, duplicatesSkipped, status, details);
}

function getRecentSyncLogs(limit = 8) {
  return db.prepare(`SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?`).all(limit);
}

/**
 * ================= MÓDULO FINTUAL ACCIONES & AGENTE DE INVERSIONES =================
 */
function seedFintualPortfolioIfEmpty() {
  const count = db.prepare(`SELECT COUNT(*) as c FROM fintual_positions`).get().c;
  if (count === 0) {
    const insertPos = db.prepare(`
      INSERT INTO fintual_positions (ticker, name, asset_type, shares, avg_buy_price_usd, current_price_usd, target_weight_pct, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertPos.run('VOO', 'Vanguard S&P 500 ETF', 'ETF', 0.45, 512.40, 548.80, 45, 'Núcleo indexado S&P 500 (DCA mensual)');
    insertPos.run('QQQ', 'Invesco QQQ Trust (Nasdaq-100)', 'ETF', 0.28, 478.10, 514.50, 25, 'Exposición tecnológica US Growth');
    insertPos.run('NVDA', 'NVIDIA Corporation', 'STOCK', 1.15, 118.50, 141.20, 15, 'Semiconductores e infraestructura IA');
    insertPos.run('MSFT', 'Microsoft Corporation', 'STOCK', 0.22, 415.00, 438.90, 15, 'Cloud Azure & Copilot Enterprise');
  }

  const sigCount = db.prepare(`SELECT COUNT(*) as c FROM fintual_agent_signals`).get().c;
  if (sigCount === 0) {
    const insertSig = db.prepare(`
      INSERT INTO fintual_agent_signals (agent_id, action_type, ticker, suggested_amount_clp, suggested_amount_usd, confidence_pct, reasoning, source_liquidity_note, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSig.run(
      'fintual-invest-agent-v1',
      'DCA',
      'VOO',
      120000,
      123.71,
      92,
      'Acumulación periódica en S&P 500 aprovechando liquidez libre en Cuenta Corriente ****0401 post-reserva de Tarjeta de Crédito.',
      'Proveniente de excedente neto de cuenta ($398.723 CLP disponibles tras apartar $201.353 para pagar TC ****4114).',
      'PENDIENTE'
    );
    insertSig.run(
      'fintual-invest-agent-v1',
      'BUY',
      'QQQ',
      74790,
      77.10,
      88,
      'Redirección equivalente al 100% de tu gasto hormiga bimestral en SERVICIOS Y COMER (24 compras = $74.790 CLP) hacia Nasdaq-100.',
      'Reasignación de ahorro por control de gasto hormiga detectado por el Agente Banco de Chile.',
      'PENDIENTE'
    );
  }
}

function getFintualPositions() {
  seedFintualPortfolioIfEmpty();
  return db.prepare(`SELECT * FROM fintual_positions ORDER BY target_weight_pct DESC, id ASC`).all();
}

function upsertFintualPosition({ ticker, name, asset_type = 'STOCK', shares, avg_buy_price_usd, current_price_usd, target_weight_pct = 10, notes = '' }) {
  const cleanTicker = String(ticker || '').toUpperCase().trim();
  if (!cleanTicker) throw new Error('Ticker es obligatorio');

  db.prepare(`
    INSERT INTO fintual_positions (ticker, name, asset_type, shares, avg_buy_price_usd, current_price_usd, target_weight_pct, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      name = excluded.name,
      asset_type = excluded.asset_type,
      shares = excluded.shares,
      avg_buy_price_usd = excluded.avg_buy_price_usd,
      current_price_usd = excluded.current_price_usd,
      target_weight_pct = excluded.target_weight_pct,
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(
    cleanTicker,
    name || cleanTicker,
    asset_type,
    Number(shares) || 0,
    Number(avg_buy_price_usd) || 0,
    Number(current_price_usd) || Number(avg_buy_price_usd) || 0,
    Number(target_weight_pct) || 10,
    notes
  );
  return getFintualPositions();
}

function getFintualSignals(limit = 10) {
  seedFintualPortfolioIfEmpty();
  return db.prepare(`SELECT * FROM fintual_agent_signals ORDER BY id DESC LIMIT ?`).all(limit);
}

function insertFintualAgentSignal({
  agent_id = 'fintual-invest-agent-v1',
  action_type = 'BUY',
  ticker = 'VOO',
  suggested_amount_clp = 50000,
  usd_rate = 970,
  confidence_pct = 90,
  reasoning = '',
  source_liquidity_note = ''
}) {
  const clp = Math.round(Number(suggested_amount_clp) || 50000);
  const usd = Number((clp / usd_rate).toFixed(2));
  db.prepare(`
    INSERT INTO fintual_agent_signals (
      agent_id, action_type, ticker, suggested_amount_clp, suggested_amount_usd,
      confidence_pct, reasoning, source_liquidity_note, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE')
  `).run(
    agent_id,
    action_type.toUpperCase(),
    ticker.toUpperCase(),
    clp,
    usd,
    Number(confidence_pct) || 88,
    reasoning || `Señal automática generada para ${ticker.toUpperCase()} con excedente de liquidez Banco de Chile.`,
    source_liquidity_note || 'Excedente libre después de reservar pago mensual de Tarjeta de Crédito ****4114.'
  );
  return getFintualSignals();
}

module.exports = {
  db,
  insertTransactionIfNew,
  getAllTransactions,
  getClassificationRules,
  overrideTransactionNecessity,
  deleteClassificationRule,
  logSyncEvent: safeLogSyncEvent,
  getRecentSyncLogs,
  getFintualPositions,
  upsertFintualPosition,
  getFintualSignals,
  insertFintualAgentSignal
};
