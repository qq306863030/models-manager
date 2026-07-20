import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// 数据库存放于 ~/.models-manager
const getDataDir = () => {
  const dir = path.join(os.homedir(), '.models-manager');
  return dir;
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
    proxy_url TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const settingsCount = db.prepare('SELECT COUNT(*) as count FROM user_settings').get() as { count: number };
if (settingsCount.count === 0) {
  db.prepare('INSERT INTO user_settings (id, max_content_length, max_token, lock_duration) VALUES (1, 0, 0, 600)').run();
}

// 为已存在的 user_settings 添加 proxy_url 列
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN proxy_url TEXT DEFAULT \'\'');
} catch (e) {
  // 列可能已存在，忽略错误
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
export function getUserSettings(): { max_content_length: number; max_token: number; lock_duration: number; proxy_url: string } {
  const row = db.prepare('SELECT max_content_length, max_token, lock_duration, proxy_url FROM user_settings WHERE id = 1').get() as { max_content_length: number; max_token: number; lock_duration: number; proxy_url: string } | undefined;
  return row || { max_content_length: 0, max_token: 0, lock_duration: 600, proxy_url: '' };
}

// 保存用户设置
export function saveUserSettings(max_content_length: number, max_token: number, lock_duration: number, proxy_url?: string): void {
  if (proxy_url !== undefined) {
    db.prepare('UPDATE user_settings SET max_content_length = ?, max_token = ?, lock_duration = ?, proxy_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(max_content_length, max_token, lock_duration, proxy_url);
  } else {
    db.prepare('UPDATE user_settings SET max_content_length = ?, max_token = ?, lock_duration = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(max_content_length, max_token, lock_duration);
  }
}

// 为已存在的 user_settings 添加 lock_duration 列
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN lock_duration INTEGER DEFAULT 600');
} catch (e) {
  // 列可能已存在，忽略错误
}

// ========== MCP 记录表 ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    content TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// 获取用户的 MCP 记录
export function getMcpRecord(userId: number): { content: string } | null {
  const row = db.prepare('SELECT content FROM mcp_records WHERE user_id = ?').get(userId) as { content: string } | undefined;
  return row || null;
}

// 插入或更新用户的 MCP 记录
export function upsertMcpRecord(userId: number, content: string): void {
  const existing = db.prepare('SELECT id FROM mcp_records WHERE user_id = ?').get(userId);
  if (existing) {
    db.prepare('UPDATE mcp_records SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(content, userId);
  } else {
    db.prepare('INSERT INTO mcp_records (user_id, content) VALUES (?, ?)').run(userId, content);
  }
}

// ========== Agent 记忆表 ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_memory_user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    content TEXT,
    user_id INTEGER REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_memory_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    content TEXT,
    user_id INTEGER REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_memory_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    content TEXT,
    user_id INTEGER REFERENCES users(id)
  )
`);

// 为已存在的表添加 user_id 列（兼容旧库）
try { db.exec('ALTER TABLE agent_memory_user ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch (e) {}
try { db.exec('ALTER TABLE agent_memory_skills ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch (e) {}
try { db.exec('ALTER TABLE agent_memory_docs ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch (e) {}

// 将已有数据的 user_id 设为 1（admin 用户）
try { db.prepare("UPDATE agent_memory_user SET user_id = 1 WHERE user_id IS NULL").run(); } catch (e) {}
try { db.prepare("UPDATE agent_memory_skills SET user_id = 1 WHERE user_id IS NULL").run(); } catch (e) {}
try { db.prepare("UPDATE agent_memory_docs SET user_id = 1 WHERE user_id IS NULL").run(); } catch (e) {}

// ========== Agent Memory User CRUD ==========
export function getAgentMemoryUserList(userId: number): { id: number; description: string | null; content: string | null }[] {
  return db.prepare('SELECT id, description, content FROM agent_memory_user WHERE user_id = ? ORDER BY id').all(userId) as any[];
}

export function getAgentMemoryUserById(id: number, userId: number): { id: number; description: string | null; content: string | null } | null {
  return db.prepare('SELECT id, description, content FROM agent_memory_user WHERE id = ? AND user_id = ?').get(id, userId) as any || null;
}

export function createAgentMemoryUser(description: string | null, content: string | null, userId: number): { id: number } {
  const result = db.prepare('INSERT INTO agent_memory_user (description, content, user_id) VALUES (?, ?, ?)').run(description, content, userId);
  return { id: result.lastInsertRowid as number };
}

export function updateAgentMemoryUser(id: number, description: string | null, content: string | null, userId: number): boolean {
  const result = db.prepare('UPDATE agent_memory_user SET description = ?, content = ? WHERE id = ? AND user_id = ?').run(description, content, id, userId);
  return result.changes > 0;
}

export function deleteAgentMemoryUser(id: number, userId: number): boolean {
  const result = db.prepare('DELETE FROM agent_memory_user WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

// ========== Agent Memory Skills CRUD ==========
export function getAgentMemorySkillsList(userId: number): { id: number; description: string | null; content: string | null }[] {
  return db.prepare('SELECT id, description, content FROM agent_memory_skills WHERE user_id = ? ORDER BY id').all(userId) as any[];
}

export function getAgentMemorySkillsById(id: number, userId: number): { id: number; description: string | null; content: string | null } | null {
  return db.prepare('SELECT id, description, content FROM agent_memory_skills WHERE id = ? AND user_id = ?').get(id, userId) as any || null;
}

export function createAgentMemorySkills(description: string | null, content: string | null, userId: number): { id: number } {
  const result = db.prepare('INSERT INTO agent_memory_skills (description, content, user_id) VALUES (?, ?, ?)').run(description, content, userId);
  return { id: result.lastInsertRowid as number };
}

export function updateAgentMemorySkills(id: number, description: string | null, content: string | null, userId: number): boolean {
  const result = db.prepare('UPDATE agent_memory_skills SET description = ?, content = ? WHERE id = ? AND user_id = ?').run(description, content, id, userId);
  return result.changes > 0;
}

export function deleteAgentMemorySkills(id: number, userId: number): boolean {
  const result = db.prepare('DELETE FROM agent_memory_skills WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

// ========== Agent Memory Docs CRUD ==========
export function getAgentMemoryDocsList(userId: number): { id: number; description: string | null; content: string | null }[] {
  return db.prepare('SELECT id, description, content FROM agent_memory_docs WHERE user_id = ? ORDER BY id').all(userId) as any[];
}

export function getAgentMemoryDocsById(id: number, userId: number): { id: number; description: string | null; content: string | null } | null {
  return db.prepare('SELECT id, description, content FROM agent_memory_docs WHERE id = ? AND user_id = ?').get(id, userId) as any || null;
}

export function createAgentMemoryDocs(description: string | null, content: string | null, userId: number): { id: number } {
  const result = db.prepare('INSERT INTO agent_memory_docs (description, content, user_id) VALUES (?, ?, ?)').run(description, content, userId);
  return { id: result.lastInsertRowid as number };
}

export function updateAgentMemoryDocs(id: number, description: string | null, content: string | null, userId: number): boolean {
  const result = db.prepare('UPDATE agent_memory_docs SET description = ?, content = ? WHERE id = ? AND user_id = ?').run(description, content, id, userId);
  return result.changes > 0;
}

export function deleteAgentMemoryDocs(id: number, userId: number): boolean {
  const result = db.prepare('DELETE FROM agent_memory_docs WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

export default db;