import { randomUUID } from 'node:crypto';
import { getEntitlements } from '../entitlements/policy.mjs';
import { MiB, projectError, uuidPattern, validateAsset, validateProject } from './validation.mjs';
import { projectStorage } from './storage.mjs';

export async function transaction(pool, action) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await action(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

// Billing updates, quota reservations and expiry decisions serialize on the same profile.
export function withOwner(pool, owner, action, allowMissing = false) {
  return transaction(pool, async db => {
    const { rows } = await db.query(
      'SELECT p.plan, p.subscription_status AS "subscriptionStatus", p.access_until AS "accessUntil", ' +
      'w.id AS workspace FROM platform.user_profiles p JOIN platform.workspaces w ' +
      "ON w.owner_user_id=p.user_id AND w.kind='personal' WHERE p.user_id=$1 FOR UPDATE OF p", [owner]);
    if (!rows.length) {
      if (allowMissing) return 0;
      throw projectError('ACCOUNT_NOT_READY', 503);
    }
    const { rows: [clock] } = await db.query('SELECT clock_timestamp() AS now');
    const entitlement = getEntitlements(rows[0], clock.now.getTime());
    return action({ db, owner, workspace: rows[0].workspace, now: clock.now, premium: entitlement.plan === 'premium',
      quotaBytes: entitlement.limits.storageMiB * MiB });
  });
}

const columns = 'id, name, revision, created_at AS "createdAt", updated_at AS "updatedAt", expires_at AS "expiresAt"';
const assetColumns = 'id, project_id AS "projectId", filename, kind, media_type AS "mediaType", byte_size AS "byteSize", ' +
  'job_id AS "jobId", created_at AS "createdAt"';
function visible(project, ctx) {
  return { ...project, expiresAt: ctx.premium ? null : project.expiresAt };
}
async function ownedProject(ctx, id) {
  if (!uuidPattern.test(id)) throw projectError('PROJECT_NOT_FOUND', 404);
  const { rows: [project] } = await ctx.db.query('SELECT ' + columns + ', document, script FROM platform.projects ' +
    'WHERE workspace_id=$1 AND id=$2', [ctx.workspace, id]);
  if (!project) throw projectError('PROJECT_NOT_FOUND', 404);
  if (!ctx.premium && project.expiresAt <= ctx.now) throw projectError('PROJECT_EXPIRED', 410);
  return visible(project, ctx);
}
async function storageUsed(ctx) {
  const { rows: [usage] } = await ctx.db.query(
    'SELECT (SELECT COALESCE(sum(octet_length(script) + octet_length(document::text)),0) FROM platform.projects WHERE workspace_id=$1) ' +
    '+ (SELECT COALESCE(sum(a.byte_size),0) FROM platform.project_assets a JOIN platform.projects p ON p.id=a.project_id WHERE p.workspace_id=$1) AS bytes',
    [ctx.workspace]);
  return Number(usage.bytes);
}
async function requireQuota(ctx, addedBytes = 0) {
  if ((await storageUsed(ctx)) + addedBytes > ctx.quotaBytes) throw projectError('STORAGE_QUOTA', 409);
}

export function listProjects(pool, owner) {
  return withOwner(pool, owner, async ctx => {
    const { rows } = await ctx.db.query('SELECT ' + columns + ' FROM platform.projects WHERE workspace_id=$1 ' +
      'AND ($2 OR expires_at>$3) ORDER BY updated_at DESC, id', [ctx.workspace, ctx.premium, ctx.now]);
    return { projects: rows.map(row => visible(row, ctx)), usedBytes: await storageUsed(ctx), quotaBytes: ctx.quotaBytes };
  });
}
export function createProject(pool, owner, input) {
  const { name, document, script } = validateProject(input);
  const days = getEntitlements({ plan: 'free' }).limits.projectExpiryDays;
  return withOwner(pool, owner, async ctx => {
    const { rows: [row] } = await ctx.db.query('INSERT INTO platform.projects(id,workspace_id,name,document,script,created_at,updated_at,expires_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$6,$6::timestamptz + $7 * interval '24 hours') RETURNING " + columns + ', document, script',
      [randomUUID(), ctx.workspace, name, document, script, ctx.now, days]);
    await requireQuota(ctx);
    return visible(row, ctx);
  });
}
export function getProject(pool, owner, id) {
  return withOwner(pool, owner, async ctx => {
    const project = await ownedProject(ctx, id);
    const { rows: assets } = await ctx.db.query('SELECT ' + assetColumns + ' FROM platform.project_assets ' +
      'WHERE project_id=$1 AND ready ORDER BY created_at, id', [id]);
    return { ...project, assets };
  });
}
export function updateProject(pool, owner, id, input) {
  return withOwner(pool, owner, async ctx => {
    const current = await ownedProject(ctx, id);
    const { name, script, document } = validateProject(input);
    if (current.revision !== input.revision) throw projectError('PROJECT_CHANGED', 409);
    const { rows: [row] } = await ctx.db.query('UPDATE platform.projects SET name=$2, document=$3, script=$4, ' +
      'revision=revision+1, updated_at=clock_timestamp() WHERE id=$1 RETURNING ' + columns + ', document, script',
      [id, name, document, script]);
    await requireQuota(ctx);
    return visible(row, ctx);
  });
}
export function deleteProject(pool, owner, id) {
  return withOwner(pool, owner, async ctx => {
    await ownedProject(ctx, id);
    await ctx.db.query('DELETE FROM platform.projects WHERE id=$1', [id]);
  });
}

// Only trusted generation workers supply jobId. HTTP uploads only pass file metadata.
export async function saveProjectAsset(pool, owner, projectId, metadata, bytes, { jobId = null, storage = projectStorage() } = {}) {
  const { filename, kind, mediaType } = validateAsset(metadata, bytes);
  if (jobId !== null && (typeof jobId !== 'string' || !jobId.trim() || jobId.length > 256)) throw projectError('INVALID_JOB');
  const id = randomUUID();
  await withOwner(pool, owner, async ctx => {
    await ownedProject(ctx, projectId);
    await requireQuota(ctx, bytes.length);
    await ctx.db.query('INSERT INTO platform.project_assets(id,project_id,owner_id,backend,filename,kind,media_type,byte_size,job_id) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, projectId, owner, storage.backend, filename, kind, mediaType, bytes.length, jobId]);
  });
  try {
    // Commit the reservation first so even a process crash after put leaves durable cleanup work.
    return await withOwner(pool, owner, async ctx => {
      await ownedProject(ctx, projectId);
      const pending = await ctx.db.query('SELECT id FROM platform.project_assets WHERE id=$1 AND NOT ready FOR UPDATE', [id]);
      if (!pending.rowCount) throw projectError('UPLOAD_EXPIRED', 409);
      await storage.put(id, bytes, mediaType);
      const { rows: [row] } = await ctx.db.query('UPDATE platform.project_assets SET ready=true WHERE id=$1 RETURNING ' + assetColumns, [id]);
      return row;
    });
  } catch (error) {
    await pool.query('DELETE FROM platform.project_assets WHERE id=$1 AND NOT ready', [id]);
    throw error;
  }
}
export function getPrivateAsset(pool, owner, projectId, assetId) {
  return withOwner(pool, owner, async ctx => {
    const project = await ownedProject(ctx, projectId);
    if (!uuidPattern.test(assetId)) throw projectError('ASSET_NOT_FOUND', 404);
    const { rows: [asset] } = await ctx.db.query('SELECT ' + assetColumns + ', backend FROM platform.project_assets ' +
      'WHERE project_id=$1 AND id=$2 AND ready', [projectId, assetId]);
    if (!asset) throw projectError('ASSET_NOT_FOUND', 404);
    return { asset, project, now: ctx.now };
  });
}
