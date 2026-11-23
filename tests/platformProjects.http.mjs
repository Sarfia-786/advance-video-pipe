import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { latestEmail, linkFromEmail } from './support/accountInbox.mjs';
import { cleanupProjects } from '../lib/platform/projects/cleanup.mjs';
import { maxAssetBytes } from '../lib/platform/projects/validation.mjs';

const origin = process.env.BETTER_AUTH_URL;
const api = '/api/platform/v1/projects';
const json = value => ({ body: JSON.stringify(value), headers: { 'content-type':'application/json' } });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iS1sAAAAASUVORK5CYII=', 'base64');
const db = new pg.Pool({connectionString:process.env.DATABASE_URL});
const emails = [];
async function verifiedOwner(ip) {
  const email = randomUUID() + '@example.test', password = randomUUID();
  emails.push(email);
  const auth = (path, fields) => fetch(origin+'/api/platform/v1/auth/'+path, {
    method:'POST', headers:{origin,'content-type':'application/json','x-test-ingress-ip':ip},body:JSON.stringify(fields) });
  assert.equal((await auth('sign-up/email',{name:'Project member',email,password})).status,200);
  await fetch(linkFromEmail(await latestEmail(email,'Verify')),{redirect:'manual'});
  const login=await auth('sign-in/email',{email,password});
  assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  return (method,path,{body,headers}={})=>fetch(origin+path,{method,body,headers:{cookie,origin,...headers}});
}
test.after(async()=>{try{
  await db.query('DELETE FROM "user" WHERE email=ANY($1)',[emails]);
  await cleanupProjects(db);
}finally{await db.end();}});

test('two verified owners use private script and media downloads with enforced type, size, quota and ticket deadlines', async () => {
  assert.equal((await fetch(origin+api)).status,401);
  const a=await verifiedOwner('203.0.113.121'), b=await verifiedOwner('203.0.113.122');
  const created=await a('POST',api,json({name:'Private project',script:'Draft',document:{format:1}}));
  assert.equal(created.status,201);
  const p=await created.json(), path=api+'/'+p.id;
  const owner=(await (await a('GET','/api/platform/v1/me')).json()).user.id;
  assert.equal((await b('GET',path)).status,404);
  assert.equal((await b('PATCH',path,json({name:'Changed',revision:1}))).status,404);
  assert.equal((await a('DELETE',path,{headers:{origin:'https://other.example'}})).status,403);
  const url=(kind,filename)=>path+'/assets?'+new URLSearchParams({kind,filename,jobId:'untrusted'});
  assert.equal((await b('POST',url('script','x.txt'),{body:'x'})).status,404);
  assert.equal((await a('POST',url('media','image.png'),{body:'text',headers:{'content-type':'image/png'}})).status,415);
  assert.equal((await a('POST',url('script','large.txt'),{body:Buffer.alloc(maxAssetBytes+1,65)})).status,413);
  // The CI HTTP server is launched with a one-MiB Free limit.
  assert.equal((await a('POST',url('script','quota.txt'),{body:Buffer.alloc(1048576,65)})).status,409);
  const assets=[];
  for(const [kind,filename,content,type] of [['script','脚本.txt',Buffer.from('保存 script'),'text/plain'],['media','still.png',png,'image/png']]) {
    const upload=await a('POST',url(kind,filename),{body:content,headers:{'content-type':type}});
    assert.equal(upload.status,201);
    const asset=await upload.json();
    assert.equal(asset.jobId,null);
    const endpoint=path+'/assets/'+asset.id+'/download';
    assert.equal((await b('POST',endpoint)).status,404);
    const link=await (await a('POST',endpoint)).json();
    assert.equal((await fetch(origin+link.url)).status,401);
    assert.equal((await b('GET',link.url)).status,404);
    assert.equal((await a('GET',endpoint)).status,403);
    const downloaded=await a('GET',link.url);
    assert.equal(downloaded.status,200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),content);
    assert.match(downloaded.headers.get('content-disposition'),/^attachment;/);
    assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
    if(process.env.PLATFORM_PROJECT_STORAGE==='s3') {
      const raw=process.env.PLATFORM_S3_ENDPOINT+'/'+process.env.PLATFORM_S3_BUCKET+'/projects/'+asset.id.slice(0,2)+'/'+asset.id;
      assert.equal((await fetch(raw)).status,403,'anonymous direct bucket access');
    }
    assets.push({asset,endpoint,link});
  }
  assert.deepEqual((await (await a('GET',path)).json()).assets.map(asset=>asset.filename),['脚本.txt','still.png']);
  await db.query("UPDATE platform.projects SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",[p.id]);
  const expiring=await (await a('POST',assets[0].endpoint)).json();
  await db.query("UPDATE platform.user_profiles SET plan='premium',subscription_status='active' WHERE user_id=$1",[owner]);
  await delay(Math.max(0,Date.parse(expiring.expiresAt)-Date.now()+30));
  assert.equal((await a('GET',expiring.url)).status,403);
  assert.equal((await a('GET',path)).status,200);
  const refreshed=await (await a('POST',assets[0].endpoint)).json();
  assert.equal((await a('GET',refreshed.url)).status,200);
  // Exercise a valid payload across Next middleware's default 10 MiB clone boundary.
  const large=Buffer.alloc(11*1048576,'L');
  const largeUpload=await a('POST',url('script','long.txt'),{body:large,headers:{'content-type':'text/plain'}});
  assert.equal(largeUpload.status,201);
  const largeAsset=await largeUpload.json();
  assert.equal(largeAsset.byteSize,large.byteLength);
  const largeLink=await (await a('POST',path+'/assets/'+largeAsset.id+'/download')).json();
  const largeBytes=Buffer.from(await (await a('GET',largeLink.url)).arrayBuffer());
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(largeBytes),hash(large));
  assert.equal((await a('DELETE',path+'/assets/'+assets[0].asset.id)).status,200);
  assert.equal((await a('GET',refreshed.url)).status,404);
  assert.equal((await a('DELETE',path)).status,200);
  assert.equal((await a('GET',assets[1].link.url)).status,404);
  assert.ok((await cleanupProjects(db)).objects>=3);
  assert.equal((await cleanupProjects(db)).objects,0);
});
