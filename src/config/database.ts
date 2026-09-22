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
    lock_duration INTEGER DEFAULT 30,
    proxy_url TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const settingsCount = db.prepare('SELECT COUNT(*) as count FROM user_settings').get() as { count: number };
if (settingsCount.count === 0) {
  db.prepare('INSERT INTO user_settings (id, max_content_length, max_token, lock_duration) VALUES (1, 0, 0, 30)').run();
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
  return row || { max_content_length: 0, max_token: 0, lock_duration: 30, proxy_url: '' };
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
  db.exec('ALTER TABLE user_settings ADD COLUMN lock_duration INTEGER DEFAULT 30');
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

// ========== 用户文件表 ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS user_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

export function getUserFilesList(userId: number): { id: number; original_name: string; stored_name: string; mime_type: string | null; file_size: number; created_at: string }[] {
  return db.prepare('SELECT id, original_name, stored_name, mime_type, file_size, created_at FROM user_files WHERE user_id = ? ORDER BY id DESC').all(userId) as any[];
}

export function getUserFileById(id: number, userId: number): { id: number; original_name: string; stored_name: string; mime_type: string | null; file_size: number; created_at: string } | null {
  return db.prepare('SELECT id, original_name, stored_name, mime_type, file_size, created_at FROM user_files WHERE id = ? AND user_id = ?').get(id, userId) as any || null;
}

export function createUserFile(originalName: string, storedName: string, mimeType: string | null, fileSize: number, userId: number): { id: number } {
  const result = db.prepare('INSERT INTO user_files (user_id, original_name, stored_name, mime_type, file_size) VALUES (?, ?, ?, ?, ?)').run(userId, originalName, storedName, mimeType, fileSize);
  return { id: result.lastInsertRowid as number };
}

export function deleteUserFile(id: number, userId: number): { stored_name: string } | null {
  const file = db.prepare('SELECT stored_name FROM user_files WHERE id = ? AND user_id = ?').get(id, userId) as { stored_name: string } | undefined;
  if (!file) return null;
  db.prepare('DELETE FROM user_files WHERE id = ? AND user_id = ?').run(id, userId);
  return { stored_name: file.stored_name };
}

// ========== AI 聊天会话表（跨端持久化） ==========
// 会话 id 沿用前端生成的 UUID，保证 PC 端与移动端识别的是同一个会话
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '新对话',
    model_name TEXT DEFAULT '',
    messages TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated ON chat_sessions(user_id, updated_at DESC)');

export interface ChatSessionRecord {
  id: string;
  title: string;
  modelName: string;
  createdAt: number;
  updatedAt: number;
  messages: any[];
}

interface ChatSessionRow {
  id: string;
  title: string | null;
  model_name: string | null;
  messages: string | null;
  created_at: number | null;
  updated_at: number | null;
}

/** 数据库行 → 接口返回结构（messages 反序列化，异常时降级为空数组） */
function mapChatSessionRow(row: ChatSessionRow): ChatSessionRecord {
  let messages: any[] = [];
  try {
    const parsed = JSON.parse(row.messages || '[]');
    if (Array.isArray(parsed)) messages = parsed;
  } catch (e) {
    messages = [];
  }
  return {
    id: row.id,
    title: row.title || '新对话',
    modelName: row.model_name || '',
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
    messages,
  };
}

/** 获取用户全部会话（按最近更新倒序） */
export function listChatSessions(userId: number): ChatSessionRecord[] {
  const rows = db.prepare(
    'SELECT id, title, model_name, messages, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(userId) as ChatSessionRow[];
  return rows.map(mapChatSessionRow);
}

/** 获取用户单个会话 */
export function getChatSession(id: string, userId: number): ChatSessionRecord | null {
  const row = db.prepare(
    'SELECT id, title, model_name, messages, created_at, updated_at FROM chat_sessions WHERE id = ? AND user_id = ?'
  ).get(id, userId) as ChatSessionRow | undefined;
  return row ? mapChatSessionRow(row) : null;
}

/** 新增或更新会话（upsert，created_at 以首次写入为准） */
export function upsertChatSession(userId: number, session: ChatSessionRecord): void {
  db.prepare(`
    INSERT INTO chat_sessions (id, user_id, title, model_name, messages, created_at, updated_at)
    VALUES (@id, @userId, @title, @modelName, @messages, @createdAt, @updatedAt)
    ON CONFLICT(id, user_id) DO UPDATE SET
      title = excluded.title,
      model_name = excluded.model_name,
      messages = excluded.messages,
      updated_at = excluded.updated_at
  `).run({
    id: session.id,
    userId,
    title: session.title,
    modelName: session.modelName,
    messages: JSON.stringify(session.messages || []),
    createdAt: session.createdAt || Date.now(),
    updatedAt: session.updatedAt || Date.now(),
  });
}

/** 删除会话，返回是否命中记录 */
export function deleteChatSession(id: string, userId: number): boolean {
  const result = db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

/** 清空用户全部会话，返回删除条数 */
export function deleteAllChatSessions(userId: number): number {
  const result = db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(userId);
  return result.changes;
}

export default db;