'use strict';

require('dotenv').config();
const assert = require('node:assert/strict');
const { isConfiguredDatabaseUrl } = require('../test/db-config');

async function main() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!isConfiguredDatabaseUrl(testDatabaseUrl)) {
    console.warn('TEST_DATABASE_URL is not configured or still contains placeholder values; skipping PostgreSQL test preflight.');
    return;
  }

  const database = new URL(testDatabaseUrl);
  assert.equal(
    database.pathname.replace(/^\/+/, ''),
    'kundu_market_test',
    'Refusing to run database tests outside the designated disposable kundu_market_test database.'
  );
  process.env.DATABASE_URL = testDatabaseUrl;
  const { checkDatabase, checkSchema, pool } = require('../server/db');
  try {
    const connection = await checkDatabase();
    assert.ok(connection.ok, 'Could not connect to the configured test database.');
    const schema = await checkSchema();
    assert.ok(
      schema.ok,
      `Test database schema is incomplete. Review and apply the required migrations to the isolated test database: ${schema.missing.join(', ')}`
    );
    console.log('Disposable PostgreSQL test database and schema are ready.');
  } finally {
    await pool.end();
  }
}

main().catch(function (error) {
  console.error('Test database preflight failed:', error.message);
  process.exitCode = 1;
});
