import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:3210';
export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: 'npm run start -- --hostname 127.0.0.1 --port 3210',
    url: baseURL + '/captions',
    reuseExistingServer: !process.env.CI,
  },
});
