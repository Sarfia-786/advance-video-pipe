import { test, expect } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { latestEmail, linkFromEmail } from '../tests/support/accountInbox.mjs';

for (const [locale, root] of [['en', ''], ['zh', '/zh']]) {
  test('verify, edit, recover and delete an account in ' + locale, async ({ page, context }) => {
    const copy = JSON.parse(await readFile(new URL('../messages/' + locale + '/accounts.json', import.meta.url), 'utf8'));
    const usageCopy = JSON.parse(await readFile(new URL('../messages/' + locale + '/usage.json', import.meta.url), 'utf8'));
    // The loopback test server models an ingress which overwrites the client-IP header.
    await context.setExtraHTTPHeaders({ 'x-test-ingress-ip': '192.0.2.' + randomInt(1, 255) });
    const email = randomUUID() + '@example.test';
    const password = randomUUID();
    const replacement = randomUUID();
    const press = name => page.getByRole('button', { name, exact: true }).click();
    const fill = (label, value) => page.getByLabel(label, { exact: true }).fill(value);
    const status = page.getByRole('status');
    const me = () => context.request.get('/api/platform/v1/me');
    const login = async secret => {
      await fill(copy.email, email);
      await fill(copy.password, secret);
      await press(copy.submitLogin);
      await expect(page).toHaveURL(url => url.pathname === root + '/account');
      await expect(page.getByText(email, { exact: true })).toBeVisible();
    };

    await page.goto(root + '/studio');
    await page.getByRole('link', { name: copy.account, exact: true }).click();
    await page.getByRole('link', { name: copy.newAccount }).click();
    await expect(page.getByRole('heading', { name: copy.signup, exact: true })).toBeVisible();
    await fill(copy.name, 'Studio member');
    await fill(copy.email, email);
    await fill(copy.password, password);
    await press(copy.submitSignup);
    await expect(status).toHaveText(copy.verify);
    expect((await me()).status()).toBe(401);

    await page.goto(linkFromEmail(await latestEmail(email, 'Verify')));
    await expect(page).toHaveURL(url => url.pathname === root + '/login');
    await expect(status).toHaveText(copy.verificationDone);
    await login(password);
    const profile = await (await me()).json();
    expect(profile.plan).toBe('free');
    expect(profile.creditBalance).toBe(process.env.PLATFORM_STARTER_CREDITS || '25');
    const access = copy.entitlements;
    await expect(page.getByRole('heading', { name: access.limits })).toBeVisible();
    await expect(page.getByText(access.days.replace('{n}', 7), { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: access.history })).toHaveCount(0);
    await page.getByRole('link', { name: copy.usage, exact: true }).click();
    await expect(page.getByRole('heading', { name: usageCopy.title, exact: true })).toBeVisible();
    await expect(page.getByText(usageCopy.available, { exact: true })).toBeVisible();
    await expect(page.getByText(usageCopy.reserved, { exact: true })).toBeVisible();
    await expect(page.getByText(usageCopy.freeHistory, { exact: true })).toBeVisible();
    await page.getByRole('link', { name: usageCopy.account, exact: true }).click();
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await db.query("UPDATE platform.user_profiles SET plan='premium', subscription_status='trialing', " +
        "access_until=now() + interval '1 day' WHERE user_id=$1", [profile.user.id]);
      await page.reload();
      await expect(page.getByText(access.statuses.trialing, { exact: true })).toBeVisible();
      await expect(page.getByText(access.persistent, { exact: true })).toBeVisible();
      await press(access.history);
      const ledger = page.getByRole('table', { name: access.history });
      await expect(ledger.getByText(access.kinds.starter_grant, { exact: true })).toBeVisible();
      await expect(ledger.getByRole('cell', { name: profile.creditBalance, exact: true })).toBeVisible();
      await page.getByRole('link', { name: copy.usage, exact: true }).click();
      await press(usageCopy.loadHistory);
      const usageLedger = page.getByRole('table', { name: usageCopy.history });
      await expect(usageLedger.getByText(usageCopy.kinds.starter_grant, { exact: true })).toBeVisible();
      await page.getByRole('link', { name: usageCopy.account, exact: true }).click();
    } finally {
      await db.end();
    }
    const workspaceURL = '/api/platform/v1/workspaces/' + encodeURIComponent(profile.personalWorkspaceId);
    expect((await (await context.request.get(workspaceURL)).json()).workspace.role).toBe('owner');
    expect((await context.request.get('/api/platform/v1/workspaces/personal%3Aunrelated')).status()).toBe(404);
    await fill(copy.name, 'Revised name');
    await press(copy.save);
    await expect(status).toHaveText(copy.saved);
    await page.reload();
    await expect(page.getByLabel(copy.name)).toHaveValue('Revised name');
    await press(copy.logout);
    await expect(page).toHaveURL(url => url.pathname === root + '/login');
    expect((await me()).status()).toBe(401);

    await page.getByRole('link', { name: copy.forgot }).click();
    await expect(page.getByRole('heading', { name: copy.recover, exact: true })).toBeVisible();
    await fill(copy.email, email);
    await press(copy.submitRecover);
    await expect(status).toHaveText(copy.resetSent);
    await page.goto(linkFromEmail(await latestEmail(email, 'Reset')));
    await expect(page).toHaveURL(url => url.pathname === root + '/reset-password');
    await fill(copy.newPassword, replacement);
    await fill(copy.confirmPassword, replacement);
    await press(copy.submitReset);
    await expect(status).toHaveText(copy.resetDone);
    await page.getByRole('link', { name: copy.haveAccount }).click();
    await expect(page.getByRole('heading', { name: copy.login, exact: true })).toBeVisible();
    await login(replacement);
    await fill(copy.password, replacement);
    await fill(copy.deleteConfirm, 'DELETE');
    await press(copy.deleteAccount);
    await expect(status).toHaveText(copy.deletePending);
    await page.goto(linkFromEmail(await latestEmail(email, 'Confirm account deletion')));
    await expect(page).toHaveURL(url => url.pathname === root + '/login');
    await expect(status).toHaveText(copy.deletionDone);
    expect((await me()).status()).toBe(401);
    expect((await context.request.get(workspaceURL)).status()).toBe(401);
  });
}

