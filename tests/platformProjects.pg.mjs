import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { cleanupProjects } from '../lib/platform/projects/cleanup.mjs';
import { createProject, deleteProject, getProject, getPrivateAsset, listProjects, saveProjectAsset, updateProject } from '../lib/platform/projects/repository.mjs';
import { projectStorage } from '../lib/platform/projects/storage.mjs';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const root = await mkdtemp(join(tmpdir(), 'project-integration-'));
const storage = projectStorage('local', { PLATFORM_PROJECT_ROOT: root });
const cleanup = options => cleanupProjects(db, { storageFor: () => storage, ...options });
const metadata = { filename: 'script.txt', kind: 'script', mediaType: 'text/plain' };
const owners = [];
async function owner() {
  const id = randomUUID();
  owners.push(id);
  await db.query('SELECT platform.provision_account_created($1,$2,25)', [id, 'test:' + id]);
  return id;
}
test.after(async () => {
  try {
    await db.query('DELETE FROM platform.user_profiles WHERE user_id=ANY($1)', [owners]);
    await cleanup();
  } finally {
    await db.end();
    await rm(root, { recursive: true, force: true });
  }
});

test('saved documents, scripts and job asset provenance remain within the owner workspace', async () => {
  const a = await owner(), b = await owner();
  const p = await createProject(db,a,{ name: 'Opening', document: { scenes: [1] }, script: 'Hello' });
  assert.equal(+p.expiresAt - +p.createdAt, 7*86400000);
  const saved = await updateProject(db,a,p.id,{ name: 'Edited', script: 'New script', document: { scenes: [2] }, revision: 1 });
  assert.equal(saved.revision,2);
  await assert.rejects(updateProject(db,a,p.id,{ name: 'stale', revision: 1 }),{ code:'PROJECT_CHANGED' });
  const file = await saveProjectAsset(db,a,p.id,metadata,Buffer.from('lines'),{ storage, jobId:'render-012' });
  const view = await getProject(db,a,p.id);
  assert.deepEqual([view.script,view.document,view.assets[0].jobId,view.assets[0].projectId],['New script',{scenes:[2]},'render-012',p.id]);
  await assert.rejects(getPrivateAsset(db,b,p.id,file.id),{ status:404 });
  await assert.rejects(deleteProject(db,b,p.id),{ status:404 });
  assert.deepEqual((await listProjects(db,b)).projects,[]);
});
test('both sides of the deadline are enforced and two cleanups preserve billing', async () => {
  const a = await owner();
  const p = await createProject(db,a,{ name:'Free' });
  const file = await saveProjectAsset(db,a,p.id,metadata,Buffer.from('script'),{ storage });
  const clock = value => db.query("UPDATE platform.projects SET created_at=$2::timestamptz - interval '168 hours', expires_at=$2 WHERE id=$1",[p.id,value]);
  await clock(new Date(Date.now()+3000));
  assert.equal((await getProject(db,a,p.id)).name,'Free');
  await clock(new Date(Date.now()-1));
  await assert.rejects(getProject(db,a,p.id),{ code:'PROJECT_EXPIRED' });
  assert.equal((await listProjects(db,a)).projects.length,0);
  await assert.rejects(getPrivateAsset(db,a,p.id,file.id),{ status:410 });
  await assert.rejects(updateProject(db,a,p.id,{name:'late',revision:1}),{ status:410 });
  await assert.rejects(saveProjectAsset(db,a,p.id,metadata,Buffer.from('late'),{storage}),{ status:410 });
  assert.equal((await cleanup()).projects,1);
  assert.equal((await cleanup()).objects,0);
  await assert.rejects(storage.get(file.id),{ code:'ENOENT' });
  assert.equal((await db.query('SELECT amount FROM platform.credit_entries WHERE user_id=$1',[a])).rows[0].amount,'25');
});
test('cleanup waiting on an earlier upgrade observes the committed subscription and preserves the files', async () => {
  const a = await owner();
  const p = await createProject(db,a,{ name:'Upgrade' });
  const file = await saveProjectAsset(db,a,p.id,metadata,Buffer.from('kept'),{ storage });
  await db.query("UPDATE platform.projects SET expires_at=now()-interval '1 second' WHERE id=$1",[p.id]);
  const billing = await db.connect();
  let pending;
  try {
    await billing.query('BEGIN');
    await billing.query("UPDATE platform.user_profiles SET plan='premium',subscription_status='active' WHERE user_id=$1",[a]);
    const { rows:[{ pid }] } = await billing.query('SELECT pg_backend_pid() AS pid');
    pending = cleanup();
    let waited = false;
    for (let i=0; i<200 && !waited; i++) {
      const state = await db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid]);
      waited = state.rows[0].waiting;
      if (!waited) await delay(10);
    }
    assert.ok(waited,'cleanup should wait behind the subscription update');
    await billing.query('COMMIT');
    assert.equal((await pending).projects,0);
    assert.equal((await getProject(db,a,p.id)).expiresAt,null);
    assert.equal((await storage.get(file.id)).toString(),'kept');
  } finally {
    await billing.query('ROLLBACK'); billing.release(); if (pending) await pending;
  }
  await db.query("UPDATE platform.user_profiles SET subscription_status='canceling',access_until=now()-interval '1 minute' WHERE user_id=$1",[a]);
  assert.equal((await cleanup()).projects,1);
});
test('concurrent uploads share a quota and an interrupted write remains recoverable', async () => {
  const a = await owner(), previous = process.env.PLATFORM_FREE_STORAGE_MIB;
  process.env.PLATFORM_FREE_STORAGE_MIB='1';
  try {
    const p = await createProject(db,a,{ name:'Quota' });
    const bytes = Buffer.alloc(650000,'q');
    const attempts = await Promise.allSettled([1,2].map(() => saveProjectAsset(db,a,p.id,metadata,bytes,{ storage })));
    assert.deepEqual(attempts.map(result => result.status).sort(),['fulfilled','rejected']);
    assert.equal(attempts.find(result => result.status==='rejected').reason.code,'STORAGE_QUOTA');
    assert.equal((await listProjects(db,a)).usedBytes,bytes.length+2);
    let failedId;
    await assert.rejects(saveProjectAsset(db,a,p.id,metadata,Buffer.from('partial'),{storage:{backend:'local', async put(id,body) {
      failedId=id; await storage.put(id,body); throw new Error('write interrupted');
    }}}),/interrupted/);
    assert.equal((await cleanup({storageFor:()=>({ async remove() { throw new Error('offline'); } })})).failed,1);
    await db.query('UPDATE platform.project_object_deletions SET retry_at=now() WHERE asset_id=$1',[failedId]);
    assert.equal((await cleanup()).objects,1);
    await assert.rejects(storage.get(failedId),{code:'ENOENT'});
    const orphan = randomUUID();
    await db.query("INSERT INTO platform.project_assets(id,project_id,owner_id,backend,filename,media_type,kind,byte_size,created_at) " +
      "VALUES ($1,$2,$3,'local','old.txt','text/plain','script',5,now()-interval '1 hour')",[orphan,p.id,a]);
    await storage.put(orphan,Buffer.from('crash'));
    assert.equal((await cleanup()).abandoned,1);
    await assert.rejects(storage.get(orphan),{code:'ENOENT'});
  } finally {
    if (previous===undefined) delete process.env.PLATFORM_FREE_STORAGE_MIB; else process.env.PLATFORM_FREE_STORAGE_MIB=previous;
  }
});
test('account deletion drains private objects and keeps purchase and account audit records', async () => {
  const a = await owner();
  const p = await createProject(db,a,{name:'Retired'});
  const file = await saveProjectAsset(db,a,p.id,metadata,Buffer.from('delete me'),{storage});
  await db.query("INSERT INTO platform.credit_entries(user_id,kind,amount,idempotency_key,top_up_id) VALUES ($1,'purchase',7,$2,'paid-7')",[a,'purchase:'+a]);
  await db.query('INSERT INTO platform.account_deletions(user_id) VALUES ($1)',[a]);
  await db.query('DELETE FROM platform.user_profiles WHERE user_id=$1',[a]);
  const readMark=async()=>(await db.query('SELECT projects_cleaned_at FROM platform.account_deletions WHERE user_id=$1',[a])).rows[0].projects_cleaned_at;
  assert.equal(await readMark(),null);
  await cleanup({storageFor:()=>({async remove(){throw new Error('offline');}})});
  assert.equal(await readMark(),null);
  await db.query('UPDATE platform.project_object_deletions SET retry_at=now() WHERE owner_id=$1',[a]);
  await cleanup(); await cleanup();
  assert.ok(await readMark());
  await assert.rejects(storage.get(file.id),{code:'ENOENT'});
  const records=(await db.query('SELECT source, record FROM platform.retired_account_audit WHERE owner_id=$1',[a])).rows;
  assert.equal(records.filter(r=>r.source==='account_events').length,1);
  assert.ok(records.some(r=>r.record.kind==='purchase' && r.record.amount===7 && r.record.top_up_id==='paid-7'));
});
