import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expectedSrt, words } from '../tests/fixtures/captionWords.mjs';
import { latestEmail, linkFromEmail } from '../tests/support/accountInbox.mjs';

test('only a verified Premium session downloads word highlights in either editor', async ({ browser, context, page, baseURL }) => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const email = randomUUID() + '@example.test';
  const password = randomUUID();
  const secondEmail = randomUUID() + '@example.test';
  const other = await browser.newContext({ baseURL });
  const headers = { origin: baseURL, 'x-test-ingress-ip': '192.0.2.251' };
  const api = '/api/platform/v1';
  const styled = () => context.request.post(api + '/captions/ass?plan=premium', {
    headers: { 'x-plan': 'premium' }, data: { words, plan: 'premium' },
  });
  try {
    expect((await styled()).status()).toBe(401);
    const render = () => context.request.post(api + '/captions/render?plan=premium', { data: { plan: 'premium' } });
    expect((await render()).status()).toBe(401);
    const signup = await context.request.post(api + '/auth/sign-up/email', { headers, data: { email, password, name: 'Caption editor' } });
    expect(signup.status()).toBe(200);
    await context.request.get(linkFromEmail(await latestEmail(email, 'Verify')), { maxRedirects: 0 });
    expect((await context.request.post(api + '/auth/sign-in/email', { headers, data: { email, password } })).status()).toBe(200);

    const profile = await (await context.request.get(api + '/me')).json();
    expect(profile.plan).toBe('free');
    expect((await styled()).status()).toBe(403);
    expect((await render()).status()).toBe(403);
    expect((await context.request.get(api + '/captions/saved')).status()).toBe(403);
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
    const zh = JSON.parse(await readFile(new URL('../messages/zh/captions.json', import.meta.url)));
    await page.getByText(zh.appearance, { exact: true }).click();
    await page.getByLabel(zh.preset, { exact: true }).selectOption('karaoke');
    await page.getByLabel(zh.font, { exact: true }).selectOption('Liberation Serif');
    await page.getByText(zh.savedItems, { exact: true }).click();
    const project = page.getByRole('group', { name: zh.kinds.project, exact: true });
    const preset = page.getByRole('group', { name: zh.kinds.preset, exact: true });
    for (const [section, name] of [[project, 'Two speakers'], [preset, 'Brand pink']]) {
      await section.getByLabel(zh.itemName).fill(name);
      const saved = page.waitForResponse(r => r.url().endsWith('/captions/saved') && r.request().method() === 'PUT');
      await section.getByRole('button', { name: zh.saveItem }).click();
      expect((await saved).status()).toBe(200);
    }
    const savedURL = api + '/captions/saved';
    const list = (await (await context.request.get(savedURL)).json()).documents;
    const doc = list.find(d => d.kind === 'project'), brand = list.find(d => d.kind === 'preset');
    const data = await (await context.request.get(savedURL + '?id=' + doc.id)).json();
    expect(data.words[0]).toMatchObject({ startMs: 155, source: 'corrected', providerTiming: { startMs: 120, endMs: 410 } });
    expect(data.style).toMatchObject({ preset: 'karaoke', font: 'Liberation Serif' });
    const write = body => context.request.put(savedURL, { data: body });
    expect((await write({ ...data, revision: 0 })).status()).toBe(200);
    const changed = await (await write({ ...data, name: 'Two voices' })).json();
    expect(changed.revision).toBe(2);
    expect((await write({ ...data, name: 'Stale edit' })).status()).toBe(409);

    await page.reload();
    await page.getByRole('button', { name: zh.modes.words, exact: true }).click();
    await page.getByText(zh.savedItems, { exact: true }).click();
    await preset.getByLabel(zh.openSaved).selectOption(brand.id);
    await project.getByLabel(zh.openSaved).selectOption(doc.id);
    await expect(page.getByRole('group', { name: zh.word + ' 1', exact: true }).getByLabel(zh.start)).toHaveValue('155');
    await page.getByText(zh.appearance, { exact: true }).click();
    await expect(page.getByLabel(zh.preset, { exact: true })).toHaveValue('karaoke');
    await expect(page.getByLabel(zh.font, { exact: true })).toHaveValue('Liberation Serif');
    const source = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x240:r=25:d=2',
      '-c:v', 'libx264', '-threads', '1', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
    await page.getByLabel(zh.videoInput).setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: source });
    const burned = page.waitForEvent('download');
    await page.getByRole('button', { name: zh.burnVideo, exact: true }).click();
    const mp4 = await burned;
    expect(mp4.suggestedFilename()).toBe('captioned.mp4');
    const info = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height',
      '-of', 'json', await mp4.path()]);
    expect(JSON.parse(info).streams[0]).toMatchObject({ codec_name: 'h264', width: 160, height: 240 });

    const secondHeaders = { ...headers, 'x-test-ingress-ip': '192.0.2.252' };
    const register = await other.request.post(api + '/auth/sign-up/email', { headers: secondHeaders, data: { email: secondEmail, password, name: 'Other editor' } });
    expect(register.status()).toBe(200);
    await other.request.get(linkFromEmail(await latestEmail(secondEmail, 'Verify')), { maxRedirects: 0 });
    expect((await other.request.post(api + '/auth/sign-in/email', { headers: secondHeaders, data: { email: secondEmail, password } })).status()).toBe(200);
    const second = await (await other.request.get(api + '/me')).json();
    await db.query("UPDATE platform.user_profiles SET plan='premium',subscription_status='active' WHERE user_id=$1", [second.user.id]);
    expect((await (await other.request.get(savedURL)).json()).documents).toEqual([]);
    expect((await other.request.get(savedURL + '?id=' + doc.id)).status()).toBe(404);
    expect((await other.request.put(savedURL, { data: { ...data, name: 'Other owner edit', revision: 2 } })).status()).toBe(409);
    await db.query("UPDATE platform.user_profiles SET subscription_status='expired' WHERE user_id=$1", [profile.user.id]);
    expect((await styled()).status()).toBe(403);
    expect((await render()).status()).toBe(403);
    expect((await context.request.get(savedURL)).status()).toBe(403);
  } finally {
    await other.close();
    try { await db.query('DELETE FROM "user" WHERE email=ANY($1)', [[email, secondEmail]]); }
    finally { await db.end(); }
  }
});
