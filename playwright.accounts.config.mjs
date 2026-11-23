import { defineConfig } from '@playwright/test';

const origin = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000');
if (!['localhost', '127.0.0.1'].includes(origin.hostname) || origin.protocol !== 'http:') {
  throw new Error('Run account browser fixtures against a local HTTP test server');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'accounts.spec.mjs',
  use: { baseURL: origin.origin },
  webServer: {
    command: 'npm run start -- --hostname 127.0.0.1 --port ' + (origin.port || '80'),
    url: origin.origin + '/login',
    env: { BETTER_AUTH_URL: origin.origin, AUTH_TRUSTED_IP_HEADER: 'x-test-ingress-ip' },
    reuseExistingServer: false,
  },
});
