import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_BASE_PATH, assertAuthConfigured } from '../lib/platform/accounts/auth.mjs';
import { assertSameOriginLink, validateMailSettings } from '../lib/platform/accounts/email.mjs';

test('account API stays in the platform namespace, away from MuAPI', () => {
  assert.equal(AUTH_BASE_PATH, '/api/platform/v1/auth');
});

test('auth refuses missing signing secrets, database and public origin', () => {
  const valid = {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test',
    BETTER_AUTH_SECRET: '1234567890abcdef1234567890abcdef',
    BETTER_AUTH_URL: 'https://studio.example.test',
    NODE_ENV: 'production',
  };
  assert.equal(assertAuthConfigured(valid), true);
  for (const key of ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL']) {
    const env = { ...valid };
    delete env[key];
    assert.throws(() => assertAuthConfigured(env));
  }
  assert.throws(() => assertAuthConfigured({ ...valid, BETTER_AUTH_URL: 'http://studio.example.test' }));
  assert.throws(() => assertAuthConfigured({ ...valid, BETTER_AUTH_URL: 'https://studio.example.test/redirect' }));
  assert.equal(assertAuthConfigured({ ...valid, BETTER_AUTH_URL: 'http://localhost:3000' }), true);
});

test('mail transport requires SMTP configuration, never silently drops verification', () => {
  const valid = { SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_FROM: 'Studio <noreply@example.test>' };
  assert.deepEqual(validateMailSettings(valid), {
    host: 'localhost', port: 1025, from: valid.SMTP_FROM, secure: false,
  });
  assert.throws(() => validateMailSettings({}));
  assert.throws(() => validateMailSettings({ ...valid, SMTP_PORT: '0' }));
  assert.throws(() => validateMailSettings({ ...valid, SMTP_USER: 'user' }));
});

test('email callbacks reject attacker-hosted verification or recovery links', () => {
  assert.equal(
    assertSameOriginLink('https://studio.example.test/api/platform/v1/auth/verify-email?token=abc',
      'https://studio.example.test'),
    'https://studio.example.test/api/platform/v1/auth/verify-email?token=abc',
  );
  assert.throws(() => assertSameOriginLink('https://evil.example/reset-password', 'https://studio.example.test'));
  assert.throws(() => assertSameOriginLink('javascript:alert(1)', 'https://studio.example.test'));
});
