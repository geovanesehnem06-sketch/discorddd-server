import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'discorddd.db');
let db = null;
// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
export async function initDb() {
    const SQL = await initSqlJs();
    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
        logger.info(`SQLite database loaded from: ${dbPath}`);
    }
    else {
        db = new SQL.Database();
        logger.info(`New SQLite database created at: ${dbPath}`);
    }
    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON');
}
function saveDb() {
    if (!db)
        return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
}
// Auto-save every 5 seconds
let saveInterval = null;
export function startAutoSave() {
    if (saveInterval)
        return;
    saveInterval = setInterval(saveDb, 5000);
}
export function getDb() {
    if (!db)
        throw new Error('Database not initialized. Call initDb() first.');
    return db;
}
export function query(sql, params = []) {
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
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        return { rows };
    }
    else {
        database.run(sqliteSql, params);
        // Get changes and last insert rowid
        const changesResult = database.exec('SELECT changes(), last_insert_rowid()');
        let changes = 0;
        let lastInsertRowid = 0;
        if (changesResult.length > 0 && changesResult[0].values.length > 0) {
            changes = changesResult[0].values[0][0];
            lastInsertRowid = changesResult[0].values[0][1];
        }
        // After any INSERT, fetch the inserted row
        if (trimmed.startsWith('INSERT') && lastInsertRowid) {
            const tableMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);
            if (tableMatch) {
                const tableName = tableMatch[1];
                try {
                    // Try multiple approaches to get the inserted row
                    let rowResult = database.exec(`SELECT * FROM ${tableName} WHERE rowid = ?`, [Number(lastInsertRowid)]);
                    // If rowid approach didn't work, try getting the last row by ordering DESC
                    if (!rowResult.length || !rowResult[0].values.length) {
                        rowResult = database.exec(`SELECT * FROM ${tableName} ORDER BY rowid DESC LIMIT 1`);
                    }
                    if (rowResult.length > 0 && rowResult[0].values.length > 0) {
                        const columns = rowResult[0].columns;
                        const values = rowResult[0].values[0];
                        const row = {};
                        columns.forEach((col, i) => { row[col] = values[i]; });
                        saveDb();
                        return { rows: [row], changes, lastInsertRowid };
                    }
                }
                catch {
                    // ignore
                }
            }
        }
        // Save after write
        saveDb();
        return { rows: [], changes, lastInsertRowid };
    }
}
export function testConnection() {
    const database = getDb();
    database.exec('SELECT 1');
    logger.info('SQLite connection successful');
}
export async function end() {
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
        query: (sql, params = []) => query(sql, params),
        release: () => { },
    }),
    testConnection,
    end,
};
//# sourceMappingURL=pool.js.map