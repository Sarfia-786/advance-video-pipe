import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

test('two reservations racing for 10 credits allow only one 8-credit hold and settlement is idempotent', async () => {
  const pool = new pg.Pool({ connectionString, max: 4 });
  const userId = 'credit-race-' + randomUUID();
  try {
    await pool.query('SELECT platform.provision_account_created($1,$2,10)', [userId, 'signup-' + userId]);

    const reserve = op => pool.query(
      'SELECT * FROM platform.reserve_credits($1,$2,8,$3,$4,$5)',
      [userId, op, 'video', 'test-model', 'job-' + op],
    );
    const results = await Promise.allSettled([reserve('race-a'), reserve('race-b')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.match(String(results.find(r => r.status === 'rejected').reason), /insufficient_credits/);

    const winner = results[0].status === 'fulfilled' ? 'race-a' : 'race-b';
    const held = await pool.query('SELECT * FROM platform.credit_meter($1)', [userId]);
    assert.deepEqual(held.rows[0], {
      settled_balance: '10', reserved: '8', available: '2', spent: '0',
    });

    const first = await pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,5,$3)', [
      userId, winner, 'provider actual',
    ]);
    const replay = await pool.query('SELECT * FROM platform.settle_credit_reservation($1,$2,5,$3)', [
      userId, winner, 'provider actual',
    ]);
    assert.deepEqual(first.rows[0], replay.rows[0]);
    assert.deepEqual(first.rows[0], {
      operation_key: winner, captured: '5', released: '3', available: '5', reserved: '0', spent: '5',
    });

    const audit = await pool.query(
      'SELECT kind, amount FROM platform.credit_entries WHERE user_id=$1 ORDER BY id',
      [userId],
    );
    assert.deepEqual(audit.rows.map(row => [row.kind, row.amount]), [
      ['starter_grant', '10'], ['reserve', '8'], ['capture', '-5'], ['release', '3'],
    ]);
  } finally {
    await pool.query('DELETE FROM platform.user_profiles WHERE user_id=$1', [userId]).catch(() => {});
    await pool.end();
  }
});
