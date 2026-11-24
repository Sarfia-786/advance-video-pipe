import { projectError } from './validation.mjs';

export const projectColumns = 'id,name,revision,folder_id AS "folderId",created_at AS "createdAt",updated_at AS "updatedAt",expires_at AS "expiresAt"';
export const assetColumns = 'a.id,l.project_id AS "projectId",a.project_id AS "sourceProjectId",a.filename,a.kind,' +
  'a.media_type AS "mediaType",a.byte_size AS "byteSize",a.job_id AS "jobId",a.created_at AS "createdAt"';
export const linkedAssets = ' FROM platform.project_asset_links l JOIN platform.project_assets a ON a.id=l.asset_id ';
export function visible(project, ctx) {
  return { ...project, expiresAt:ctx.premium ? null : project.expiresAt };
}
export async function readProject(ctx,id,content=false) {
  const fields = projectColumns + (content ? ',document,script' : '');
  const {rows:[project]} = await ctx.db.query('SELECT '+fields+' FROM platform.projects WHERE workspace_id=$1 AND id=$2',[ctx.workspace,id]);
  if (!project) throw projectError('PROJECT_NOT_FOUND',404);
  if (!ctx.premium && project.expiresAt <= ctx.now) throw projectError('PROJECT_EXPIRED',410);
  return visible(project,ctx);
}
export async function storageUsed(ctx) {
  const {rows:[usage]} = await ctx.db.query(
    'WITH owned AS (SELECT p.* FROM platform.projects p JOIN platform.workspaces w ON w.id=p.workspace_id WHERE w.owner_user_id=$1) ' +
    'SELECT (SELECT COALESCE(sum(octet_length(script)+octet_length(document::text)),0) FROM owned) + ' +
    '(SELECT COALESCE(sum(octet_length(v.script)+octet_length(v.document::text)),0) FROM platform.project_versions v JOIN owned p ON p.id=v.project_id) + ' +
    '(SELECT COALESCE(sum(byte_size),0) FROM platform.project_assets WHERE owner_id=$1) AS bytes',[ctx.owner]);
  return Number(usage.bytes);
}
export async function requireQuota(ctx, added=0) {
  if ((await storageUsed(ctx))+added>ctx.quotaBytes) throw projectError('STORAGE_QUOTA',409);
}
export function checkRevision(project, expected) {
  if (expected !== project.revision) throw projectError('PROJECT_CHANGED',409);
}
export async function rememberVersion(ctx,id) {
  if (!ctx.entitlements.capabilities.versionHistory) return;
  const {rows:[version]} = await ctx.db.query('INSERT INTO platform.project_versions(project_id,revision,name,script,document) ' +
    'SELECT id,revision,name,script,document FROM platform.projects WHERE id=$1 ON CONFLICT DO NOTHING RETURNING revision',[id]);
  if (version) await ctx.db.query('INSERT INTO platform.project_version_assets(project_id,revision,asset_id) ' +
    'SELECT l.project_id,$2,a.id'+linkedAssets+'WHERE l.project_id=$1 AND a.ready',[id,version.revision]);
}
export async function recordAssetChange(ctx,id) {
  if (ctx.entitlements.capabilities.versionHistory) {
    await ctx.db.query('UPDATE platform.projects SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[id]);
    await rememberVersion(ctx,id);
    await requireQuota(ctx);
  }
  const {rows:[project]} = await ctx.db.query('SELECT revision FROM platform.projects WHERE id=$1',[id]);
  return project.revision;
}
