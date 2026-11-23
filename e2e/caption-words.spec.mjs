import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { words, expectedSrt } from '../tests/fixtures/captionWords.mjs';

for (const lang of [
  { path: '/captions', mode: 'Word timing', open: 'Import an aligned word track', input: 'Word timing JSON',
    replace: 'Replace track with imported words', start: 'Start (ms)', group: 'Word 1', corrected: 'Manually corrected timing',
    save: 'Save timing JSON', download: 'Download SRT', empty: 'No subtitle at this time' },
  { path: '/zh/captions', mode: '逐词时间', open: '导入已对齐的逐词字幕', input: '逐词时间 JSON',
    replace: '用导入的词替换当前轨道', start: '开始（毫秒）', group: '词 1', corrected: '已手动修正时间',
    save: '保存逐词时间 JSON', download: '下载 SRT', empty: '此时没有字幕' },
]) {
  test('preview actual words, correct and download both formats at ' + lang.path, async ({ page }) => {
    await page.goto(lang.path);
    await page.getByRole('button', { name: lang.mode, exact: true }).click();
    await page.getByText(lang.open, { exact: true }).click();
    await page.getByLabel(lang.input, { exact: true }).fill(JSON.stringify({ words }));
    await page.getByRole('button', { name: lang.replace }).click();
    const panel = page.getByRole('complementary');
    await expect(panel.locator('mark')).toHaveText('Hello');
    await expect(panel).toContainText('Ana');
    const first = page.getByRole('group', { name: lang.group, exact: true });
    await first.getByLabel(lang.start, { exact: true }).fill('125');
    await expect(first).toContainText(lang.corrected);
    await expect(first).toContainText('00:00:00,120');
    await expect(panel).toContainText(lang.empty);
    const slider = panel.getByRole('slider');
    await slider.press('End');
    await slider.press('ArrowLeft');
    await expect(panel.locator('mark')).toHaveText('。');
    await expect(panel).toContainText('Bo');

    const timingDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: lang.save }).click();
    const timingFile = await timingDownload;
    expect(timingFile.suggestedFilename()).toBe('word-timings.json');
    const saved = JSON.parse(await readFile(await timingFile.path(), 'utf8'));
    expect(saved.words[0]).toMatchObject({ startMs: 125, source: 'corrected', providerTiming: { startMs: 120, endMs: 410 } });

    const srtDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: lang.download }).click();
    const srtFile = await srtDownload;
    expect(await readFile(await srtFile.path(), 'utf8')).toBe(expectedSrt.replace('00:00:00,120', '00:00:00,125'));
  });
}

test('manual time fields start blank and survive a rejected import and mode switches', async ({ page }) => {
  await page.goto('/captions');
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await page.getByRole('button', { name: 'Add word' }).click();
  const first = page.getByRole('group', { name: 'Word 1', exact: true });
  await expect(first.getByLabel('Start (ms)')).toHaveValue('');
  await expect(first.getByLabel('End (ms)')).toHaveValue('');
  await first.getByLabel('Word or punctuation').fill('Hello');
  await first.getByLabel('Speaker ID').fill('reader');
  await first.getByLabel('Start (ms)').fill('0');
  await first.getByLabel('End (ms)').fill('650');
  await expect(page.getByRole('complementary').locator('mark')).toHaveText('Hello');
  await page.getByText('Import an aligned word track', { exact: true }).click();
  await page.getByLabel('Word timing JSON').fill('{"words":[]}');
  await page.getByRole('button', { name: 'Replace track with imported words' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Import aligned words' })).toBeVisible();
  await page.getByRole('button', { name: 'Subtitle cues', exact: true }).click();
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await expect(first.getByLabel('End (ms)')).toHaveValue('650');
  await expect(first).toContainText('Manual timing');
});
