import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { changeFolder } from '../lib/platform/projects/folders.mjs';
import { placeProject, projectHistory, restoreVersion } from '../lib/platform/projects/history.mjs';
import { createProject, deleteProject, getPrivateAsset, getProject, listProjects, removeAsset, saveProjectAsset, updateProject } from '../lib/platform/projects/repository.mjs';
import { projectStorage } from '../lib/platform/projects/storage.mjs';
import { cleanupProjects } from '../lib/platform/projects/cleanup.mjs';

const db = new pg.Pool({connectionString:process.env.DATABASE_URL});
const root = await mkdtemp(join(tmpdir(),'project-collaboration-'));
const storage = projectStorage('local',{PLATFORM_PROJECT_ROOT:root});
const owners = [];
async function member(premium=false) {
  const id = randomUUID();
  owners.push(id);
  await db.query('SELECT platform.provision_account_created($1,$2,20)',[id,'collab:'+id]);
  if (premium) await db.query("UPDATE platform.user_profiles SET plan='premium',subscription_status='active' WHERE user_id=$1",[id]);
  return id;
}
test.after(async()=>{
  try {
    await db.query('DELETE FROM platform.user_profiles WHERE user_id=ANY($1)',[owners]);
    await cleanupProjects(db,{storageFor:()=>storage});
  } finally { await db.end(); await rm(root,{recursive:true,force:true}); }
});
test('folder cycles roll back, restored scripts reopen with their exact files and copies outlive the source',async()=>{
  const user=await member(true), outsider=await member(true);
  const folder=await changeFolder(db,user,null,{name:'Campaign'});
  const child=await changeFolder(db,user,null,{name:'Spring',parentId:folder.id});
  await assert.rejects(changeFolder(db,user,null,{id:folder.id,parentId:child.id}),{code:'FOLDER_CYCLE'});
  assert.equal((await listProjects(db,user)).folders.find(f=>f.id===folder.id).parentId,null);
  const p=await createProject(db,user,{name:'Draft',folderId:folder.id});
  const file=await saveProjectAsset(db,user,p.id,{kind:'script',filename:'lines.txt',mediaType:'text/plain'},Buffer.from('Original file'),{storage});
  const first=await updateProject(db,user,p.id,{name:'Draft A',script:'First script',document:{voice:file.id},revision:file.projectRevision});
  const second=await updateProject(db,user,p.id,{name:'Draft B',script:'Second script',document:{},revision:first.revision});
  await removeAsset(db,user,p.id,file.id);
  await assert.rejects(getPrivateAsset(db,user,p.id,file.id),{status:404});
  // Replay after removing the live link must not restore it from provenance.
  await db.query(await readFile(new URL('../db/migrations/0007_project_collaboration.sql',import.meta.url),'utf8'));
  await assert.rejects(getPrivateAsset(db,user,p.id,file.id),{status:404});
  const history=await projectHistory(db,user,p.id);
  assert.ok(history.versions.some(v=>v.revision===first.revision && v.fileCount===1));
  await assert.rejects(restoreVersion(db,user,p.id,{version:first.revision,revision:second.revision}),{code:'PROJECT_CHANGED'});
  const restored=await restoreVersion(db,user,p.id,{version:first.revision,revision:(await getProject(db,user,p.id)).revision});
  const reopened=await getProject(db,user,p.id);
  assert.deepEqual([reopened.script,reopened.document,reopened.assets[0].id],['First script',{voice:file.id},file.id]);
  await assert.rejects(placeProject(db,outsider,p.id,{action:'duplicate',revision:restored.revision}),{status:404});
  const moved=await placeProject(db,user,p.id,{action:'move',folderId:child.id,revision:restored.revision});
  const copy=await placeProject(db,user,p.id,{action:'duplicate',name:'Copy',folderId:folder.id,revision:moved.revision});
  assert.deepEqual((await listProjects(db,user,{q:'dra',folder:child.id,kind:'script'})).projects.map(x=>x.id),[p.id]);
  assert.equal((await getProject(db,user,copy.id)).document.voice,file.id);
  await deleteProject(db,user,p.id);
  await cleanupProjects(db,{storageFor:()=>storage});
  assert.equal((await getPrivateAsset(db,user,copy.id,file.id)).asset.sourceProjectId,p.id);
  assert.equal((await storage.get(file.id)).toString(),'Original file');
  await deleteProject(db,user,copy.id);
  await cleanupProjects(db,{storageFor:()=>storage});
  await assert.rejects(storage.get(file.id),{code:'ENOENT'});
});
test('Free personal projects can use search and duplication while folder and version operations honor the live plan',async()=>{
  const user=await member();
  const p=await createProject(db,user,{name:'Free draft'});
  await assert.rejects(changeFolder(db,user,null,{name:'Premium'}),{code:'PLAN_REQUIRED'});
  await assert.rejects(projectHistory(db,user,p.id),{code:'PLAN_REQUIRED'});
  const duplicate=await placeProject(db,user,p.id,{action:'duplicate',name:'Duplicate',revision:1});
  assert.deepEqual((await listProjects(db,user,{q:'UpLiC'})).projects.map(x=>x.id),[duplicate.id]);
});
