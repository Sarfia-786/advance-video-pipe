import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString, max: 6 });
const users = new Set();
async function createUser(prefix, credits) {
  const userId = prefix + '-' + randomUUID();
  users.add(userId);
  await pool.query('SELECT platform.provision_account_created($1,$2,$3)', [userId, 'signup-' + userId, credits]);
  return userId;
}

test('two reservations racing for 10 credits allow one 8-credit hold and idempotent capture/release', async () => {
  const userId = await createUser('credit-race', 10);
  const starter = await pool.query(
    'SELECT kind, amount, operation_key FROM platform.credit_entries WHERE user_id=$1 ORDER BY id',
    [userId],
  );
  assert.deepEqual(starter.rows, [{ kind: 'starter_grant', amount: '10', operation_key: 'signup:' + userId }]);

  const reserve = op => pool.query(
    'SELECT * FROM platform.reserve_credits($1,$2,8,$3,$4,$5)',
    [userId, op, 'video', 'test-model', 'job-' + op],
  );
  const results = await Promise.allSettled([reserve('race-a'), reserve('race-b')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.match(String(results.find(r => r.status === 'rejected').reason), /insufficient_credits/);

  const winner = results[0].status === 'fulfilled' ? 'race-a' : 'race-b';
  const retryHold = await reserve(winner);
  assert.equal(retryHold.rows[0].status, 'reserved');
  assert.deepEqual((await pool.query('SELECT * FROM platform.credit_meter($1)', [userId])).rows[0], {
    settled_balance: '10', reserved: '8', available: '2', spent: '0',
  });

  const settle = () => pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,5,$3)', [
    userId, winner, 'actual provider usage',
  ]);
  const first = await settle();
  const replay = await settle();
  assert.deepEqual(first.rows[0], replay.rows[0]);
  assert.deepEqual(first.rows[0], {
    operation_key: winner, captured: '5', released: '3', available: '5', reserved: '0', spent: '5',
  });
  await assert.rejects(
    () => pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,5,$3)', [userId, winner, 'changed reason']),
    /credit_settlement_reused/,
  );

  await pool.query('SELECT * FROM platform.reserve_credits($1,$2,4,$3,$4,$5)', [
    userId, 'failed-job', 'video', 'test-model', 'job-failed',
  ]);
  const failed = await pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,0,$3)', [
    userId, 'failed-job', 'provider timeout',
  ]);
  const failedReplay = await pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,0,$3)', [
    userId, 'failed-job', 'provider timeout',
  ]);
  assert.deepEqual(failed.rows[0], failedReplay.rows[0]);
  assert.deepEqual(failed.rows[0], {
    operation_key: 'failed-job', captured: '0', released: '4', available: '5', reserved: '0', spent: '5',
  });
  await assert.rejects(
    () => pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,0,NULL)', [userId, 'failed-job']),
    /credit_failure_reason_required/,
  );

  const audit = await pool.query(
    'SELECT kind, amount, operation_key, reason FROM platform.credit_entries WHERE user_id=$1 ORDER BY id',
    [userId],
  );
  assert.deepEqual(audit.rows.map(row => [row.kind, row.amount, row.operation_key, row.reason]), [
    ['starter_grant', '10', 'signup:' + userId, null],
    ['reserve', '8', winner, null],
    ['capture', '-5', winner, 'actual provider usage'],
    ['release', '3', winner, 'actual provider usage'],
    ['reserve', '4', 'failed-job', null],
    ['release', '4', 'failed-job', 'provider timeout'],
  ]);
});

