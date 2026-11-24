import { randomUUID } from 'node:crypto';
import { getEntitlements, resolveSubscription } from '../entitlements/policy.mjs';
import { publicScope, withProject, withWorkspace } from './access.mjs';
import { foldersIn, requireFolder } from './folders.mjs';
import { assetColumns, checkRevision, linkedAssets, projectColumns as columns, readProject as ownedProject, recordAssetChange,
  rememberVersion, requireQuota, storageUsed, visible } from './state.mjs';
import { projectError, uuidPattern, validateAsset, validateProject } from './validation.mjs';
import { projectStorage } from './storage.mjs';

export function listProjects(pool, actor, { workspaceId, q = '', folder, kind = '' } = {}) {
  return withWorkspace(pool, actor, workspaceId, 'viewer', async ctx => {
    if (typeof q !== 'string' || q.length > 200 || q.includes('\0') || !q.isWellFormed() ||
        !['','script','media','subtitle','thumbnail','brand','render'].includes(kind)) throw projectError('INVALID_FILTER');
    const folderId = folder && folder !== 'root' ? await requireFolder(ctx, folder) : null;
    const { rows } = await ctx.db.query('SELECT ' + columns + ' FROM platform.projects p WHERE workspace_id=$1 AND ($2 OR expires_at>$3) ' +
      'AND strpos(lower(name),lower($4))>0 AND ($5 OR folder_id IS NOT DISTINCT FROM $6::uuid) ' +
      "AND ($7='' OR EXISTS(SELECT 1" + linkedAssets + 'WHERE l.project_id=p.id AND a.ready AND a.kind=$7)) ORDER BY updated_at DESC,id',
      [ctx.workspace, ctx.premium, ctx.now, q, !folder, folderId, kind]);
    return { projects: rows.map(row => visible(row, ctx)), folders: await foldersIn(ctx), ...publicScope(ctx),
      usedBytes: await storageUsed(ctx), quotaBytes: ctx.quotaBytes };
  });
}
export function createProject(pool, owner, input) {
  const { name, document, script } = validateProject(input);
  const days = getEntitlements({ plan: 'free' }).limits.projectExpiryDays;
  return withWorkspace(pool, owner, input.workspaceId, 'editor', async ctx => {
    const folder = await requireFolder(ctx,input.folderId);
    const { rows: [row] } = await ctx.db.query('INSERT INTO platform.projects(id,workspace_id,name,document,script,created_at,updated_at,expires_at,folder_id) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$6,$6::timestamptz + $7 * interval '24 hours',$8) RETURNING " + columns + ', document, script',
      [randomUUID(), ctx.workspace, name, document, script, ctx.now, days, folder]);
    await rememberVersion(ctx,row.id);
    await requireQuota(ctx);
    return visible(row, ctx);
  });
}
export function requireProjectAccess(pool, owner, id, minRole = 'viewer') {
  return withProject(pool, owner, id, minRole, ctx => ownedProject(ctx, id));
}
export function getProject(pool, owner, id) {
  return withProject(pool, owner, id, 'viewer', async ctx => {
    const project = await ownedProject(ctx, id, true);
    const { rows: assets } = await ctx.db.query('SELECT ' + assetColumns + linkedAssets + 'WHERE l.project_id=$1 AND a.ready ORDER BY a.created_at,a.id', [id]);
    return { ...project, assets, ...publicScope(ctx), folders: await foldersIn(ctx) };
  });
}
export function updateProject(pool, owner, id, input) {
  return withProject(pool, owner, id, 'editor', async ctx => {
    const current = await ownedProject(ctx, id);
    const { name, script, document } = validateProject(input);
    checkRevision(current,input.revision);
    await rememberVersion(ctx,id);
    const { rows: [row] } = await ctx.db.query('UPDATE platform.projects SET name=$2, document=$3, script=$4, ' +
      'revision=revision+1, updated_at=clock_timestamp() WHERE id=$1 RETURNING ' + columns + ', document, script',
      [id, name, document, script]);
    await rememberVersion(ctx,id);
    await requireQuota(ctx);
    return visible(row, ctx);
  });
}
export function deleteProject(pool, owner, id) {
  return withProject(pool, owner, id, 'editor', async ctx => {
    await ownedProject(ctx, id);
    await ctx.db.query('DELETE FROM platform.projects WHERE id=$1', [id]);
  });
}

