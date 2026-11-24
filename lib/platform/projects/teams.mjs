import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getEntitlements } from '../entitlements/policy.mjs';
import { lockWorkspace, requireFeature, transaction, validName, withWorkspace } from './access.mjs';
import { projectError, uuidPattern } from './validation.mjs';

export async function listWorkspaces(pool,actor) {
  const {rows} = await pool.query('SELECT w.id,w.name,w.kind,m.role,p.plan,p.subscription_status AS "subscriptionStatus",p.access_until AS "accessUntil" ' +
    'FROM platform.workspace_members m JOIN platform.workspaces w ON w.id=m.workspace_id JOIN platform.user_profiles p ON p.user_id=w.owner_user_id ' +
    "WHERE m.user_id=$1 ORDER BY (w.kind='personal') DESC,lower(w.name),w.id",[actor]);
  const workspaces = [];
  let canCreateTeam = false;
  for (const row of rows) {
    const accessible = getEntitlements(row).capabilities.teamWorkspaces;
    if (row.kind==='personal') canCreateTeam = accessible;
    if (row.kind==='personal' || accessible) workspaces.push({id:row.id,name:row.name,kind:row.kind,role:row.role});
  }
  return {workspaces,canCreateTeam};
}
export function createTeam(pool,actor,name) {
  return withWorkspace(pool,actor,null,'owner',async ctx => {
    requireFeature(ctx,'teamWorkspaces');
    const id = randomUUID();
    const {rows:[team]} = await ctx.db.query("INSERT INTO platform.workspaces(id,owner_user_id,kind,name) VALUES($1,$2,'team',$3) RETURNING id,name,kind",
      [id,ctx.owner,validName(name)]);
    await ctx.db.query("INSERT INTO platform.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[id,actor]);
    return {...team,role:'owner'};
  });
}
function manage(pool,actor,id,action) {
  if (!id) throw projectError('WORKSPACE_NOT_FOUND',404);
  return withWorkspace(pool,actor,id,'owner',async ctx => {
    if (ctx.kind!=='team') throw projectError('WORKSPACE_NOT_FOUND',404);
    return action(ctx);
  });
}
const invitationFields = 'id,email,role,expires_at AS "expiresAt"';
export function teamManagement(pool,actor,id) {
  return manage(pool,actor,id,async ctx => {
    const {rows:members} = await ctx.db.query('SELECT m.user_id AS id,m.role,u.name,u.email FROM platform.workspace_members m ' +
      'JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.joined_at,m.user_id',[id]);
    const {rows:invitations} = await ctx.db.query('SELECT '+invitationFields+' FROM platform.workspace_invitations WHERE workspace_id=$1 AND expires_at>$2 ORDER BY email',[id,ctx.now]);
    return {members,invitations};
  });
}
function memberRole(role) {
  if (role!=='editor' && role!=='viewer') throw projectError('INVALID_ROLE');
  return role;
}
export function changeMember(pool,actor,id,input) {
  return manage(pool,actor,id,async ctx => {
    if (input.memberId===ctx.owner) throw projectError('OWNER_ROLE_FIXED',409);
    if (typeof input.memberId!=='string' || !input.memberId || input.memberId.length>256) throw projectError('MEMBER_NOT_FOUND',404);
    const result = input.action==='remove' ?
      await ctx.db.query('DELETE FROM platform.workspace_members WHERE workspace_id=$1 AND user_id=$2',[id,input.memberId]) :
      await ctx.db.query('UPDATE platform.workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[id,input.memberId,memberRole(input.role)]);
    if (!result.rowCount) throw projectError('MEMBER_NOT_FOUND',404);
    return {updated:true};
  });
}
const hashToken = token => createHash('sha256').update(token).digest('hex');
export function inviteMember(pool,actor,id,input) {
  return manage(pool,actor,id,async ctx => {
    const email = typeof input.email==='string' ? input.email.trim().toLowerCase() : '';
    if (email.length>254 || !/^[a-z0-9.!#$%&'*+/=?^_{}|~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email)) throw projectError('INVALID_EMAIL');
    const role = memberRole(input.role);
    const exists = await ctx.db.query('SELECT 1 FROM platform.workspace_members m JOIN "user" u ON u.id=m.user_id '+
      'WHERE m.workspace_id=$1 AND lower(u.email)=$2',[id,email]);
    if (exists.rowCount) throw projectError('ALREADY_MEMBER',409);
    const token = randomBytes(32).toString('base64url');
    const {rows:[invitation]} = await ctx.db.query('INSERT INTO platform.workspace_invitations(id,workspace_id,email,role,token_hash,expires_at) '+
      "VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '168 hours') ON CONFLICT(workspace_id,email) DO UPDATE "+
      'SET role=excluded.role,token_hash=excluded.token_hash,expires_at=excluded.expires_at RETURNING '+invitationFields,[randomUUID(),id,email,role,hashToken(token)]);
    return {...invitation,token};
  });
}
export function cancelInvitation(pool,actor,id,invitationId) {
  return manage(pool,actor,id,async ctx => {
    if (!uuidPattern.test(invitationId)) throw projectError('INVITATION_NOT_FOUND',404);
    const result = await ctx.db.query('DELETE FROM platform.workspace_invitations WHERE workspace_id=$1 AND id=$2',[id,invitationId]);
    if (!result.rowCount) throw projectError('INVITATION_NOT_FOUND',404);
    return {canceled:true};
  });
}
export function acceptInvitation(pool,actor,token) {
  if (typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.reject(projectError('INVITATION_NOT_FOUND',404));
  const digest = hashToken(token);
  return transaction(pool,async db => {
    const {rows:[target]} = await db.query('SELECT workspace_id FROM platform.workspace_invitations WHERE token_hash=$1',[digest]);
    if (!target) throw projectError('INVITATION_NOT_FOUND',404);
    const ctx = await lockWorkspace(db,actor,target.workspace_id,{invitation:true,missing:'INVITATION_NOT_FOUND'});
    const {rows:[invite]} = await db.query('DELETE FROM platform.workspace_invitations i USING "user" u WHERE i.workspace_id=$1 AND i.token_hash=$2 ' +
      'AND i.expires_at>clock_timestamp() AND u.id=$3 AND u."emailVerified" AND lower(u.email)=i.email RETURNING i.role',
      [ctx.workspace,digest,actor]);
    if (!invite || ctx.kind!=='team') throw projectError('INVITATION_NOT_FOUND',404);
    await db.query('INSERT INTO platform.workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.workspace,actor,invite.role]);
    return {workspaceId:ctx.workspace};
  });
}
