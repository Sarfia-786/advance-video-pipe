import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { latestEmail, linkFromEmail } from './support/accountInbox.mjs';

const origin = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const base = origin + '/api/platform/v1';
const history = '/usage/history';

test('anonymous detailed history is private even when the request claims Premium', async () => {
  const response = await fetch(base + history + '?plan=premium', { headers: { 'x-plan': 'premium' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { error: { code: 'AUTH_REQUIRED' } });
});

test('the same verified session follows persisted lifecycle changes for profile, workspace and detailed usage', async () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const email = randomUUID() + '@example.test';
  const password = randomUUID();
  const otherUser = 'history-fixture-' + randomUUID();
  const authPost = (path, data) => fetch(base + '/auth/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-test-ingress-ip': '203.0.113.88' },
    body: JSON.stringify(data),
  });
  try {
    assert.equal((await authPost('sign-up/email', { email, password, name: 'Entitlements member' })).status, 200);
    const url = linkFromEmail(await latestEmail(email, 'Verify'));
    assert.equal(new URL(url).origin, origin);
    await fetch(url, { redirect: 'manual' });
    const signIn = await authPost('sign-in/email', { email, password });
    assert.equal(signIn.status, 200);
    const cookie = signIn.headers.getSetCookie().map(part => part.split(';')[0]).join('; ');
    const get = path => fetch(base + path, { headers: { cookie, 'x-plan': 'premium' } });
    const profile = await (await get('/me')).json();
    const id = profile.user.id;
    const workspace = '/workspaces/' + encodeURIComponent(profile.personalWorkspaceId);
    const claimed = history + '?plan=premium&userId=' + otherUser;

    await db.query('SELECT platform.provision_account_created($1, $2, 11)', [otherUser, 'signup-' + otherUser]);
    await db.query(
      "INSERT INTO platform.credit_entries(user_id,kind,amount,idempotency_key) " +
      "SELECT $1,'adjustment',n,$1 || '-history-' || n FROM generate_series(1,52) AS n", [id],
    );
    for (const [plan, status, until, effective, returnedStatus] of [
      ['free', 'free', null, 'free', 'free'],
      ['premium', 'active', null, 'premium', 'active'],
      ['premium', 'trialing', '2099-01-01', 'premium', 'trialing'],
      ['premium', 'canceling', '2099-01-01', 'premium', 'canceling'],
      ['premium', 'canceling', '2000-01-01', 'free', 'expired'],
      ['premium', 'expired', '2000-01-01', 'free', 'expired'],
      ['premium', 'past_due', '2099-01-01', 'free', 'past_due'],
      ['premium', 'canceled', '2099-01-01', 'free', 'canceled'],
      ['premium', 'payment_failed', '2099-01-01', 'free', 'payment_failed'],
    ]) {
      await db.query('UPDATE platform.user_profiles SET plan=$2, subscription_status=$3, access_until=$4 WHERE user_id=$1',
        [id, plan, status, until]);
      const me = await (await get('/me?plan=premium')).json();
      assert.equal(me.plan, effective);
      assert.equal(me.entitlements.status, returnedStatus);
      assert.equal(me.entitlements.capabilities.watermarkRequired, effective === 'free');
      assert.equal((await (await get(workspace)).json()).plan, effective);
      const page = await get(claimed);
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
      if (effective === 'free') {
        assert.equal(page.status, 403);
        assert.deepEqual(await page.json(), { error: { code: 'PLAN_REQUIRED' } });
        continue;
      }
      assert.equal(page.status, 200);
      const first = await page.json();
      assert.equal(first.entries.length, 50);
      const last = await (await get(claimed + '&before=' + first.nextBefore)).json();
      assert.equal(last.nextBefore, null);
      const rows = await db.query('SELECT id FROM platform.credit_entries WHERE user_id=$1 ORDER BY id DESC', [id]);
      assert.deepEqual([...first.entries, ...last.entries].map(entry => entry.id), rows.rows.map(row => row.id));
      assert.deepEqual(Object.keys(first.entries[0]).sort(), ['amount', 'createdAt', 'id', 'kind']);
      for (const cursor of ['0', 'x', '9223372036854775808']) {
        assert.equal((await get(history + '?before=' + cursor)).status, 400);
      }
    }
  } finally {
    try {
      await db.query('DELETE FROM "user" WHERE email=$1', [email]);
      await db.query('DELETE FROM platform.user_profiles WHERE user_id=$1', [otherUser]);
    } finally {
      await db.end();
    }
  }
});
