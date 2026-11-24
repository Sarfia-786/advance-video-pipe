import { hasWorkspaceRole } from '../accounts/authorization.mjs';
import { getEntitlements } from '../entitlements/policy.mjs';
import { MiB, projectError, uuidPattern } from './validation.mjs';

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

export function requireFeature(ctx, name) {
  if (!ctx.entitlements.capabilities[name] || (name === 'folders' && ctx.entitlements.capabilities.folders !== 'nested')) {
    throw projectError('PLAN_REQUIRED', 403);
  }
}

// All memberships, invitations, project writes and billing decisions serialize on the
// billing owner's profile. Read membership in a fresh statement after taking that lock.
export async function lockWorkspace(db, actor, workspace, { minRole = 'viewer', missing = 'WORKSPACE_NOT_FOUND',
  allowMissing = false, invitation = false } = {}) {
  const personal = workspace == null;
  if (!personal && (typeof workspace !== 'string' || !workspace || workspace.length > 300)) throw projectError(missing, 404);
  const locator = personal ? "w.owner_user_id=$1 AND w.kind='personal'" : 'w.id=$1';
  const { rows: [profile] } = await db.query(
    'SELECT w.id AS workspace,w.kind,w.owner_user_id AS owner,p.plan,p.subscription_status AS "subscriptionStatus",p.access_until AS "accessUntil" ' +
    'FROM platform.workspaces w JOIN platform.user_profiles p ON p.user_id=w.owner_user_id WHERE ' + locator + ' FOR UPDATE OF p',
    [personal ? actor : workspace]);
  if (!profile) {
    if (allowMissing) return null;
    throw projectError(personal ? 'ACCOUNT_NOT_READY' : missing, personal ? 503 : 404);
  }
  const { rows: [member] } = await db.query('SELECT role FROM platform.workspace_members WHERE workspace_id=$1 AND user_id=$2',
    [profile.workspace,actor]);
  if (!invitation && !member) throw projectError(missing,404);
  if (!invitation && !hasWorkspaceRole(member.role,minRole)) throw projectError('ROLE_REQUIRED',403);
  const { rows: [clock] } = await db.query('SELECT clock_timestamp() AS now');
  const entitlements = getEntitlements(profile, clock.now.getTime());
  const ctx = { db, actor, owner:profile.owner, workspace:profile.workspace, kind:profile.kind, role:member?.role,
    profile, now:clock.now, entitlements, premium:entitlements.plan === 'premium', quotaBytes:entitlements.limits.storageMiB * MiB };
  if (ctx.kind === 'team') requireFeature(ctx,'teamWorkspaces');
  return ctx;
}
export function withWorkspace(pool, actor, workspace, minRole, action) {
  return transaction(pool, async db => action(await lockWorkspace(db,actor,workspace,{minRole})));
}
export function withProject(pool, actor, id, minRole, action) {
  if (!uuidPattern.test(id)) return Promise.reject(projectError('PROJECT_NOT_FOUND',404));
  return transaction(pool, async db => {
    const { rows: [project] } = await db.query('SELECT workspace_id FROM platform.projects WHERE id=$1',[id]);
    if (!project) throw projectError('PROJECT_NOT_FOUND',404);
    const ctx = await lockWorkspace(db,actor,project.workspace_id,{minRole,missing:'PROJECT_NOT_FOUND'});
    return action(ctx);
  });
}
export function withOwner(pool, owner, action, allowMissing = false) {
  return transaction(pool, async db => {
    const ctx = await lockWorkspace(db,owner,null,{allowMissing});
    return ctx ? action(ctx) : 0;
  });
}
export function publicScope(ctx) {
  return { workspaceId:ctx.workspace, role:ctx.role, premium:ctx.premium };
}
export function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length>160 || name.includes('\0') || !name.isWellFormed()) {
    throw projectError('INVALID_NAME');
  }
  return name.trim();
}
