import test from 'node:test';
import assert from 'node:assert/strict';
import { getCreditMeter, normalizeCreditOperation, reserveCredits, settleCredits } from '../lib/platform/credits/ledger.mjs';

test('credit operations validate server-owned identifiers and integer amounts', () => {
  assert.deepEqual(normalizeCreditOperation({
    userId: 'u-1', operationKey: 'job:123', credits: 8, tool: 'video', model: 'wan', jobId: 'j-1',
  }), {
    userId: 'u-1', operationKey: 'job:123', credits: 8, tool: 'video', model: 'wan', jobId: 'j-1', reason: null,
  });
  for (const credits of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => normalizeCreditOperation({ userId: 'u', operationKey: 'op', credits }), RangeError);
  }
  assert.throws(() => normalizeCreditOperation({ userId: ' u', operationKey: 'op', credits: 1 }), TypeError);
  assert.throws(() => normalizeCreditOperation({ userId: 'u', operationKey: '', credits: 1 }), TypeError);
  assert.equal(normalizeCreditOperation({
    userId: 'u', operationKey: 'op', credits: 0, reason: 'provider failed',
  }, { settlement: true }).credits, 0);
});

test('reservation wrapper binds identity, operation and cost without accepting client balance fields', async () => {
  const calls = [];
  const result = await reserveCredits(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ operation_key: 'op-1', max_amount: '8', status: 'reserved', available: '2', reserved: '8' }] };
  }, { userId: 'alice', operationKey: 'op-1', credits: 8, tool: 'image', model: 'm1', jobId: 'job-1', available: 999 });
  assert.match(calls[0].sql, /platform\.reserve_credits/);
  assert.deepEqual(calls[0].params, ['alice', 'op-1', 8, 'image', 'm1', 'job-1']);
  assert.deepEqual(result, { operationKey: 'op-1', maxCredits: '8', status: 'reserved', available: '2', reserved: '8' });
});

test('settlement wrapper is retry-shaped and meter values stay lossless strings', async () => {
  const settlement = await settleCredits(async () => ({ rows: [{
    operation_key: 'op-1', captured: '5', released: '3', available: '5', reserved: '0', spent: '5',
  }] }), { userId: 'alice', operationKey: 'op-1', credits: 5, reason: 'actual provider usage' });
  assert.deepEqual(settlement, {
    operationKey: 'op-1', captured: '5', released: '3', available: '5', reserved: '0', spent: '5',
  });

  const meter = await getCreditMeter(async () => ({ rows: [{
    settled_balance: 9007199254740993n, reserved: 8n, available: 9007199254740985n, spent: 5n,
  }] }), 'alice');
  assert.deepEqual(meter, {
    settledBalance: '9007199254740993', reserved: '8', available: '9007199254740985', spent: '5',
  });
});
