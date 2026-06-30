const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'data/database.db');
const db = new Database(dbPath);

db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
console.log('Added role column');

const result = db.prepare("UPDATE users SET role = 'super_admin' WHERE name = 'admin'").run();
console.log('Updated admin, changes:', result.changes);

console.log('Users:', db.prepare('SELECT id, name, role FROM users').all());
db.close();
