import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../../data/hedwig-bench.db');

let db;

/**
 * Initialize the SQLite database and create the runs table if it doesn't exist.
 */
export function initDatabase() {
  // Ensure the data directory exists
  mkdirSync(dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      config JSON NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      summary JSON,
      timeseries JSON
    )
  `);

  return db;
}

/**
 * Insert a new run with status 'running' and the current timestamp.
 */
export function createRun(id, config) {
  const stmt = db.prepare(`
    INSERT INTO runs (id, config, status, started_at)
    VALUES (?, ?, 'running', ?)
  `);
  stmt.run(id, JSON.stringify(config), new Date().toISOString());
}

/**
 * Update a run's status and optionally its completed_at timestamp.
 */
export function updateRunStatus(id, status, completedAt) {
  const stmt = db.prepare(`
    UPDATE runs SET status = ?, completed_at = ? WHERE id = ?
  `);
  stmt.run(status, completedAt ?? null, id);
}

/**
 * Update a run's summary and timeseries JSON fields.
 */
export function updateRunResults(id, summary, timeseries) {
  const stmt = db.prepare(`
    UPDATE runs SET summary = ?, timeseries = ? WHERE id = ?
  `);
  stmt.run(JSON.stringify(summary), JSON.stringify(timeseries), id);
}

/**
 * Parse JSON fields on a raw run row.
 */
function parseRunRow(row) {
  if (!row) return null;
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
    summary: row.summary ? (typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary) : null,
    timeseries: row.timeseries ? (typeof row.timeseries === 'string' ? JSON.parse(row.timeseries) : row.timeseries) : null,
  };
}

/**
 * Get a single run by ID, with all JSON fields parsed.
 */
export function getRun(id) {
  const stmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const row = stmt.get(id);
  return parseRunRow(row);
}

/**
 * Get all runs with JSON fields parsed, but WITHOUT timeseries (too large for listing).
 */
export function getAllRuns() {
  const stmt = db.prepare(
    'SELECT id, config, status, started_at, completed_at, summary FROM runs ORDER BY started_at DESC'
  );
  const rows = stmt.all();
  return rows.map((row) => ({
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
    summary: row.summary ? (typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary) : null,
  }));
}

/**
 * Delete a run by ID.
 */
export function deleteRun(id) {
  const stmt = db.prepare('DELETE FROM runs WHERE id = ?');
  stmt.run(id);
}
