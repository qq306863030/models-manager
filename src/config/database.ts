import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(__dirname, '../../data/database.db');

// 纭ķ繚 data 鐩ķ綍瀛樺湪
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db: DatabaseType = new Database(dbPath);

// 鍒濆簱鍖栨暟鎹ķ簱琛?
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

// 涓哄凡瀛樺湪鐨?users 琛屽姞鍏ユ柊瀛楁ķ
try {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
} catch (e) {
  // 瀛楁ķ鍙ď兘宸插瓨鍦★紝蹇界暐閿欒
}
try {
  db.exec('ALTER TABLE users ADD COLUMN role TEXT DEFAULT '\''user'\'' CHECK(role IN ('\''super_admin'\'', '\''admin'\'', '\''user'\''))');
} catch (e) {
  // 瀛楁ķ鍙ď兘宸插瓨鍦★紝蹇界暐閿欒
}

// 灏哸dmin璁剧疆涓烘満绠″楂樼瓑绠
try {
  db.prepare("UPDATE users SET role = 'super_admin' WHERE name = 'admin' AND (role IS NULL OR role = 'user' OR role = '' OR role = 'admin')").run();
} catch (e) {
  // 蹇界暐閿欒
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

// 纭ķ繚 user_settings 琛ㄥ彧鏈変竴鏉¤Ę褰?
const settingsCount = db.prepare('SELECT COUNT(*) as count FROM user_settings').get() as { count: number };
if (settingsCount.count === 0) {
  db.prepare('INSERT INTO user_settings (id, max_content_length, max_token) VALUES (1, 0, 0)').run();
}

export default db;