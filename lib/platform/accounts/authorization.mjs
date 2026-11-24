// Server-only authorization boundary for private /api/platform/v1 handlers.
// The maintained auth integration must resolve an actual server-side session.
// No API key, cookie string, or caller-supplied userId counts as identity.
import { resolveSubscription } from '../entitlements/policy.mjs';

export class PlatformAccessError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'PlatformAccessError';
    this.code = code;
    this.status = status;
  }
}

const ROLES = Object.freeze({ viewer: 1, editor: 2, owner: 3 });

export function hasWorkspaceRole(role, required) {
  return Object.hasOwn(ROLES, role) && Object.hasOwn(ROLES, required) && ROLES[role] >= ROLES[required];
}

export async function requireWorkspaceAccess({ getSession, query }, workspaceId, minRole = 'viewer') {
  if (typeof getSession !== 'function' || typeof query !== 'function') {
    throw new PlatformAccessError('AUTH_NOT_CONFIGURED', 503);
  }
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 300 ||
      !Object.hasOwn(ROLES, minRole)) {
    throw new PlatformAccessError('INVALID_SCOPE', 400);
  }

  const session = await getSession();
  const userId = session?.user?.id;
  if (typeof userId !== 'string' || !userId) {
    throw new PlatformAccessError('AUTH_REQUIRED', 401);
  }
  const result = await query(
    'SELECT p.user_id AS "userId", p.plan, p.subscription_status AS "subscriptionStatus", ' +
    'p.access_until AS "accessUntil", m.role, w.id AS "workspaceId", w.kind ' +
    'FROM platform.workspace_members m JOIN platform.workspaces w ON w.id=m.workspace_id ' +
    'JOIN platform.user_profiles p ON p.user_id=w.owner_user_id WHERE m.user_id=$1 AND w.id=$2 LIMIT 1',
    [userId, workspaceId],
  );
  const actor = result?.rows?.[0];
  if (!actor || !hasWorkspaceRole(actor.role, minRole)) {
    throw new PlatformAccessError('WORKSPACE_NOT_FOUND', 404);
  }
  const { plan } = resolveSubscription(actor);
  if (actor.kind === 'team' && plan !== 'premium') throw new PlatformAccessError('PLAN_REQUIRED', 403);
  return Object.freeze({ userId, workspaceId: actor.workspaceId, role: actor.role, plan });
}

export function requirePremium(actor) {
  if (!actor || actor.plan !== 'premium') throw new PlatformAccessError('PLAN_REQUIRED', 403);
  return actor;
}

export function requireCapability(actor, name, required = true) {
  const capabilities = actor?.entitlements?.capabilities;
  if (!capabilities || !Object.hasOwn(capabilities, name)) throw new PlatformAccessError('PLAN_REQUIRED', 403);
  const value = capabilities[name];
  if (Array.isArray(value) ? !value.includes(required) : value !== required) {
    throw new PlatformAccessError('PLAN_REQUIRED', 403);
  }
  return actor;
}
