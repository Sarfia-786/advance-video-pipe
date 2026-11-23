import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateMaximumCredits, getCreditMeter, normalizeCreditOperation, normalizeLedgerEntry,
  recordCreditEntry, reserveCredits, reserveEstimatedCredits, settleCredits,
} from '../lib/platform/credits/ledger.mjs';

test('reservation and settlement inputs validate server-owned IDs, integer costs and failure reasons', () => {
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
  assert.throws(() => normalizeCreditOperation({
    userId: 'u', operationKey: 'failed', credits: 0,
  }, { settlement: true }), /reason is required/);
  assert.equal(normalizeCreditOperation({
    userId: 'u', operationKey: 'failed', credits: 0, reason: 'provider timeout',
  }, { settlement: true }).credits, 0);
});

test('ledger entry kinds enforce signs and durable audit reasons', () => {
  assert.deepEqual(normalizeLedgerEntry({
    userId: 'u', operationKey: 'topup:1', kind: 'purchase', amount: 20,
    tool: 'billing', model: 'stripe', jobId: 'job-1', topUpId: 'pack-1',
  }), {
    userId: 'u', operationKey: 'topup:1', kind: 'purchase', amount: 20, reason: null,
    tool: 'billing', model: 'stripe', jobId: 'job-1', topUpId: 'pack-1',
  });
  for (const input of [
    { kind: 'purchase', amount: -1 },
    { kind: 'subscription', amount: -1 },
    { kind: 'refund', amount: -1, reason: 'x' },
    { kind: 'reversal', amount: -1, reason: 'x' },
    { kind: 'expiry', amount: 1, reason: 'x' },
    { kind: 'adjustment', amount: 1 },
    { kind: 'refund', amount: 1 },
    { kind: 'reversal', amount: 1 },
    { kind: 'expiry', amount: -1 },
  ]) {
    assert.throws(() => normalizeLedgerEntry({ userId: 'u', operationKey: 'op', ...input }));
  }
  assert.equal(normalizeLedgerEntry({
    userId: 'u', operationKey: 'admin:1', kind: 'adjustment', amount: -3, reason: 'manual correction',
  }).amount, -3);
});

test('maximum managed cost is calculated before reservation without inventing provider prices', async () => {
  const components = [
    { name: 'visuals', maxCredits: 7 },
    { name: 'voice', maxCredits: 2 },
    { name: 'render', maxCredits: 1 },
  ];
  assert.equal(estimateMaximumCredits(components), 10);
  assert.throws(() => estimateMaximumCredits([]), TypeError);
  assert.throws(() => estimateMaximumCredits([{ name: 'free', maxCredits: 0 }]), RangeError);
  assert.throws(() => estimateMaximumCredits([{ name: 'bad', maxCredits: 1.5 }]), RangeError);

  const calls = [];
  const result = await reserveEstimatedCredits(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ operation_key: 'op-1', max_amount: '10', status: 'reserved', available: '15', reserved: '10' }] };
  }, { userId: 'alice', operationKey: 'op-1', tool: 'pipeline', model: 'configured-provider', jobId: 'job-1' }, components);
  assert.equal(calls[0].params[2], 10);
  assert.equal(result.maxCredits, '10');
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

test('settlement, generic entries and meter wrappers keep bigint values lossless', async () => {
  const settlement = await settleCredits(async () => ({ rows: [{
    operation_key: 'op-1', captured: '5', released: '3', available: '5', reserved: '0', spent: '5',
  }] }), { userId: 'alice', operationKey: 'op-1', credits: 5, reason: 'actual provider usage' });
  assert.deepEqual(settlement, {
    operationKey: 'op-1', captured: '5', released: '3', available: '5', reserved: '0', spent: '5',
  });

  const entryCalls = [];
  const entry = await recordCreditEntry(async (sql, params) => {
    entryCalls.push({ sql, params });
    return { rows: [{ entry_id: 9n, kind: 'refund', amount: 3n, available: 8n, reserved: 0n, spent: 5n }] };
  }, { userId: 'alice', operationKey: 'refund:1', kind: 'refund', amount: 3, reason: 'failed generation',
    tool: 'video', model: 'm1', jobId: 'job-1' });
  assert.match(entryCalls[0].sql, /platform\.apply_credit_entry/);
  assert.deepEqual(entry, { id: '9', kind: 'refund', amount: '3', available: '8', reserved: '0', spent: '5' });

  const meter = await getCreditMeter(async () => ({ rows: [{
    settled_balance: 9007199254740993n, reserved: 8n, available: 9007199254740985n, spent: 5n,
  }] }), 'alice');
  assert.deepEqual(meter, {
    settledBalance: '9007199254740993', reserved: '8', available: '9007199254740985', spent: '5',
  });
});
