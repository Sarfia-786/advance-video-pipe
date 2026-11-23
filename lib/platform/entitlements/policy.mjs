// Only call with a profile read by the server. A subscription may outlive its paid access.
const statuses = new Set(['free', 'active', 'trialing', 'past_due', 'canceling', 'canceled', 'expired', 'payment_failed']);

export function resolveSubscription(profile, now = Date.now()) {
  const status = statuses.has(profile.subscriptionStatus) ? profile.subscriptionStatus : 'free';
  const end = profile.accessUntil == null ? null : new Date(profile.accessUntil).getTime();
  const accessUntil = Number.isFinite(end) ? new Date(end).toISOString() : null;
  if (profile.plan === 'premium' && ['active', 'trialing', 'canceling'].includes(status)) {
    if ((status === 'active' && end === null) || end > now) {
      return { plan: 'premium', status, accessUntil };
    }
    return { plan: 'free', status: 'expired', accessUntil };
  }
  return { plan: 'free', status, accessUntil };
}

const free = {
  dashboard: 'unified',
  folders: 'list',
  versionHistory: false,
  teamWorkspaces: false,
  workflowModes: ['manual'],
  workflowTemplates: 'starter',
  scriptToShort: false,
  chatProviders: ['byok'],
  scriptStudio: 'standard',
  sceneJsonSplitter: false,
  imageProviders: ['local', 'byok'],
  videoProviders: ['local', 'byok'],
  priorityQueue: false,
  assembly: 'basic',
  watermarkRequired: true,
  kenBurns: false,
  transitions: 'cuts',
  musicMixing: 'basic',
  captions: ['srt'],
  designStudio: 'thumbnail',
  brandKits: false,
  thumbnailVariants: false,
  voicePreviews: true,
  voiceCloning: false,
  multiSpeaker: false,
  autoDubbing: false,
  billing: ['free'],
  usageHistory: 'meter',
  commercialUse: 'provider_terms',
};

const premium = {
  ...free,
  folders: 'nested',
  versionHistory: true,
  teamWorkspaces: true,
  workflowModes: ['manual', 'automatic'],
  workflowTemplates: 'all',
  scriptToShort: true,
  chatProviders: ['byok', 'managed'],
  scriptStudio: 'advanced',
  sceneJsonSplitter: true,
  imageProviders: ['local', 'byok', 'managed'],
  videoProviders: ['local', 'byok', 'managed'],
  priorityQueue: true,
  assembly: 'advanced',
  watermarkRequired: false,
  kenBurns: true,
  transitions: 'advanced',
  musicMixing: 'advanced',
  captions: ['srt', 'animated'],
  designStudio: 'branding',
  brandKits: true,
  thumbnailVariants: true,
  voiceCloning: true,
  multiSpeaker: true,
  autoDubbing: true,
  billing: ['subscription', 'credit_packs'],
  usageHistory: 'detailed',
  commercialUse: 'eligibility_indicator',
};

const policies = {
  free: {
    capabilities: free,
    limits: { projectExpiryDays: 7, workflowTemplateCount: 2, batchMinClips: 0, batchMaxClips: 0, maxOutputHeight: 720 },
    storageMiB: 512, monthlyVoiceMinutes: 5, maxConcurrentJobs: 1,
  },
  premium: {
    capabilities: premium,
    limits: { projectExpiryDays: null, workflowTemplateCount: null, batchMinClips: 5, batchMaxClips: 10, maxOutputHeight: 2160 },
    storageMiB: 10240, monthlyVoiceMinutes: 60, maxConcurrentJobs: 3,
  },
};

function quota(env, key, fallback) {
  if (env[key] === undefined) return fallback;
  const raw = env[key];
  const value = Number(raw);
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new RangeError(key + ' must be a nonnegative safe integer');
  }
  return value;
}

export function getEntitlements(profile, now = Date.now(), env = process.env) {
  const subscription = resolveSubscription(profile, now);
  const policy = policies[subscription.plan];
  const prefix = 'PLATFORM_' + subscription.plan.toUpperCase() + '_';
  return {
    ...subscription,
    capabilities: structuredClone(policy.capabilities),
    limits: {
      ...policy.limits,
      storageMiB: quota(env, prefix + 'STORAGE_MIB', policy.storageMiB),
      monthlyVoiceMinutes: quota(env, prefix + 'VOICE_MINUTES', policy.monthlyVoiceMinutes),
      maxConcurrentJobs: quota(env, prefix + 'CONCURRENT_JOBS', policy.maxConcurrentJobs),
    },
  };
}
