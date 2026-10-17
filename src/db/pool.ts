import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'discorddd.db');

let db: any = null;

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export async function initDb(): Promise<void> {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
    logger.info(`SQLite database loaded from: ${dbPath}`);
  } else {
    db = new SQL.Database();
    logger.info(`New SQLite database created at: ${dbPath}`);
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Run migrations to ensure tables exist
  runMigrations();
}

function runMigrations(): void {
  if (!db) return;

  const migrationSQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT DEFAULT 'offline',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT,
  icon_url TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  invite_code TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS server_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(server_id, user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#99aab5',
  position INTEGER DEFAULT 0,
  permissions INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES channels(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text','voice','video','category','announcement','forum')),
  topic TEXT,
  position INTEGER DEFAULT 0,
  nsfw INTEGER DEFAULT 0,
  bitrate INTEGER,
  user_limit INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  reply_to_id INTEGER REFERENCES messages(id),
  edited_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL UNIQUE,
  device_info TEXT,
  ip_address TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
`;

  try {
    db.run(migrationSQL);
    logger.info('Database migrations executed successfully');
  } catch (err) {
    logger.error(err, 'Failed to run database migrations');
    throw err;
  }
}

function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Auto-save every 5 seconds
let saveInterval: ReturnType<typeof setInterval> | null = null;
export function startAutoSave(): void {
  if (saveInterval) return;
  saveInterval = setInterval(saveDb, 5000);
}

export function getDb(): any {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export interface QueryResult {
  rows: any[];
  changes?: number;
  lastInsertRowid?: number | bigint;
}

export function query(sql: string, params: any[] = []): QueryResult {
  const database = getDb();

  // Convert PostgreSQL-style placeholders ($1, $2) to SQLite (?)
  let sqliteSql = sql;
  let idx = 1;
  while (sqliteSql.includes(`$${idx}`)) {
    sqliteSql = sqliteSql.replace(`$${idx}`, '?');
    idx++;
  }

  // Remove RETURNING clause (not supported in SQLite)
  const hasReturning = /RETURNING\s+/i.test(sqliteSql);
  if (hasReturning) {
    sqliteSql = sqliteSql.replace(/\s*RETURNING\s+.*$/i, '');
  }

  const trimmed = sqliteSql.trim().toUpperCase();

  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA')) {
    const stmt = database.prepare(sqliteSql);
    stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return { rows };
  } else {
    database.run(sqliteSql, params);

    // Get changes and last insert rowid
    const changesResult = database.exec('SELECT changes(), last_insert_rowid()');
    let changes = 0;
    let lastInsertRowid: number | bigint = 0;
    if (changesResult.length > 0 && changesResult[0].values.length > 0) {
      changes = changesResult[0].values[0][0] as number;
      lastInsertRowid = changesResult[0].values[0][1] as number;
    }

    // After any INSERT, fetch the inserted row
    if (trimmed.startsWith('INSERT') && changes > 0) {
      const tableMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);
      if (tableMatch) {
        const tableName = tableMatch[1];
        try {
          // Always use ORDER BY rowid DESC LIMIT 1 for reliability with TEXT/UUID primary keys
          const rowResult = database.exec(`SELECT * FROM ${tableName} ORDER BY rowid DESC LIMIT 1`);
          if (rowResult.length > 0 && rowResult[0].values.length > 0) {
            const columns = rowResult[0].columns;
            const values = rowResult[0].values[0];
            const row: any = {};
            columns.forEach((col: string, i: number) => { row[col] = values[i]; });
            saveDb();
            return { rows: [row], changes, lastInsertRowid };
          }
        } catch (err) {
          logger.error(err, 'Failed to fetch inserted row');
        }
      }
    }

    // Save after write
    saveDb();
    return { rows: [], changes, lastInsertRowid };
  }
}

export function testConnection(): void {
  const database = getDb();
  database.exec('SELECT 1');
  logger.info('SQLite connection successful');
}

export async function end(): Promise<void> {
  if (saveInterval) {
    clearInterval(saveInterval);
    saveInterval = null;
  }
  saveDb();
  if (db) {
    db.close();
    db = null;
  }
  logger.info('SQLite database closed');
}

// Compatibility wrapper
export const pool = {
  query,
  connect: async () => ({
    query: (sql: string, params: any[] = []) => query(sql, params),
    release: () => {},
  }),
  testConnection,
  end,
};