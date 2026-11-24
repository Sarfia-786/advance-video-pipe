import { randomUUID } from 'node:crypto';
import { requireFeature, validName, withWorkspace } from './access.mjs';
import { projectError, uuidPattern } from './validation.mjs';

export async function requireFolder(ctx,id) {
  if (id === null || id === undefined) return null;
  requireFeature(ctx,'folders');
  if (!uuidPattern.test(id)) throw projectError('FOLDER_NOT_FOUND',404);
  const {rowCount} = await ctx.db.query('SELECT 1 FROM platform.project_folders WHERE workspace_id=$1 AND id=$2',[ctx.workspace,id]);
  if (!rowCount) throw projectError('FOLDER_NOT_FOUND',404);
  return id;
}
export async function foldersIn(ctx) {
  if (!ctx.entitlements.capabilities.versionHistory) return [];
  const {rows} = await ctx.db.query('SELECT id,name,parent_id AS "parentId" FROM platform.project_folders WHERE workspace_id=$1 ORDER BY lower(name),id',[ctx.workspace]);
  return rows;
}
export function changeFolder(pool,actor,workspace,input) {
  return withWorkspace(pool,actor,workspace,'editor',async ctx => {
    requireFeature(ctx,'folders');
    const parent = await requireFolder(ctx,input.parentId);
    if (input.id === undefined) {
      const {rows:[folder]} = await ctx.db.query('INSERT INTO platform.project_folders(id,workspace_id,parent_id,name) '+
        'VALUES($1,$2,$3,$4) RETURNING id,name,parent_id AS "parentId"',[randomUUID(),ctx.workspace,parent,validName(input.name)]);
      return folder;
    }
    const id = await requireFolder(ctx,input.id);
    if (!id) throw projectError('FOLDER_NOT_FOUND',404);
    if (input.action === 'delete') {
      const {rows:[state]} = await ctx.db.query('SELECT EXISTS(SELECT 1 FROM platform.project_folders WHERE parent_id=$1) '+
        'OR EXISTS(SELECT 1 FROM platform.projects WHERE folder_id=$1) AS occupied',[id]);
      if (state.occupied) throw projectError('FOLDER_NOT_EMPTY',409);
      await ctx.db.query('DELETE FROM platform.project_folders WHERE id=$1',[id]);
      return {deleted:true};
    }
    // Walk upwards from the proposed parent under the owner lock, before any write.
    const {rows:[tree]} = await ctx.db.query('WITH RECURSIVE parents AS (SELECT id,parent_id FROM platform.project_folders WHERE id=$1 ' +
      'UNION SELECT f.id,f.parent_id FROM platform.project_folders f JOIN parents p ON f.id=p.parent_id) '+
      'SELECT EXISTS(SELECT 1 FROM parents WHERE id=$2) AS cycle',[parent,id]);
    if (tree.cycle) throw projectError('FOLDER_CYCLE',409);
    const {rows:[folder]} = await ctx.db.query('UPDATE platform.project_folders SET '+
      'name=COALESCE($2,name),parent_id=CASE WHEN $3 THEN $4::uuid ELSE parent_id END WHERE id=$1 RETURNING id,name,parent_id AS "parentId"',
      [id,input.name === undefined ? null : validName(input.name),Object.hasOwn(input,'parentId'),parent]);
    return folder;
  });
}
