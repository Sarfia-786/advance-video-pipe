import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
test.after(() => pool.end());

async function wallet(t, credits = 10) {
  const user = randomUUID();
  await pool.query('SELECT platform.provision_account_created($1, $2, $3)', [user, 'signup-' + user, credits]);
  t.after(() => pool.query('DELETE FROM platform.user_profiles WHERE user_id = $1', [user]));
  return user;
}

const reserve = (db, user, key, estimate) => db.query(
  'SELECT * FROM platform.reserve_credits($1, $2, $3)', [user, key, estimate]);
const settle = (db, user, key, actual, reason = null) => db.query(
  'SELECT * FROM platform.settle_credits($1, $2, $3, $4)', [user, key, actual, reason]);

async function meter(user) {
  const { rows } = await pool.query('SELECT available, reserved, spent FROM platform.credit_usage WHERE user_id = $1', [user]);
  return rows[0];
}

test('two 8-credit holds compete for 10 credits and retrying a 5-credit charge releases 3 once', async t => {
  const user = await wallet(t);
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query('BEGIN');
    await reserve(first, user, 'job-a', 8);
    const competing = assert.rejects(reserve(second, user, 'job-b', 8), { message: 'insufficient_credits' });
    // Keep the first write uncommitted until the other session is actually waiting on it.
    try {
      const deadline = Date.now() + 5000;
      while (!(await pool.query('SELECT $1::int = ANY(pg_blocking_pids($2)) AS waiting',
        [first.processID, second.processID])).rows[0].waiting) {
        assert.ok(Date.now() < deadline, 'second reservation should contend for the same wallet');
        await setTimeout(10);
      }
    } finally {
      await first.query('COMMIT');
      await competing;
    }
    assert.deepEqual(await meter(user), { available: '2', reserved: '8', spent: '0' });
    await reserve(first, user, 'job-a', 8);
    await Promise.all([settle(first, user, 'job-a', 5), settle(second, user, 'job-a', 5)]);
    await reserve(first, user, 'job-a', 8);
    assert.deepEqual(await meter(user), { available: '5', reserved: '0', spent: '5' });
    const { rows } = await pool.query('SELECT kind, amount FROM platform.credit_entries WHERE user_id = $1 ORDER BY id', [user]);
    assert.deepEqual(rows, [
      { kind: 'starter_grant', amount: '10' }, { kind: 'reserve', amount: '-8' },
      { kind: 'capture', amount: '-5' }, { kind: 'release', amount: '3' },
    ]);
  } finally {
    first.release(true);
    second.release(true);
  }
});

test('failed jobs release in full and replays must agree with the original amounts and reason', async t => {
  const user = await wallet(t);
  await reserve(pool, user, 'job', 8);
  await assert.rejects(reserve(pool, user, 'job', 9), { message: 'credit_operation_conflict' });
  for (const cost of [-1, 9, null]) {
    await assert.rejects(settle(pool, user, 'job', cost), { message: 'invalid_credit_settlement' });
  }
  await assert.rejects(settle(pool, user, 'job', 0), { message: 'invalid_credit_settlement' });
  await settle(pool, user, 'job', 0, 'provider_failed');
  const replay = await settle(pool, user, 'job', 0, 'provider_failed');
  assert.equal(replay.rows[0].settlement_reason, 'provider_failed');
  await assert.rejects(settle(pool, user, 'job', 0, 'canceled'), { message: 'credit_operation_conflict' });
  await assert.rejects(settle(pool, user, 'job', 2), { message: 'credit_operation_conflict' });
  assert.deepEqual(await meter(user), { available: '10', reserved: '0', spent: '0' });
});

test('operation keys belong to their wallet, full capture works, and legacy postings keep their value', async t => {
  const alice = await wallet(t, 0);
  const bob = await wallet(t, 5);
  assert.deepEqual(await meter(alice), { available: '0', reserved: '0', spent: '0' });
  await pool.query("INSERT INTO platform.credit_entries(user_id, kind, amount, idempotency_key) VALUES " +
    "($1, 'purchase', 12, $1 || ':topup'), ($1, 'capture', -2, $1 || ':legacy')", [alice]);
  await reserve(pool, alice, 'shared', 10);
  await assert.rejects(settle(pool, bob, 'shared', 1), { message: 'credit_reservation_not_found' });
  await reserve(pool, bob, 'shared', 5);
  await settle(pool, bob, 'shared', 5);
  assert.deepEqual(await meter(alice), { available: '0', reserved: '10', spent: '2' });
  assert.deepEqual(await meter(bob), { available: '0', reserved: '0', spent: '5' });
  const entries = await pool.query("SELECT kind FROM platform.credit_entries WHERE user_id=$1 ORDER BY id", [bob]);
  assert.deepEqual(entries.rows.map(row => row.kind), ['starter_grant', 'reserve', 'capture']);
});
