import { test, expect } from '@playwright/test';
import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { latestEmail, linkFromEmail } from '../tests/support/accountInbox.mjs';

for (const [locale, root] of [['en',''],['zh','/zh']]) {
  test(locale + ' creates, reopens, edits, downloads and removes a private project', async ({ page, context, baseURL }) => {
    const copy = JSON.parse(await readFile(new URL('../messages/'+locale+'/projects.json',import.meta.url)));
    const identity = { email:randomUUID()+'@example.test',name:'Editor',password:randomUUID() };
    const db = new pg.Pool({ connectionString:process.env.DATABASE_URL });
    const headers = { origin:baseURL,'x-test-ingress-ip':'198.51.100.'+randomInt(1,240) };
    const auth = (path,data) => context.request.post('/api/platform/v1/auth/'+path,{headers,data});
    try {
      expect((await auth('sign-up/email',identity)).status()).toBe(200);
      await context.request.get(linkFromEmail(await latestEmail(identity.email,'Verify')));
      expect((await auth('sign-in/email',identity)).status()).toBe(200);
      await page.goto(root+'/account');
      await page.getByRole('link',{name:copy.title,exact:true}).click();
      await page.getByLabel(copy.name).fill('First cut');
      await page.getByRole('button',{name:copy.create}).click();
      await expect(page.getByRole('heading',{name:'First cut'})).toBeVisible();
      await expect(page.getByText(copy.days.replace('{n}',7))).toBeVisible();
      await page.getByLabel(copy.name).fill('Final cut');
      await page.getByRole('textbox',{name:copy.script,exact:true}).fill('A short script');
      await page.getByRole('textbox',{name:copy.document,exact:true}).fill('{"shots":[1,2]}');
      await page.getByRole('button',{name:copy.save}).click();
      await expect(page.getByRole('status')).toHaveText(copy.saved);
      await page.getByLabel(copy.file).setInputFiles({name:'lines.txt',mimeType:'text/plain',buffer:Buffer.from('Private lines')});
      await page.getByRole('button',{name:copy.upload}).click();
      await expect(page.getByText('lines.txt',{exact:false})).toBeVisible();
      const ready=page.waitForEvent('download');
      await page.getByRole('button',{name:copy.download}).click();
      const downloaded=await ready;
      expect(downloaded.suggestedFilename()).toBe('lines.txt');
      expect(await readFile(await downloaded.path(),'utf8')).toBe('Private lines');
      const id=new URL(page.url()).pathname.split('/').pop();
      await db.query("UPDATE platform.projects SET expires_at=now()+interval '2 hours' WHERE id=$1",[id]);
      await page.getByRole('link',{name:copy.list,exact:false}).click();
      await expect(page.getByText(copy.warning)).toBeVisible();
      await page.getByRole('link',{name:'Final cut'}).click();
      await expect(page.getByRole('textbox',{name:copy.script,exact:true})).toHaveValue('A short script');
      expect(JSON.parse(await page.getByRole('textbox',{name:copy.document,exact:true}).inputValue())).toEqual({shots:[1,2]});
      await page.getByRole('button',{name:copy.deleteProject}).click();
      await page.getByRole('button',{name:copy.yes}).click();
      await expect(page.getByText(copy.empty)).toBeVisible();
    } finally {
      await db.query('DELETE FROM "user" WHERE email=$1',[identity.email]);
      await db.end();
    }
  });
}