// Only trusted generation workers supply jobId. HTTP uploads only pass file metadata.
export async function saveProjectAsset(pool, owner, projectId, metadata, bytes, { jobId = null, storage = projectStorage() } = {}) {
  const { filename, kind, mediaType } = validateAsset(metadata, bytes);
  if (jobId !== null && (typeof jobId !== 'string' || !jobId.trim() || jobId.length > 256)) throw projectError('INVALID_JOB');
  const id = randomUUID();
  await withProject(pool, owner, projectId, 'editor', async ctx => {
    await ownedProject(ctx, projectId);
    await requireQuota(ctx, bytes.length);
    await ctx.db.query('INSERT INTO platform.project_assets(id,project_id,owner_id,backend,filename,kind,media_type,byte_size,job_id) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, projectId, ctx.owner, storage.backend, filename, kind, mediaType, bytes.length, jobId]);
  });
  try {
    // Commit the reservation first so even a process crash after put leaves durable cleanup work.
    return await withProject(pool, owner, projectId, 'editor', async ctx => {
      await ownedProject(ctx, projectId);
      const pending = await ctx.db.query('SELECT a.id' + linkedAssets + 'WHERE a.id=$1 AND l.project_id=$2 AND NOT a.ready FOR UPDATE OF a', [id,projectId]);
      if (!pending.rowCount) throw projectError('UPLOAD_EXPIRED', 409);
      await rememberVersion(ctx,projectId);
      await storage.put(id, bytes, mediaType);
      const { rows: [clock] } = await ctx.db.query('SELECT clock_timestamp() AS now');
      const subscription = resolveSubscription(ctx.profile, clock.now.getTime());
      if (ctx.kind === 'team' && subscription.plan !== 'premium') throw projectError('PLAN_REQUIRED',403);
      await ownedProject({ ...ctx, now: clock.now, premium: subscription.plan === 'premium' }, projectId);
      await ctx.db.query('UPDATE platform.project_assets SET ready=true WHERE id=$1', [id]);
      const { rows: [row] } = await ctx.db.query('SELECT ' + assetColumns + linkedAssets + 'WHERE a.id=$1 AND l.project_id=$2',[id,projectId]);
      return { ...row, projectRevision: await recordAssetChange(ctx,projectId) };
    });
  } catch (error) {
    await pool.query('DELETE FROM platform.project_assets WHERE id=$1 AND NOT ready', [id]);
    throw error;
  }
}
export function getPrivateAsset(pool, owner, projectId, assetId) {
  return withProject(pool, owner, projectId, 'viewer', async ctx => {
    const project = await ownedProject(ctx, projectId);
    if (!uuidPattern.test(assetId)) throw projectError('ASSET_NOT_FOUND', 404);
    const { rows: [asset] } = await ctx.db.query('SELECT ' + assetColumns + ',a.backend' + linkedAssets + 'WHERE l.project_id=$1 AND a.id=$2 AND a.ready', [projectId, assetId]);
    if (!asset) throw projectError('ASSET_NOT_FOUND', 404);
    return { asset, project, now: ctx.now };
  });
}

export function removeAsset(pool, owner, projectId, assetId) {
  return withProject(pool, owner, projectId, 'editor', async ctx => {
    await ownedProject(ctx, projectId);
    if (!uuidPattern.test(assetId)) throw projectError('ASSET_NOT_FOUND', 404);
    await rememberVersion(ctx,projectId);
    const removed = await ctx.db.query('DELETE FROM platform.project_asset_links l USING platform.project_assets a ' +
      'WHERE l.asset_id=$1 AND l.project_id=$2 AND a.id=l.asset_id AND a.ready', [assetId, projectId]);
    if (!removed.rowCount) throw projectError('ASSET_NOT_FOUND', 404);
    return recordAssetChange(ctx,projectId);
  });
}
