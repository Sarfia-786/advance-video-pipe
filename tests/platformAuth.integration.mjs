import test from 'node:test';
import assert from 'node:assert/strict';
import { auth, pool, assertAuthConfigured } from '../lib/platform/accounts/auth.mjs';
import { getPlatformActor } from '../lib/platform/accounts/server.mjs';
import { latestEmail, linkFromEmail } from './support/accountInbox.mjs';
import { requireWorkspaceAccess } from '../lib/platform/accounts/authorization.mjs';

const BASE = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const ENDPOINT = BASE + '/api/platform/v1/auth';
const makeId = () => 'test-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
const PASSWORD = 'Strong#password#for#integration#2026';

function endpoint(path, body, { origin = BASE, cookie } = {}) {
  return auth.handler(new Request(ENDPOINT + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  }));
}

function sessionCookie(response) {
  const raw = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).join('; ');
  const match = raw.match(/(?:__Secure-)?better-auth\.session_token=[^;,\s]+/);
  assert.ok(match, 'A login must issue a Better Auth HTTP-only session cookie');
  return match[0];
}

test('real Postgres + SMTP verification + sessions + account replay', { timeout: 30000 }, async (t) => {
  assertAuthConfigured();
  const email = makeId() + '@example.test';
  const register = await endpoint('/sign-up/email', { name: 'Account Tester', email, password: PASSWORD });
  assert.equal(register.status, 200, 'Sign-up response: ' + await register.text());

  const alice = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
  assert.equal(alice.rows.length, 1);
  const userId = alice.rows[0].id;
  const entries = await pool.query(
    'SELECT count(*)::int AS count, max(amount)::text AS amount FROM platform.credit_entries WHERE user_id=$1',
    [userId],
  );
  assert.deepEqual(entries.rows[0], { count: 1, amount: '25' });

  const beforeVerify = await endpoint('/sign-in/email', { email, password: PASSWORD });
  assert.equal(beforeVerify.status, 403, 'Unverified user must not sign in');

  const verifyLink = linkFromEmail(await latestEmail(email, 'Verify'));
  assert.equal(new URL(verifyLink).origin, BASE);
  // Exercise the exact signed link from SMTP after its deadline, then restore the test clock.
  const expiredVerification = new URL(verifyLink);
  expiredVerification.searchParams.set('callbackURL', BASE + '/login');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 86400 * 1000 });
  try {
    const denied = await auth.handler(new Request(expiredVerification));
    assert.equal(denied.status, 302);
    assert.equal(new URL(denied.headers.get('location'), BASE).searchParams.get('error'), 'TOKEN_EXPIRED');
  } finally {
    t.mock.timers.reset();
  }
  assert.equal((await pool.query('SELECT "emailVerified" FROM "user" WHERE id=$1', [userId])).rows[0].emailVerified, false);
  const verification = await auth.handler(new Request(verifyLink, { method: 'GET', redirect: 'manual' }));
  assert.ok([200, 302, 303, 307, 308].includes(verification.status), 'Verification: ' + verification.status);
  const verified = await pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [userId]);
  assert.equal(verified.rows[0].emailVerified, true);

  const login = await endpoint('/sign-in/email', { email, password: PASSWORD });
  assert.equal(login.status, 200, 'Login response: ' + await login.text());
  const cookie = sessionCookie(login);
  const actor = await getPlatformActor(new Headers({ Cookie: cookie, Origin: BASE }));
  assert.equal(actor.userId, userId);
  assert.equal(actor.plan, 'free');
  assert.equal(actor.creditBalance, '25');
  assert.equal(actor.workspaceId, 'personal:' + userId);

  // Real PostgreSQL tenant isolation: the currently authenticated user's
  // database membership, not a supplied workspace ID, controls access.
  const otherEmail = makeId() + '@example.test';
  const otherSignup = await endpoint('/sign-up/email', {
    name: 'Other Account', email: otherEmail, password: PASSWORD,
  });
  assert.equal(otherSignup.status, 200);
  const other = await pool.query('SELECT id FROM "user" WHERE email = $1', [otherEmail]);
  assert.equal(other.rows.length, 1);
  const recovery = await endpoint('/request-password-reset', { email: otherEmail, redirectTo: BASE + '/reset-password' });
  assert.equal(recovery.status, 200);
  const expiredReset = new URL(linkFromEmail(await latestEmail(otherEmail, 'Reset')));
  const expiredToken = expiredReset.pathname.split('/').pop();
  const expiredRow = await pool.query(
    'UPDATE verification SET "expiresAt"=now() WHERE identifier=$1 AND value=$2',
    ['reset-password:' + expiredToken, other.rows[0].id],
  );
  assert.equal(expiredRow.rowCount, 1);
  const expiredCallback = await auth.handler(new Request(expiredReset));
  assert.equal(expiredCallback.status, 302);
  assert.equal(new URL(expiredCallback.headers.get('location'), BASE).searchParams.get('error'), 'INVALID_TOKEN');
  const rejectedReset = await endpoint('/reset-password', { token: expiredToken, newPassword: PASSWORD + '2' });
  assert.equal(rejectedReset.status, 400);
  const otherWorkspace = 'personal:' + other.rows[0].id;
  const identity = {
    getSession: async () => ({ user: { id: userId } }),
    query: pool.query.bind(pool),
  };
  assert.equal((await requireWorkspaceAccess(identity, 'personal:' + userId, 'owner')).role, 'owner');
  await assert.rejects(
    () => requireWorkspaceAccess(identity, otherWorkspace, 'viewer'),
    error => error.status === 404 && error.code === 'WORKSPACE_NOT_FOUND',
  );

  // Re-delivering even a DIFFERENT event ID must never duplicate credits.
  await pool.query('SELECT platform.provision_account_created($1, $2, $3)', [userId, 'replayed:' + userId, 999]);
  const afterReplay = await pool.query(
    'SELECT count(*)::int AS count, sum(amount)::text AS credits FROM platform.credit_entries WHERE user_id=$1',
    [userId],
  );
  assert.deepEqual(afterReplay.rows[0], { count: 1, credits: '25' });

  await assert.rejects(
    () => getPlatformActor(new Headers({ 'muapi-key': 'provider-token', Origin: BASE })),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );
  await assert.rejects(
    () => getPlatformActor(new Headers({ Cookie: 'better-auth.session_token=invalid', Origin: BASE })),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );

  const evil = await endpoint('/sign-in/email', { email, password: PASSWORD }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403, 'Cross-origin login CSRF must be rejected');

  // Expired sessions are denied even if the browser still carries a cookie.
  await pool.query('UPDATE "session" SET "expiresAt" = now() - interval \'1 day\' WHERE "userId" = $1', [userId]);
  await assert.rejects(
    () => getPlatformActor(new Headers({ Cookie: cookie, Origin: BASE })),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );

  const resetRequest = await endpoint('/request-password-reset', {
    email, redirectTo: BASE + '/reset-password',
  });
  assert.equal(resetRequest.status, 200, 'Reset request: ' + await resetRequest.text());
  const resetUrl = linkFromEmail(await latestEmail(email, 'Reset'));
  assert.equal(new URL(resetUrl).origin, BASE);
  assert.ok(resetUrl.includes('/reset-password/'), 'Must include a one-use password reset token');
  const resetToken = decodeURIComponent(new URL(resetUrl).pathname.split('/').pop());
  const replacementPassword = 'New!password!for!integration!2026';
  const reset = await endpoint('/reset-password', { token: resetToken, newPassword: replacementPassword });
  assert.equal(reset.status, 200, 'Password reset must work with the emailed token: ' + await reset.text());

  const changedLogin = await endpoint('/sign-in/email', { email, password: replacementPassword });
  assert.equal(changedLogin.status, 200, 'New password must work');
  const changedCookie = sessionCookie(changedLogin);
  assert.equal((await getPlatformActor(new Headers({ Cookie: changedCookie }))).userId, userId);
  // This server-side assertion bypasses browser rate limits but still verifies
  // Better Auth rejects the old password after successful recovery.
  await assert.rejects(
    () => auth.api.signInEmail({ body: { email, password: PASSWORD } }),
    'Old password must no longer work',
  );

  const revoke = await endpoint('/revoke-sessions', {}, { cookie: changedCookie });
  assert.equal(revoke.status, 200, 'Logout across devices must succeed');
  await assert.rejects(
    () => getPlatformActor(new Headers({ Cookie: changedCookie })),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );

  const deleteLogin = await endpoint('/sign-in/email', { email, password: replacementPassword });
  assert.equal(deleteLogin.status, 200, 'Sign in after session revocation must work');
  const deleteCookie = sessionCookie(deleteLogin);
  const deletion = await endpoint('/delete-user', { password: replacementPassword }, { cookie: deleteCookie });
  assert.equal(deletion.status, 200, 'Password-confirmed deletion should succeed');
  let remaining = await pool.query('SELECT count(*)::int AS n FROM "user" WHERE id=$1', [userId]);
  if (remaining.rows[0].n !== 0) {
    const confirmLink = linkFromEmail(await latestEmail(email, 'Confirm account deletion'));
    const approved = await auth.handler(new Request(confirmLink, {
      method: 'GET', redirect: 'manual', headers: { Cookie: deleteCookie },
    }));
    assert.ok([200, 302, 303, 307, 308].includes(approved.status),
      'Deletion confirmation status ' + approved.status + ': ' + await approved.text());
  }
  remaining = await pool.query('SELECT count(*)::int AS n FROM "user" WHERE id=$1', [userId]);
  assert.equal(remaining.rows[0].n, 0, 'Auth user must be removed');
  const platformRemoved = await pool.query('SELECT count(*)::int AS n FROM platform.user_profiles WHERE user_id=$1', [userId]);
  assert.equal(platformRemoved.rows[0].n, 0, 'Private profile must be removed');

  // Verify that the vendor's persistent rate limiter rejects a login flood.
  let throttled = false;
  for (let i = 0; i < 12; i++) {
    const response = await endpoint('/sign-in/email', { email, password: 'not-my-password' });
    if (response.status === 429) { throttled = true; break; }
  }
  assert.equal(throttled, true, 'Auth rate limit must produce HTTP 429');

  t.diagnostic('Verified: signup → real SMTP → email verification → login → private plan/credits → idempotency → expired sessions → CSRF → password recovery → revoked sessions → account deletion → rate limit.');
});

test.after(async () => {
  await pool.end();
});
