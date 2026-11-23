import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { latestEmail, linkFromEmail } from './support/accountInbox.mjs';

const origin = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const base = origin + '/api/platform/v1';
const usage = '/usage';
const history = '/usage/history';

test('anonymous usage endpoints are private even when requests claim another user or Premium', async () => {
  for (const path of [usage + '?userId=victim', history + '?plan=premium&userId=victim']) {
    const response = await fetch(base + path, { headers: { 'x-plan': 'premium' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { error: { code: 'AUTH_REQUIRED' } });
  }
});

test('verified session gets its own basic meter and Premium-only metadata-rich history across lifecycle changes', async () => {
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
    const claimedHistory = history + '?plan=premium&userId=' + otherUser;
    const claimedUsage = usage + '?userId=' + otherUser;

    assert.deepEqual(profile.credits, {
      settledBalance: '25', reserved: '0', available: '25', spent: '0',
    });

    await db.query('SELECT platform.provision_account_created($1, $2, 11)', [otherUser, 'signup-' + otherUser]);
    await db.query(
      "INSERT INTO platform.credit_entries(user_id,kind,amount,idempotency_key) " +
      "SELECT $1,'adjustment',n,$1 || '-history-' || n FROM generate_series(1,51) AS n", [id],
    );
    await db.query(
      'SELECT * FROM platform.apply_credit_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, 'topup:http-fixture', 'purchase', 7, null, 'billing', 'stripe', 'payment-job', 'pack-http'],
    );
    await db.query(
      "INSERT INTO platform.credit_entries(user_id,kind,amount,idempotency_key) VALUES ($1,'adjustment',999,$2)",
      [otherUser, 'other-only-' + otherUser],
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
      const me = await (await get('/me?plan=premium&userId=' + otherUser)).json();
      assert.equal(me.plan, effective);
      assert.equal(me.entitlements.status, returnedStatus);
      assert.equal(me.entitlements.capabilities.watermarkRequired, effective === 'free');
      assert.equal((await (await get(workspace)).json()).plan, effective);

      const meterResponse = await get(claimedUsage);
      assert.equal(meterResponse.status, 200);
      assert.equal(meterResponse.headers.get('cache-control'), 'private, no-store');
      const meter = await meterResponse.json();
      assert.equal(meter.plan, effective);
      assert.equal(meter.history, effective === 'premium' ? 'detailed' : 'meter');
      assert.deepEqual(meter.credits, {
        settledBalance: '1358', reserved: '0', available: '1358', spent: '0',
      });

      const page = await get(claimedHistory);
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
      if (effective === 'free') {
        assert.equal(page.status, 403);
        assert.deepEqual(await page.json(), { error: { code: 'PLAN_REQUIRED' } });
        continue;
      }

      assert.equal(page.status, 200);
      const first = await page.json();
      assert.equal(first.entries.length, 50);
      const last = await (await get(claimedHistory + '&before=' + first.nextBefore)).json();
      assert.equal(last.entries.length, 3);
      assert.equal(last.nextBefore, null);
      const rows = await db.query('SELECT id FROM platform.credit_entries WHERE user_id=$1 ORDER BY id DESC', [id]);
      assert.deepEqual([...first.entries, ...last.entries].map(entry => entry.id), rows.rows.map(row => row.id));
      assert.deepEqual(first.entries[0], {
        id: first.entries[0].id,
        kind: 'purchase',
        amount: '7',
        operationKey: 'topup:http-fixture',
        reason: null,
        tool: 'billing',
        model: 'stripe',
        jobId: 'payment-job',
        topUpId: 'pack-http',
        createdAt: first.entries[0].createdAt,
      });
      assert.ok(![...first.entries, ...last.entries].some(entry => entry.amount === '999'),
        'another member\'s ledger row must never appear');

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
