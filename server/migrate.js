require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('./db');

const MIGRATIONS_PATH = path.join(__dirname, 'migrations');
const MIGRATION_LOCK_ID = 781924631;

async function migrate() {
  const initializeSchema = process.argv.includes('--initialize-schema');
  const files = fs.readdirSync(MIGRATIONS_PATH)
    .filter(function (file) { return /^\d{3}_[a-z0-9_]+\.sql$/.test(file); })
    .sort();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    if (initializeSchema) {
      const schemaPath = path.join(__dirname, 'postgres-schema.sql');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8')
        .replace(/^\s*BEGIN;\s*/i, '')
        .replace(/\s*COMMIT;\s*$/i, '');
      await client.query(schemaSql);
    }
    const baseSchema = await client.query(
      `SELECT to_regclass('public.users') AS users, to_regclass('public.orders') AS orders`
    );
    if (!baseSchema.rows[0].users || !baseSchema.rows[0].orders) {
      throw new Error('Base schema is missing. Apply server/postgres-schema.sql before migrations.');
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version VARCHAR(100) PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );

    for (const file of files) {
      const existing = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file]
      );
      if (existing.rows.length) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_PATH, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      console.log(`Applied database migration ${file}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(function (error) {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