test('purchase, subscription, refund, adjustment, reversal and expiry are atomic, linked and idempotent', async () => {
  const userId = await createUser('credit-events', 20);
  const apply = (operation, kind, amount, reason = null, metadata = {}) => pool.query(
    'SELECT * FROM platform.apply_credit_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [userId, operation, kind, amount, reason, metadata.tool ?? null, metadata.model ?? null,
      metadata.jobId ?? null, metadata.topUpId ?? null],
  );

  const purchase = await apply('topup:1', 'purchase', 10, null, {
    tool: 'billing', model: 'stripe', jobId: 'payment-job-1', topUpId: 'pack-1',
  });
  const purchaseReplay = await apply('topup:1', 'purchase', 10, null, {
    tool: 'billing', model: 'stripe', jobId: 'payment-job-1', topUpId: 'pack-1',
  });
  assert.deepEqual(purchase.rows[0], purchaseReplay.rows[0]);
  await apply('subscription:2026-11', 'subscription', 5, null, { tool: 'billing' });
  await apply('admin:1', 'adjustment', -3, 'support correction', { tool: 'admin' });
  await apply('refund:job-2', 'refund', 2, 'generation failed', { tool: 'video', jobId: 'job-2' });
  await apply('reversal:job-3', 'reversal', 1, 'duplicate debit reversed', { tool: 'image', jobId: 'job-3' });
  await apply('expiry:2026-11', 'expiry', -4, 'configured credit expiry');

  assert.deepEqual((await pool.query('SELECT * FROM platform.credit_meter($1)', [userId])).rows[0], {
    settled_balance: '31', reserved: '0', available: '31', spent: '0',
  });
  await assert.rejects(
    () => apply('topup:1', 'purchase', 11, null, {
      tool: 'billing', model: 'stripe', jobId: 'payment-job-1', topUpId: 'pack-1',
    }),
    /credit_operation_reused/,
  );

  await pool.query('SELECT * FROM platform.reserve_credits($1,$2,30,$3,NULL,$4)', [
    userId, 'large-hold', 'video', 'job-large',
  ]);
  await assert.rejects(
    () => apply('expiry:blocked', 'expiry', -2, 'expiry cannot consume held credits'),
    /insufficient_credits/,
  );
  await pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,0,$3)', [
    userId, 'large-hold', 'canceled before provider call',
  ]);

  const purchaseRow = await pool.query(
    'SELECT operation_key, tool, model, job_id, top_up_id FROM platform.credit_entries ' +
    "WHERE user_id=$1 AND kind='purchase'",
    [userId],
  );
  assert.deepEqual(purchaseRow.rows, [{
    operation_key: 'topup:1', tool: 'billing', model: 'stripe', job_id: 'payment-job-1', top_up_id: 'pack-1',
  }]);
  const counts = await pool.query(
    'SELECT kind, count(*)::int AS n FROM platform.credit_entries WHERE user_id=$1 GROUP BY kind',
    [userId],
  );
  assert.equal(Object.fromEntries(counts.rows.map(row => [row.kind, row.n])).purchase, 1);
});

test('starter grant stays exactly-once across callback replay under the credit schema', async () => {
  const userId = await createUser('credit-signup', 25);
  await pool.query('SELECT platform.provision_account_created($1,$2,999)', [userId, 'signup-' + userId]);
  await pool.query('SELECT platform.provision_account_created($1,$2,999)', [userId, 'callback-retry-' + userId]);
  const grants = await pool.query(
    "SELECT count(*)::int AS n, sum(amount)::text AS amount, max(operation_key) AS operation_key " +
    "FROM platform.credit_entries WHERE user_id=$1 AND kind='starter_grant'",
    [userId],
  );
  assert.deepEqual(grants.rows[0], { n: 1, amount: '25', operation_key: 'signup:' + userId });
  assert.deepEqual((await pool.query('SELECT * FROM platform.credit_meter($1)', [userId])).rows[0], {
    settled_balance: '25', reserved: '0', available: '25', spent: '0',
  });
});

test.after(async () => {
  for (const userId of users) {
    await pool.query('DELETE FROM platform.user_profiles WHERE user_id=$1', [userId]).catch(() => {});
  }
  await pool.end();
});
