import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccountCreated, parseStarterCredits, provisionAccountCreated,
} from '../lib/platform/accounts/provision.mjs';
import {
  requireWorkspaceAccess, requirePremium, PlatformAccessError,
} from '../lib/platform/accounts/authorization.mjs';

test('only trusted account-created envelope passes validation', () => {
  assert.deepEqual(normalizeAccountCreated({ type: 'account.created', eventId: 'evt-1', userId: 'u-1' }),
    { eventId: 'evt-1', userId: 'u-1' });
  for (const event of [{ type: 'login', eventId: 'e', userId: 'u' },
                       { type: 'account.created', eventId: '', userId: 'u' },
                       { type: 'account.created', eventId: 'e', userId: ' ' }]) {
    assert.throws(() => normalizeAccountCreated(event), TypeError);
  }
});

test('starter allocation validates bounds and does not permit floats', () => {
  for (const [input, expected] of [['0', 0], ['25', 25], ['1000000', 1000000]]) {
    assert.equal(parseStarterCredits(input), expected);
  }
  for (const input of ['-1', '1.2', '1000001', '01', 'Infinity', '']) {
    assert.throws(() => parseStarterCredits(input), RangeError);
  }
});

test('provisioning delegates atomic event to a parameterized database function', async () => {
  const calls = [];
  const result = await provisionAccountCreated(async (...args) => calls.push(args),
    { type: 'account.created', userId: 'user-1', eventId: 'evt-1' }, 50);
  assert.deepEqual(result, { userId: 'user-1', provisioned: true });
  assert.deepEqual(calls, [[
    'SELECT platform.provision_account_created($1::text, $2::text, $3::bigint)',
    ['user-1', 'evt-1', 50],
  ]]);
});

test('private reads fail closed without a session, never use a MuAPI key', async () => {
  const noResolver = () => requireWorkspaceAccess({}, 'personal:alice');
  await assert.rejects(noResolver, error => error instanceof PlatformAccessError && error.status === 503);
  let queries = 0;
  await assert.rejects(
    () => requireWorkspaceAccess({
      getSession: async () => null,
      query: async () => { queries++; return { rows: [] }; },
      muapiKey: 'a-secret-provider-key',
    }, 'personal:alice'),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );
  assert.equal(queries, 0);
});

test('membership and current plan are database-owned, not claimed by the caller', async () => {
  const calls = [];
  const adapter = {
    getSession: async () => ({ user: { id: 'alice' } }),
    query: async (sql, params) => {
      calls.push([sql, params]);
      return { rows: [{ userId: 'alice', workspaceId: 'personal:alice', role: 'owner', plan: 'free' }] };
    },
  };
  const actor = await requireWorkspaceAccess(adapter, 'personal:alice', 'editor');
  assert.deepEqual(calls[0][1], ['alice', 'personal:alice']);
  assert.equal(actor.role, 'owner');
  assert.throws(() => requirePremium(actor), error => error.status === 403);
  assert.equal(requirePremium({ ...actor, plan: 'premium' }).plan, 'premium');
});

test('cross-workspace and insufficient role are inaccessible', async () => {
  const base = { getSession: async () => ({ user: { id: 'alice' } }) };
  await assert.rejects(
    () => requireWorkspaceAccess({ ...base, query: async () => ({ rows: [] }) }, 'personal:bob'),
    error => error.status === 404,
  );
  await assert.rejects(
    () => requireWorkspaceAccess({
      ...base,
      query: async () => ({ rows: [{ userId: 'alice', workspaceId: 'team:1', role: 'viewer', plan: 'premium' }] }),
    }, 'team:1', 'owner'), error => error.status === 404,
  );
});
