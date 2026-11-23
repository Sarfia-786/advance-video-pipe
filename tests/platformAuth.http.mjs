import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BETTER_AUTH_URL || 'http://localhost:3000';

test('English and Chinese account routes render in the production app', async () => {
  for (const [path, heading] of [
    ['/login', 'Sign in'],
    ['/signup', 'Create platform account'],
    ['/forgot-password', 'Recover password'],
    ['/account', 'Account and settings'],
    ['/zh/login', '登录'],
    ['/zh/signup', '创建平台账户'],
    ['/zh/forgot-password', '找回密码'],
    ['/zh/account', '账户与设置'],
  ]) {
    const res = await fetch(BASE + path);
    assert.equal(res.status, 200, path + ' returned ' + res.status);
    const html = await res.text();
    assert.ok(html.includes(heading), path + ' missing heading ' + heading);
  }
});

test('anonymous, forged provider key and forged cookie cannot read private profile', async () => {
  for (const headers of [
    {},
    { 'X-API-KEY': 'fake-muapi-key', Authorization: 'Bearer fake-muapi-key' },
    { Cookie: 'better-auth.session_token=invalid' },
  ]) {
    const response = await fetch(BASE + '/api/platform/v1/me', { headers, redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { error: { code: 'AUTH_REQUIRED' } });
  }

  const workspace = await fetch(BASE + '/api/platform/v1/workspaces/personal%3Avictim', {
    headers: { 'X-API-KEY': 'fake-muapi-key', Authorization: 'Bearer fake-muapi-key' },
  });
  assert.equal(workspace.status, 401);
  assert.deepEqual(await workspace.json(), { error: { code: 'AUTH_REQUIRED' } });
});

test('auth route is handled locally, not forwarded to MuAPI', async () => {
  const session = await fetch(BASE + '/api/platform/v1/auth/get-session');
  assert.equal(session.status, 200);
  const crossOrigin = await fetch(BASE + '/api/platform/v1/auth/sign-in/email', {
    method: 'POST',
    // The local CI ingress assigns this request a fresh bucket after the dedicated throttle test.
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example', 'x-test-ingress-ip': '203.0.113.81' },
    body: JSON.stringify({ email: 'does-not-exist@example.test', password: 'NotMyPassword123456' }),
  });
  assert.equal(crossOrigin.status, 403, 'Unknown Origin should be denied');
});
