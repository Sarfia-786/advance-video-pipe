// The Better Auth migration generator owns its user, account, session,
// verification and rate-limit tables; do not hand-maintain their crypto schema.
import { getMigrations } from 'better-auth/db/migration';
import { auth, assertAuthConfigured, pool } from '../lib/platform/accounts/auth.mjs';

assertAuthConfigured();
const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(auth.options);
console.log('Better Auth migration:', toBeCreated.length, 'tables to create,', toBeAdded.length, 'changes to add');
await runMigrations();
console.log('Better Auth schema is current');
await pool.end();
