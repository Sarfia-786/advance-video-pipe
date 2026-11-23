import { auth, pool, assertAuthConfigured } from './auth.mjs';
import { PlatformAccessError } from './authorization.mjs';
import { getEntitlements } from '../entitlements/policy.mjs';

export async function getVerifiedSession(headers) {
  assertAuthConfigured();
  // Better Auth validates its HTTP-only session cookie against PostgreSQL,
  // including revocation and expiration. Provider keys are intentionally ignored.
  const session = await auth.api.getSession({ headers });
  if (!session?.user?.id || !session.user.emailVerified) throw new PlatformAccessError('AUTH_REQUIRED', 401);
  return session;
}

export async function getPlatformActor(headers) {
  const session = await getVerifiedSession(headers);
  const data = await pool.query(
    'SELECT p.user_id AS "userId", p.plan, p.subscription_status AS "subscriptionStatus", ' +
    'p.access_until AS "accessUntil", w.id AS "workspaceId", ' +
    'u.available::text, u.reserved::text, u.spent::text ' +
    'FROM platform.user_profiles p ' +
    'JOIN platform.credit_usage u ON u.user_id = p.user_id ' +
    'JOIN platform.workspaces w ON w.owner_user_id = p.user_id AND w.kind = $2 ' +
    'WHERE p.user_id = $1',
    [session.user.id, 'personal'],
  );
  if (data.rows.length !== 1) throw new PlatformAccessError('ACCOUNT_NOT_READY', 503);
  const profile = data.rows[0];
  const entitlements = getEntitlements(profile);
  return { session, userId: profile.userId, workspaceId: profile.workspaceId,
    creditBalance: profile.available,
    creditUsage: { available: profile.available, reserved: profile.reserved, spent: profile.spent },
    plan: entitlements.plan, entitlements };
}

export function privateApiResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}

export function privateApiError(error) {
  if (error instanceof PlatformAccessError) {
    return privateApiResponse({ error: { code: error.code } }, error.status);
  }
  console.error('platform_account_request_failed', { error: error?.name || 'UnknownError' });
  return privateApiResponse({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
}
