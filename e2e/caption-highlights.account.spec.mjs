import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expectedSrt, words } from '../tests/fixtures/captionWords.mjs';
import { latestEmail, linkFromEmail } from '../tests/support/accountInbox.mjs';

test('only a verified Premium session downloads word highlights in either editor', async ({ context, page, baseURL }) => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const email = randomUUID() + '@example.test';
  const password = randomUUID();
  const headers = { origin: baseURL, 'x-test-ingress-ip': '192.0.2.251' };
  const api = '/api/platform/v1';
  const styled = () => context.request.post(api + '/captions/ass?plan=premium', {
    headers: { 'x-plan': 'premium' }, data: { words, plan: 'premium' },
  });
  try {
    expect((await styled()).status()).toBe(401);
    const signup = await context.request.post(api + '/auth/sign-up/email', { headers, data: { email, password, name: 'Caption editor' } });
    expect(signup.status()).toBe(200);
    await context.request.get(linkFromEmail(await latestEmail(email, 'Verify')), { maxRedirects: 0 });
    expect((await context.request.post(api + '/auth/sign-in/email', { headers, data: { email, password } })).status()).toBe(200);

    const profile = await (await context.request.get(api + '/me')).json();
    expect(profile.plan).toBe('free');
    expect((await styled()).status()).toBe(403);
    const srt = await context.request.post(api + '/captions/srt', { data: { words } });
    expect(await srt.text()).toBe(expectedSrt);
    await db.query("UPDATE platform.user_profiles SET plan='premium', subscription_status='active' WHERE user_id=$1", [profile.user.id]);

    for (const locale of ['en', 'zh']) {
      const copy = JSON.parse(await readFile(new URL('../messages/' + locale + '/captions.json', import.meta.url), 'utf8'));
      await page.goto(locale === 'zh' ? '/zh/captions' : '/captions');
      await page.getByRole('button', { name: copy.modes.words, exact: true }).click();
      await page.getByText(copy.importTitle, { exact: true }).click();
      await page.getByLabel(copy.importLabel).fill(JSON.stringify({ words }));
      await page.getByRole('button', { name: copy.importAction }).click();
      await page.getByRole('group', { name: copy.word + ' 1', exact: true }).getByLabel(copy.start).fill('155');
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: copy.downloadAss, exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('captions.ass');
      expect(await readFile(await file.path(), 'utf8')).toContain('Dialogue: 0,0:00:00.16,0:00:00.41,');
    }
    await db.query("UPDATE platform.user_profiles SET subscription_status='expired' WHERE user_id=$1", [profile.user.id]);
    expect((await styled()).status()).toBe(403);
  } finally {
    try { await db.query('DELETE FROM "user" WHERE email=$1', [email]); }
    finally { await db.end(); }
  }
});
