import { auth, pool, assertAuthConfigured } from './auth.mjs';
import { provisionAccountCreated } from './provision.mjs';
import { PlatformAccessError } from './authorization.mjs';

export async function getVerifiedSession(headers) {
  assertAuthConfigured();
  // Better Auth validates its HTTP-only session cookie against PostgreSQL,
  // including revocation and expiration. Provider keys are intentionally ignored.
  const session = await auth.api.getSession({ headers });
  if (!session?.user?.id) throw new PlatformAccessError('AUTH_REQUIRED', 401);
  return session;
}

export async function getPlatformActor(headers) {
  const session = await getVerifiedSession(headers);
  // Self-heal a committed sign-up whose first delivery failed. This uses the
  // identity returned by Better Auth and cannot issue a second signup grant.
  await provisionAccountCreated(pool.query.bind(pool), {
    type: 'account.created',
    userId: session.user.id,
    eventId: 'auth-user:' + session.user.id,
  });
  const data = await pool.query(
    'SELECT p.user_id AS "userId", p.plan, w.id AS "workspaceId", ' +
    'COALESCE((SELECT SUM(c.amount) FROM platform.credit_entries c WHERE c.user_id = p.user_id), 0)::text AS "creditBalance" ' +
    'FROM platform.user_profiles p ' +
    'JOIN platform.workspaces w ON w.owner_user_id = p.user_id AND w.kind = $2 ' +
    'WHERE p.user_id = $1',
    [session.user.id, 'personal'],
  );
  if (data.rows.length !== 1) throw new PlatformAccessError('ACCOUNT_NOT_READY', 503);
  return { session, ...data.rows[0] };
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
