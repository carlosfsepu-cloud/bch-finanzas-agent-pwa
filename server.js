/**
 * ============================================================================
 * SERVIDOR FULL-STACK: AGENTE FINANCIERO BANCO DE CHILE + FINTUAL ACCIONES HUB
 * - Monitoreo continuo todos los días en tiempo real (Auto-Poller 25s + Pub/Sub)
 * - Dashboard General Interactivo 360°
 * - Pestañas Débito ****0401 y Crédito ****4114 (con Reserva Mensual de Facturación)
 * - API Multi-Agente para el Agente de Inversiones en Fintual Acciones
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const {
  db,
  getAllTransactions,
  getClassificationRules,
  overrideTransactionNecessity,
  deleteClassificationRule,
  getRecentSyncLogs,
  getFintualPositions,
  upsertFintualPosition,
  getFintualSignals,
  insertFintualAgentSignal
} = require('./db/database');
const {
  generateFinancialAudit,
  generateGlobalDashboardAudit,
  buildFintualIntegrationOverview,
  LLM_SYSTEM_PROMPT
} = require('./src/agent/financialEvaluator');
const { syncFromGmail, simulateIncomingBancoChileEmail } = require('./src/services/gmailService');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTO_POLL_SECONDS = 25;

const sseClients = new Set();
let lastSyncTimestamp = new Date().toISOString();

function broadcastSSE(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function buildAppState(sourceFilter = 'ALL') {
  const allTxs = getAllTransactions({ sourceFilter: 'ALL' });
  const gmailRealCount = allTxs.filter((t) => t.source === 'GMAIL_REAL').length;
  const simuladoCount = allTxs.filter((t) => t.source === 'SIMULADO').length;

  const transactions =
    sourceFilter === 'GMAIL_REAL' ? allTxs.filter((t) => t.source === 'GMAIL_REAL') : allTxs;

  const fintualPositions = getFintualPositions();
  const fintualSignals = getFintualSignals(10);

  return {
    connectedAccount: 'tu-correo@gmail.com',
    windowRange: 'Historial Base 2 Meses + Escucha Diaria en Tiempo Real',
    realtimeConfig: {
      mode: 'CONTINUOUS_DAILY_WATCH',
      pollIntervalSeconds: AUTO_POLL_SECONDS,
      pubsubWebhookUrl: '/api/webhooks/gmail-pubsub',
      lastSyncTimestamp
    },
    bankName: 'Banco de Chile',
    sourceFilter,
    counts: {
      total: allTxs.length,
      gmailRealCount,
      simuladoCount
    },
    transactions,
    globalDashboard: generateGlobalDashboardAudit(transactions),
    audit: {
      DEBITO_CUENTA: generateFinancialAudit(transactions, 'DEBITO_CUENTA'),
      CREDITO: generateFinancialAudit(transactions, 'CREDITO')
    },
    fintual: buildFintualIntegrationOverview(transactions, fintualPositions, fintualSignals),
    rules: getClassificationRules(),
    syncLogs: getRecentSyncLogs(6),
    llmPromptPreview: LLM_SYSTEM_PROMPT,
    serverTimestamp: new Date().toISOString()
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. Stream Server-Sent Events (Tiempo Real)
  if (req.method === 'GET' && pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(
      `event: connected\ndata: ${JSON.stringify({
        status: 'LIVE_GMAIL_WATCH',
        pollIntervalSeconds: AUTO_POLL_SECONDS,
        lastSyncTimestamp
      })}\n\n`
    );
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // 2. Estado Completo (Dashboard 360°, Débito, Crédito y Fintual Acciones)
  if (req.method === 'GET' && pathname === '/api/state') {
    const sourceFilter = parsedUrl.searchParams.get('source') || 'ALL';
    return sendJson(res, 200, buildAppState(sourceFilter));
  }

  // 3. Sincronización en vivo con Gmail
  if (req.method === 'POST' && pathname === '/api/sync-gmail') {
    try {
      const syncResult = await syncFromGmail();
      lastSyncTimestamp = new Date().toISOString();
      const state = buildAppState('ALL');
      broadcastSSE('state_updated', {
        reason: 'GMAIL_SYNC',
        syncResult,
        lastSyncTimestamp,
        state
      });
      return sendJson(res, 200, { ok: true, syncResult, state });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 4. Simular nuevo correo entrante de Banco de Chile en Tiempo Real
  if (req.method === 'POST' && pathname === '/api/simulate-email') {
    try {
      const body = await parseJsonBody(req);
      const newTx = simulateIncomingBancoChileEmail(body);
      lastSyncTimestamp = new Date().toISOString();
      const state = buildAppState('ALL');
      broadcastSSE('new_email', {
        transaction: newTx,
        state
      });
      return sendJson(res, 200, { ok: true, transaction: newTx, state });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // 5. Corregir evaluación de necesidad del Agente IA
  if (req.method === 'POST' && pathname === '/api/override-necessity') {
    try {
      const body = await parseJsonBody(req);
      const result = overrideTransactionNecessity({
        transactionId: Number(body.transactionId),
        necessityLevel: body.necessityLevel,
        category: body.category,
        customNote: body.customNote,
        applyRuleToMerchant: Boolean(body.applyRuleToMerchant),
        merchantPattern: body.merchantPattern
      });
      const state = buildAppState('ALL');
      broadcastSSE('state_updated', {
        reason: 'RULE_UPDATED',
        result,
        state
      });
      return sendJson(res, 200, { ok: true, result, state });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // 6. Eliminar regla personalizada
  if (req.method === 'DELETE' && pathname.startsWith('/api/rules/')) {
    try {
      const ruleId = Number(pathname.split('/').pop());
      deleteClassificationRule(ruleId);
      const state = buildAppState('ALL');
      broadcastSSE('state_updated', { reason: 'RULE_DELETED', state });
      return sendJson(res, 200, { ok: true, state });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // 7. ENDPOINTS MULTI-AGENTE PARA EL AGENTE DE INVERSIONES (FINTUAL ACCIONES)
  if (req.method === 'GET' && pathname === '/api/fintual/context') {
    const state = buildAppState('ALL');
    return sendJson(res, 200, {
      ok: true,
      agentBridge: 'BANCO_DE_CHILE_TO_FINTUAL_ACCIONES',
      fintual: state.fintual
    });
  }

  if (req.method === 'POST' && pathname === '/api/fintual/positions') {
    try {
      const body = await parseJsonBody(req);
      upsertFintualPosition(body);
      const state = buildAppState('ALL');
      broadcastSSE('state_updated', { reason: 'FINTUAL_POSITION_UPDATED', state });
      return sendJson(res, 200, { ok: true, fintual: state.fintual });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/fintual/agent-signal') {
    try {
      const body = await parseJsonBody(req);
      insertFintualAgentSignal(body);
      const state = buildAppState('ALL');
      broadcastSSE('fintual_signal', {
        signal: state.fintual.signals[0],
        state
      });
      return sendJson(res, 200, { ok: true, fintual: state.fintual });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // 8. Webhook Oficial Google Cloud Pub/Sub para notificaciones Push de Gmail en tiempo real
  if (req.method === 'POST' && pathname === '/api/webhooks/gmail-pubsub') {
    try {
      const body = await parseJsonBody(req);
      let decodedNotification = {};
      if (body?.message?.data) {
        decodedNotification = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8'));
      }
      const syncResult = await syncFromGmail();
      lastSyncTimestamp = new Date().toISOString();
      const state = buildAppState('ALL');
      broadcastSSE('state_updated', {
        reason: 'PUBSUB_PUSH',
        notification: decodedNotification,
        syncResult,
        lastSyncTimestamp,
        state
      });
      return sendJson(res, 200, { ok: true, syncResult });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // 9. Archivos estáticos PWA
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

async function bootstrap() {
  db.prepare(
    `DELETE FROM transactions WHERE gmail_message_id LIKE 'bch-demo-%' OR (raw_subject = 'Aviso de transferencia de fondos' AND destination_bank = 'Prex')`
  ).run();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Agente Financiero Banco de Chile + Fintual Hub PWA en http://localhost:${PORT}`);
  });

  console.log('[Bootstrap] Cargando historial base de 2 meses y activando escucha diaria en tiempo real...');
  const syncResult = await syncFromGmail();
  lastSyncTimestamp = new Date().toISOString();
  console.log(
    `[Bootstrap] Gmail sincronizado: ${syncResult.newTransactions} nuevos, ${syncResult.duplicatesSkipped} existentes.`
  );

  // Escucha automática continua cada 25 segundos para detectar nuevas transacciones del día al instante
  setInterval(async () => {
    try {
      const res = await syncFromGmail();
      lastSyncTimestamp = new Date().toISOString();
      if (res.newTransactions > 0) {
        broadcastSSE('new_email', {
          transaction: res.newlyInserted[0],
          syncResult: res,
          lastSyncTimestamp,
          state: buildAppState('ALL')
        });
      } else {
        broadcastSSE('heartbeat_sync', {
          lastSyncTimestamp,
          emailsScanned: res.emailsScanned
        });
      }
    } catch (e) {
      console.error('[AutoPoll Error]', e.message);
    }
  }, AUTO_POLL_SECONDS * 1000);
}

bootstrap();
