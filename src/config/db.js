const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '../../data/shipping.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath, { 
  verbose: process.env.DEBUG ? console.log : null 
});

// WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS shipping_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_list_id TEXT NOT NULL UNIQUE,
    site_ref TEXT NOT NULL,
    cust_num TEXT,
    cust_name TEXT NOT NULL,
    due_date TEXT,
    ship_code TEXT,
    total_cartons INTEGER NOT NULL,
    total_items INTEGER NOT NULL,
    scanned_boxes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    operator TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS confirmation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    confirmation_id INTEGER NOT NULL,
    pick_list_ref_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    ref_num TEXT,
    item_code TEXT NOT NULL,
    item_name TEXT,
    qty_to_pick REAL,
    um TEXT,
    planned_boxes INTEGER NOT NULL,
    wo_number TEXT,
    cust_po_num TEXT,
    scanned_boxes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (confirmation_id) REFERENCES shipping_confirmations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    confirmation_id INTEGER NOT NULL,
    item_id INTEGER,
    barcode TEXT NOT NULL,
    cust_pn TEXT,
    wo_number TEXT,
    box_num INTEGER,
    total_boxes INTEGER,
    scan_result TEXT NOT NULL,
    error_message TEXT,
    confirm_id TEXT,
    scanned_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (confirmation_id) REFERENCES shipping_confirmations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_scans_barcode ON scan_logs(barcode);
  CREATE INDEX IF NOT EXISTS idx_scans_confirmation ON scan_logs(confirmation_id);
  CREATE INDEX IF NOT EXISTS idx_confirm_picklist ON shipping_confirmations(pick_list_id);
  CREATE INDEX IF NOT EXISTS idx_confirm_status ON shipping_confirmations(status);
  CREATE INDEX IF NOT EXISTS idx_confirm_created ON shipping_confirmations(created_at);
`);

// 迁移：增加签名字段
try {
  db.exec(`ALTER TABLE shipping_confirmations ADD COLUMN signature TEXT`);
} catch (e) { /* 字段已存在则忽略 */ }
try {
  db.exec(`ALTER TABLE shipping_confirmations ADD COLUMN signed_by TEXT`);
} catch (e) { /* 字段已存在则忽略 */ }
try {
  db.exec(`ALTER TABLE shipping_confirmations ADD COLUMN drop_cust_name TEXT`);
} catch (e) { /* 字段已存在则忽略 */ }

module.exports = db;
