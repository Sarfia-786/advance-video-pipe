import { pool } from '../lib/platform/accounts/auth.mjs';
import { cleanupProjects } from '../lib/platform/projects/cleanup.mjs';

try {
  const result = await cleanupProjects(pool);
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} finally { await pool.end(); }
