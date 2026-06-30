import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(__dirname, '../../data/database.db');

// 确保 data 目录存在
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db: DatabaseType = new Database(dbPath);

// 初始化数据库表
db.exec(`
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    url TEXT NOT NULL,
    max_content_length INTEGER DEFAULT 200000,
    max_token INTEGER DEFAULT 64000,
    api_key TEXT NOT NULL,
    sort_index INTEGER DEFAULT -1,
    api_format INTEGER DEFAULT 1,
    model_label_id INTEGER,
    capabilities TEXT DEFAULT '["completion","tools","thinking"]',
    isLock INTEGER DEFAULT 0,
    isDisable INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS token_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL,
    stat_date TEXT NOT NULL,
    in_token INTEGER DEFAULT 0,
    out_token INTEGER DEFAULT 0,
    total_token INTEGER DEFAULT 0,
    call_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (model_id) REFERENCES models(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 为已存在的 users 表添加新字段（如果不存在）
try {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
} catch (e) {
  // 字段可能已存在，忽略错误
}
try {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
} catch (e) {
  // 字段可能已存在，忽略错误
}

db.exec(`
  CREATE TABLE IF NOT EXISTS captchas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    expire_at INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_content_length INTEGER DEFAULT 0,
    max_token INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 确保 user_settings 表只有一条记录
const settingsCount = db.prepare('SELECT COUNT(*) as count FROM user_settings').get() as { count: number };
if (settingsCount.count === 0) {
  db.prepare('INSERT INTO user_settings (id, max_content_length, max_token) VALUES (1, 0, 0)').run();
}

export default db;