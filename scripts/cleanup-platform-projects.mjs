import { setTimeout as delay } from 'node:timers/promises';
import { pool } from '../lib/platform/accounts/auth.mjs';
import { cleanupProjects } from '../lib/platform/projects/cleanup.mjs';

const watch = process.argv[2] === '--watch';
if (process.argv.length > (watch ? 3 : 2)) throw new Error('Usage: cleanup-platform-projects.mjs [--watch]');
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  do {
    try {
      const result = await cleanupProjects(pool);
      console.log(JSON.stringify(result));
      if (!watch && result.failed) process.exitCode = 1;
    } catch (error) {
      if (!watch) throw error;
      console.error('project_cleanup_failed', { name: error.name });
    }
    if (!watch || stop.signal.aborted) break;
    try { await delay(5 * 60 * 1000, undefined, { signal: stop.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  } while (!stop.signal.aborted);
} finally { await pool.end(); }
