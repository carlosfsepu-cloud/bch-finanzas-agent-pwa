-- =============================================================================
-- ESQUEMA DE BASE DE DATOS: AGENTE FINANCIERO BANCO DE CHILE + FINTUAL ACCIONES
-- Motor: SQLite 3 (node:sqlite DatabaseSync en modo WAL)
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Tabla Principal de Transacciones Bancarias (Deduplicada por gmail_message_id)
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id TEXT NOT NULL UNIQUE,
    gmail_thread_id TEXT,
    voucher_number TEXT,
    transaction_date TEXT NOT NULL,
    display_date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CLP',
    flow_type TEXT NOT NULL CHECK (flow_type IN ('INGRESO', 'EGRESO')),
    instrument TEXT NOT NULL CHECK (instrument IN ('DEBITO_CUENTA', 'CREDITO')),
    card_last4 TEXT DEFAULT 'Cuenta ****0401',
    installments_current INTEGER DEFAULT 1,
    installments_total INTEGER DEFAULT 1,
    merchant TEXT NOT NULL,
    destination_bank TEXT,
    destination_account TEXT,
    transfer_subject TEXT,
    category TEXT NOT NULL,
    necessity_level TEXT NOT NULL CHECK (
        necessity_level IN ('Necesario', 'Opcional / Prescindible', 'Gasto Hormiga', 'Ingreso')
    ),
    ai_justification TEXT NOT NULL,
    user_overridden INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'GMAIL_REAL' CHECK (source IN ('GMAIL_REAL', 'SIMULADO')),
    raw_sender TEXT,
    raw_subject TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_instrument ON transactions(instrument);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_necessity ON transactions(necessity_level);

-- 2. Tabla de Reglas Personalizables del Usuario
CREATE TABLE IF NOT EXISTS classification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_pattern TEXT NOT NULL UNIQUE,
    assigned_category TEXT NOT NULL,
    assigned_necessity TEXT NOT NULL CHECK (
        assigned_necessity IN ('Necesario', 'Opcional / Prescindible', 'Gasto Hormiga')
    ),
    custom_note TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Tabla de Auditoría de Sincronización Continua con Gmail
CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_type TEXT NOT NULL,
    emails_scanned INTEGER NOT NULL DEFAULT 0,
    new_transactions INTEGER NOT NULL DEFAULT 0,
    duplicates_skipped INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'SUCCESS',
    details TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4. Tabla de Posiciones en Fintual Acciones (Integración con Agente de Inversiones)
CREATE TABLE IF NOT EXISTS fintual_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,                     -- Ej. 'VOO', 'QQQ', 'NVDA', 'AAPL', 'MSFT'
    name TEXT NOT NULL,                              -- Nombre del activo / ETF
    asset_type TEXT NOT NULL DEFAULT 'ETF',          -- 'ETF' | 'STOCK' | 'FONDO_FINTUAL'
    shares REAL NOT NULL DEFAULT 0,                  -- Cantidad de acciones (soporta fracciones)
    avg_buy_price_usd REAL NOT NULL DEFAULT 0,       -- Precio promedio de compra en USD
    current_price_usd REAL NOT NULL DEFAULT 0,       -- Precio actual de mercado en USD
    target_weight_pct REAL NOT NULL DEFAULT 0,       -- Peso objetivo sugerido por el Agente de Inversiones
    notes TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Tabla de Señales y Órdenes del Agente de Inversiones (Puente Multi-Agente)
CREATE TABLE IF NOT EXISTS fintual_agent_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL DEFAULT 'fintual-invest-agent-v1',
    action_type TEXT NOT NULL CHECK (action_type IN ('BUY', 'DCA', 'HOLD', 'REBALANCE', 'SELL')),
    ticker TEXT NOT NULL,
    suggested_amount_clp INTEGER NOT NULL DEFAULT 0,
    suggested_amount_usd REAL NOT NULL DEFAULT 0,
    confidence_pct INTEGER NOT NULL DEFAULT 85,
    reasoning TEXT NOT NULL,
    source_liquidity_note TEXT,
    status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE', 'EJECUTADA', 'DESCARTADA')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
