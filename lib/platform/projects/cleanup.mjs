import { transaction, withOwner } from './access.mjs';
import { projectStorage } from './storage.mjs';

export async function cleanupProjects(pool, { storageFor = projectStorage, batchSize = 100 } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError('Invalid cleanup batch size');
  const counts = { projects: 0, abandoned: 0, objects: 0, failed: 0, accounts: 0 };
  // Keyset batches also make progress past owners with permanent Premium storage.
  let after = '';
  for (;;) {
    const { rows } = await pool.query('SELECT DISTINCT w.owner_user_id AS owner FROM platform.projects p ' +
      'JOIN platform.workspaces w ON w.id=p.workspace_id WHERE p.expires_at<=clock_timestamp() AND w.owner_user_id>$1 ' +
      'ORDER BY w.owner_user_id LIMIT $2', [after, batchSize]);
    if (!rows.length) break;
    for (const { owner } of rows) {
      counts.projects += await withOwner(pool, owner, async ctx => {
        if (ctx.premium) return 0;
        const result = await ctx.db.query('DELETE FROM platform.projects p USING platform.workspaces w WHERE p.workspace_id=w.id AND w.owner_user_id=$1 AND p.expires_at<=$2', [ctx.owner, ctx.now]);
        return result.rowCount;
      }, true);
      after = owner;
    }
  }
  // In-flight writes hold the asset row. A crashed process releases it and its reservation ages out.
  for (;;) {
    const result = await pool.query('DELETE FROM platform.project_assets WHERE id IN (SELECT id FROM platform.project_assets ' +
      "WHERE NOT ready AND created_at < now() - interval '15 minutes' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)", [batchSize]);
    counts.abandoned += result.rowCount;
    if (result.rowCount < batchSize) break;
  }
  const { rows: [cutoff] } = await pool.query('SELECT clock_timestamp()::text AS now');
  // A failed deletion remains durable and receives a backoff. Other objects and owners still progress.
  for (;;) {
    const result = await transaction(pool, async db => {
      const { rows: [item] } = await db.query('SELECT asset_id,backend FROM platform.project_object_deletions ' +
        'WHERE retry_at<=$1 ORDER BY retry_at,asset_id LIMIT 1 FOR UPDATE SKIP LOCKED', [cutoff.now]);
      if (!item) return null;
      try { await storageFor(item.backend).remove(item.asset_id); }
      catch {
        await db.query('UPDATE platform.project_object_deletions SET attempts=attempts+1, ' +
          "retry_at=clock_timestamp()+ LEAST(3600, 30*(attempts+1))*interval '1 second' WHERE asset_id=$1", [item.asset_id]);
        return 'failed';
      }
      await db.query('DELETE FROM platform.project_object_deletions WHERE asset_id=$1', [item.asset_id]);
      return 'objects';
    });
    if (!result) break;
    counts[result]++;
  }
  const retired = await pool.query('UPDATE platform.account_deletions d SET projects_cleaned_at=clock_timestamp() ' +
    'WHERE projects_cleaned_at IS NULL AND NOT EXISTS (SELECT 1 FROM platform.project_object_deletions q WHERE q.owner_id=d.user_id)');
  counts.accounts = retired.rowCount;
  return counts;
}
