import test from 'node:test';
import assert from 'node:assert/strict';
import { getEntitlements, resolveSubscription } from '../lib/platform/entitlements/policy.mjs';
import { requireCapability } from '../lib/platform/accounts/authorization.mjs';

const now = Date.parse('2026-03-01T12:00:00Z');
const later = new Date(now + 1);
const earlier = new Date(now - 1);

// These expectations enumerate every product row independently of the production registry.
const matrix = {
  dashboard: ['unified', 'unified'],
  folders: ['list', 'nested'],
  versionHistory: [false, true],
  teamWorkspaces: [false, true],
  workflowModes: [['manual'], ['manual', 'automatic']],
  workflowTemplates: ['starter', 'all'],
  scriptToShort: [false, true],
  chatProviders: [['byok'], ['byok', 'managed']],
  scriptStudio: ['standard', 'advanced'],
  sceneJsonSplitter: [false, true],
  imageProviders: [['local', 'byok'], ['local', 'byok', 'managed']],
  videoProviders: [['local', 'byok'], ['local', 'byok', 'managed']],
  priorityQueue: [false, true],
  assembly: ['basic', 'advanced'],
  watermarkRequired: [true, false],
  kenBurns: [false, true],
  transitions: ['cuts', 'advanced'],
  musicMixing: ['basic', 'advanced'],
  captions: [['srt'], ['srt', 'animated']],
  designStudio: ['thumbnail', 'branding'],
  brandKits: [false, true],
  thumbnailVariants: [false, true],
  voicePreviews: [true, true],
  voiceCloning: [false, true],
  multiSpeaker: [false, true],
  autoDubbing: [false, true],
  billing: [['free'], ['subscription', 'credit_packs']],
  usageHistory: ['meter', 'detailed'],
  commercialUse: ['provider_terms', 'eligibility_indicator'],
};
const limits = {
  free: { projectExpiryDays: 7, workflowTemplateCount: 2, batchMinClips: 0, batchMaxClips: 0,
    maxOutputHeight: 720, storageMiB: 512, monthlyVoiceMinutes: 5, maxConcurrentJobs: 1 },
  premium: { projectExpiryDays: null, workflowTemplateCount: null, batchMinClips: 5, batchMaxClips: 10,
    maxOutputHeight: 2160, storageMiB: 10240, monthlyVoiceMinutes: 60, maxConcurrentJobs: 3 },
};

for (const [plan, subscriptionStatus, accessUntil, effective, status] of [
  ['free', 'free', null, 'free', 'free'],
  ['premium', 'active', null, 'premium', 'active'],
  ['premium', 'active', later, 'premium', 'active'],
  ['premium', 'trialing', later, 'premium', 'trialing'],
  ['premium', 'canceling', later, 'premium', 'canceling'],
  ['premium', 'canceling', new Date(now), 'free', 'expired'],
  ['premium', 'trialing', earlier, 'free', 'expired'],
  ['premium', 'active', earlier, 'free', 'expired'],
  ['premium', 'past_due', later, 'free', 'past_due'],
  ['premium', 'payment_failed', later, 'free', 'payment_failed'],
  ['premium', 'canceled', later, 'free', 'canceled'],
  ['premium', 'expired', later, 'free', 'expired'],
]) {
  test('full feature matrix for ' + plan + '/' + subscriptionStatus + ' ending ' + (accessUntil?.toISOString() ?? 'without a deadline'), () => {
    const result = getEntitlements({ plan, subscriptionStatus, accessUntil }, now, {});
    assert.equal(result.plan, effective);
    assert.equal(result.status, status);
    assert.equal(result.accessUntil, accessUntil?.toISOString() ?? null);
    const column = effective === 'premium' ? 1 : 0;
    assert.deepEqual(result.capabilities, Object.fromEntries(Object.entries(matrix).map(([name, pair]) => [name, pair[column]])));
    assert.deepEqual(result.limits, limits[effective]);
  });
}

test('unknown or contradictory billing state and missing trial or cancellation dates cannot grant access', () => {
  for (const profile of [
    {}, { plan: 'premium' }, { plan: 'premium', subscriptionStatus: 'typo' },
    { plan: 'free', subscriptionStatus: 'active', accessUntil: later },
    { plan: 'premium', subscriptionStatus: 'trialing' }, { plan: 'premium', subscriptionStatus: 'canceling' },
    { plan: 'premium', subscriptionStatus: 'active', accessUntil: 'invalid' },
  ]) assert.equal(resolveSubscription(profile, now).plan, 'free');
});

test('service quotas accept zero and tier-specific overrides and reject invalid configuration', () => {
  const profile = { plan: 'premium', subscriptionStatus: 'active' };
  const env = { PLATFORM_PREMIUM_STORAGE_MIB: '0', PLATFORM_PREMIUM_VOICE_MINUTES: '125',
    PLATFORM_FREE_VOICE_MINUTES: '9', PLATFORM_PREMIUM_CONCURRENT_JOBS: '8' };
  assert.equal(getEntitlements(profile, now, env).limits.storageMiB, 0);
  assert.equal(getEntitlements(profile, now, env).limits.monthlyVoiceMinutes, 125);
  assert.equal(getEntitlements(profile, now, env).limits.maxConcurrentJobs, 8);
  assert.equal(getEntitlements({ plan: 'free' }, now, env).limits.monthlyVoiceMinutes, 9);
  for (const value of ['', '-1', '1.5', '0x10', '9007199254740993']) {
    assert.throws(() => getEntitlements(profile, now, { PLATFORM_PREMIUM_STORAGE_MIB: value }), RangeError);
  }
});

test('capability guards support flags, access levels and provider lists and reject unrecognized capabilities', () => {
  const actor = { entitlements: getEntitlements({ plan: 'free', subscriptionStatus: 'free' }, now, {}) };
  assert.equal(requireCapability(actor, 'voicePreviews'), actor);
  assert.equal(requireCapability(actor, 'chatProviders', 'byok'), actor);
  assert.equal(requireCapability(actor, 'usageHistory', 'meter'), actor);
  for (const [key, value] of [['chatProviders', 'managed'], ['usageHistory', 'detailed'], ['versionHistory', true], ['toString', true]]) {
    assert.throws(() => requireCapability(actor, key, value), { code: 'PLAN_REQUIRED', status: 403 });
  }
});
