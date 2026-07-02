import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// 优先使用当前工作目录，兼容全局安装和本地开发
const getDataDir = () => {
  const cwdDataDir = path.join(process.cwd(), 'data');
  if (fs.existsSync(cwdDataDir) || fs.mkdirSync(cwdDataDir, { recursive: true })) {
    return cwdDataDir;
  }
  // 回退到用户目录
  return path.join(os.homedir(), '.ai-models-manager', 'data');
};

const dbPath = path.join(getDataDir(), 'database.db');


const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db: DatabaseType = new Database(dbPath);

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
    role TEXT DEFAULT 'user' CHECK(role IN ('super_admin', 'admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
} catch (e) {
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user' CHECK(role IN ('super_admin', 'admin', 'user'))`);
} catch (e) {
  // 列可能已存在，忽略错误
}

// 将 admin 设置为超级管理员
try {
  db.prepare("UPDATE users SET role = 'super_admin' WHERE name = 'admin' AND (role IS NULL OR role = 'user' OR role = '' OR role = 'admin')").run();
} catch (e) {
  // 忽略错误
}

// 为已存在的 models 表添加 user_id 列（用户数据隔离）
try {
  db.exec('ALTER TABLE models ADD COLUMN user_id INTEGER REFERENCES users(id)');
} catch (e) {
  // 列可能已存在，忽略错误
}
// 将已有模型的 user_id 设为 1（admin 用户）
try {
  db.prepare("UPDATE models SET user_id = 1 WHERE user_id IS NULL").run();
} catch (e) {
  // 忽略错误
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
    lock_duration INTEGER DEFAULT 600,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const settingsCount = db.prepare('SELECT COUNT(*) as count FROM user_settings').get() as { count: number };
if (settingsCount.count === 0) {
  db.prepare('INSERT INTO user_settings (id, max_content_length, max_token, lock_duration) VALUES (1, 0, 0, 600)').run();
}

// 用户 API Key 表
db.exec(`
  CREATE TABLE IF NOT EXISTS user_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    api_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ========== API Key 操作函数 ==========
export function saveUserApiKey(username: string, apiKey: string): void {
  const existing = db.prepare('SELECT id FROM user_api_keys WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE user_api_keys SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?').run(apiKey, username);
  } else {
    db.prepare('INSERT INTO user_api_keys (username, api_key) VALUES (?, ?)').run(username, apiKey);
  }
}

export function getUserApiKey(username: string): string | null {
  const row = db.prepare('SELECT api_key FROM user_api_keys WHERE username = ?').get(username) as { api_key: string } | undefined;
  return row?.api_key || null;
}

export function verifyUserApiKey(username: string, apiKey: string): boolean {
  const stored = getUserApiKey(username);
  if (!stored) return false;
  return stored === apiKey;
}

export function deleteUserApiKey(username: string): void {
  db.prepare('DELETE FROM user_api_keys WHERE username = ?').run(username);
}

// 获取用户设置
export function getUserSettings(): { max_content_length: number; max_token: number; lock_duration: number } {
  return db.prepare('SELECT max_content_length, max_token, lock_duration FROM user_settings WHERE id = 1').get() as { max_content_length: number; max_token: number; lock_duration: number };
}

// 保存用户设置
export function saveUserSettings(max_content_length: number, max_token: number, lock_duration: number): void {
  db.prepare('UPDATE user_settings SET max_content_length = ?, max_token = ?, lock_duration = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(max_content_length, max_token, lock_duration);
}

// 为已存在的 user_settings 添加 lock_duration 列
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN lock_duration INTEGER DEFAULT 600');
} catch (e) {
  // 列可能已存在，忽略错误
}

export default db;