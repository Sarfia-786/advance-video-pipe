import { randomUUID } from 'node:crypto';
import { getEntitlements } from '../entitlements/policy.mjs';
import { lockWorkspace, publicScope, requireFeature, validName, withProject } from './access.mjs';
import { requireFolder } from './folders.mjs';
import { checkRevision, linkedAssets, readProject, rememberVersion, requireQuota } from './state.mjs';
import { projectError } from './validation.mjs';

export function projectHistory(pool,actor,id) {
  return withProject(pool,actor,id,'viewer',async ctx => {
    await readProject(ctx,id);
    requireFeature(ctx,'versionHistory');
    const {rows} = await ctx.db.query('SELECT v.revision,v.name,v.created_at AS "createdAt",count(a.asset_id)::int AS "fileCount" '+
      'FROM platform.project_versions v LEFT JOIN platform.project_version_assets a USING(project_id,revision) '+
      'WHERE v.project_id=$1 GROUP BY v.project_id,v.revision ORDER BY v.revision DESC',[id]);
    return {versions:rows};
  });
}
export function restoreVersion(pool,actor,id,input) {
  return withProject(pool,actor,id,'editor',async ctx => {
    const project = await readProject(ctx,id);
    requireFeature(ctx,'versionHistory');
    checkRevision(project,input.revision);
    if (!Number.isSafeInteger(input.version) || input.version<1) throw projectError('VERSION_NOT_FOUND',404);
    const {rows:[version]} = await ctx.db.query('SELECT revision FROM platform.project_versions WHERE project_id=$1 AND revision=$2',[id,input.version]);
    if (!version) throw projectError('VERSION_NOT_FOUND',404);
    await rememberVersion(ctx,id);
    await ctx.db.query('INSERT INTO platform.project_asset_links(project_id,asset_id) '+
      'SELECT project_id,asset_id FROM platform.project_version_assets WHERE project_id=$1 AND revision=$2 ON CONFLICT DO NOTHING',[id,input.version]);
    // Ignore pending uploads. Their own finalization will become a later revision.
    await ctx.db.query('DELETE FROM platform.project_asset_links l USING platform.project_assets a WHERE l.project_id=$1 AND l.asset_id=a.id AND a.ready '+
      'AND NOT EXISTS(SELECT 1 FROM platform.project_version_assets v WHERE v.project_id=$1 AND v.revision=$2 AND v.asset_id=l.asset_id)',[id,input.version]);
    await ctx.db.query('UPDATE platform.projects p SET name=v.name,script=v.script,document=v.document,revision=p.revision+1,updated_at=clock_timestamp() '+
      'FROM platform.project_versions v WHERE p.id=$1 AND v.project_id=p.id AND v.revision=$2',[id,input.version]);
    await rememberVersion(ctx,id);
    await requireQuota(ctx);
    return readProject(ctx,id,true);
  });
}
async function destination(ctx,workspace) {
  if (workspace === undefined || workspace === ctx.workspace) return ctx;
  // Cross-workspace transfers change the audience and stay within one billing owner.
  if (ctx.role !== 'owner' || ctx.actor !== ctx.owner) throw projectError('ROLE_REQUIRED',403);
  const {rowCount} = await ctx.db.query('SELECT 1 FROM platform.workspaces WHERE id=$1 AND owner_user_id=$2',[workspace,ctx.owner]);
  if (!rowCount) throw projectError('WORKSPACE_NOT_FOUND',404);
  return lockWorkspace(ctx.db,ctx.actor,workspace,{minRole:'owner'});
}
export function placeProject(pool,actor,id,input) {
  return withProject(pool,actor,id,'editor',async ctx => {
    const source = await readProject(ctx,id,true);
    checkRevision(source,input.revision);
    const target = await destination(ctx,input.workspaceId);
    const folderId = await requireFolder(target,input.folderId === undefined && target.workspace===ctx.workspace ? source.folderId : input.folderId);
    let targetId = id;
    if (input.action === 'move') {
      await rememberVersion(ctx,id);
      await ctx.db.query('UPDATE platform.projects SET workspace_id=$2,folder_id=$3,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1',
        [id,target.workspace,folderId]);
    } else if (input.action === 'duplicate') {
      targetId = randomUUID();
      const days = getEntitlements({plan:'free'}).limits.projectExpiryDays;
      await ctx.db.query('INSERT INTO platform.projects(id,workspace_id,folder_id,name,script,document,created_at,updated_at,expires_at) '+
        "SELECT $2,$3,$4,$5,script,document,$6,$6,$6::timestamptz+$7*interval '24 hours' FROM platform.projects WHERE id=$1",
        [id,targetId,target.workspace,folderId,validName(input.name ?? source.name),ctx.now,days]);
      await ctx.db.query('INSERT INTO platform.project_asset_links(project_id,asset_id) SELECT $2,a.id'+linkedAssets+'WHERE l.project_id=$1 AND a.ready',[id,targetId]);
    } else throw projectError('INVALID_PROJECT_ACTION');
    await rememberVersion(target,targetId);
    await requireQuota(target);
    return {...await readProject(target,targetId,true),...publicScope(target)};
  });
}