test('workspace reads stay inside the signed-in tenant and sign-out-all revokes both devices', async ({ browser, page, context, baseURL }) => {
  const other = await browser.newContext({ baseURL });
  const device = await browser.newContext({ baseURL });
  const headers = { origin: baseURL, 'x-test-ingress-ip': '198.51.100.' + randomInt(1, 255) };
  const url = '/api/platform/v1/auth';
  const me = '/api/platform/v1/me';
  const workspace = id => '/api/platform/v1/workspaces/' + encodeURIComponent(id);
  async function signIn(client, credentials) {
    const response = await client.request.post(url + '/sign-in/email', { headers, data: credentials });
    expect(response.status()).toBe(200);
  }
  async function register(client) {
    const credentials = { email: randomUUID() + '@example.test', password: randomUUID() };
    const response = await client.request.post(url + '/sign-up/email', { headers, data: { name: 'Workspace owner', ...credentials } });
    expect(response.status()).toBe(200);
    const link = linkFromEmail(await latestEmail(credentials.email, 'Verify'));
    await client.request.get(link, { headers });
    await signIn(client, credentials);
    return { credentials, profile: await (await client.request.get(me)).json() };
  }
  try {
    await context.setExtraHTTPHeaders(headers);
    const alice = await register(context);
    const bob = await register(other);
    await signIn(device, alice.credentials);
    expect(alice.profile.personalWorkspaceId).not.toEqual(bob.profile.personalWorkspaceId);
    for (const [client, own, foreign] of [
      [context, alice.profile, bob.profile], [other, bob.profile, alice.profile],
    ]) {
      expect((await client.request.get(workspace(own.personalWorkspaceId))).status()).toBe(200);
      expect((await client.request.get(workspace(foreign.personalWorkspaceId))).status()).toBe(404);
    }
    await page.goto('/account');
    await expect(page.getByText(alice.credentials.email)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out on all devices' }).click();
    await expect(page).toHaveURL(url => url.pathname === '/login');
    expect((await context.request.get(me)).status()).toBe(401);
    expect((await device.request.get(me)).status()).toBe(401);
    expect((await other.request.get(me)).status()).toBe(200);
  } finally {
    await device.close();
    await other.close();
  }
});
