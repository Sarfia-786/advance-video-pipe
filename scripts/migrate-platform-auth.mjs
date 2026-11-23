import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { auth, assertAuthConfigured, pool } from '../lib/platform/accounts/auth.mjs';

assertAuthConfigured();
const db = await pool.connect();
const sql = name => readFile(new URL('../db/migrations/' + name, import.meta.url), 'utf8');
try {
  // Hold the lock across the vendor migration, which uses its own connections.
  await db.query("SELECT pg_advisory_lock(hashtextextended('platform.account.migrations', 0))");
  await db.query(await sql('0001_platform_accounts.sql'));
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  await db.query(await sql('0002_account_lifecycle.sql'));
  await db.query(await sql('0003_platform_entitlements.sql'));
  // Projects depend on accounts and entitlements and have their own replay-safe schema.
  await db.query(await sql('0006_private_projects.sql'));
  await db.query(await sql('0004_credit_ledger.sql'));
  console.log('Platform account, entitlements and credit ledger migrations applied');
} finally {
  db.release(true);
  await pool.end();
}
