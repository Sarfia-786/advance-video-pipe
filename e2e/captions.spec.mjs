import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const [path, text, add, download] of [
  ['/captions', 'Subtitle text', 'Add cue', 'Download SRT'],
  ['/zh/captions', '字幕文本', '添加字幕', '下载 SRT'],
]) {
  test('edit, preview and download ' + path, async ({ page }) => {
    await page.goto(path);
    await page.getByLabel(text, { exact: true }).fill('Hello 世界');
    await expect(page.locator('aside')).toContainText('Hello 世界');
    await page.getByRole('button', { name: add }).click();
    await page.getByLabel(text, { exact: true }).nth(1).fill('Second');
    const saved = page.waitForEvent('download');
    await page.getByRole('button', { name: download }).click();
    const file = await saved;
    expect(file.suggestedFilename()).toBe('captions.srt');
    expect(await readFile(await file.path(), 'utf8')).toBe(
      '1\r\n00:00:00,000 --> 00:00:02,000\r\nHello 世界\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\nSecond\r\n'
    );
  });
}
