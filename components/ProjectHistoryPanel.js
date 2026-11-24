'use client';

import { useEffect, useState } from 'react';
import { folderOptions, jsonForm, request } from '@/lib/platform/projects/client.mjs';
import shared from './AccountPortal.module.css';
import styles from './ProjectWorkspace.module.css';

export default function ProjectHistoryPanel({ project, workspaces, copy, act, busy, dirty, reload, openCopy }) {
  const c=copy.collaboration, path='/api/platform/v1/projects/'+project.id;
  const [target,setTarget]=useState(project.workspaceId);
  const [folders,setFolders]=useState(project.folders);
  const [folder,setFolder]=useState(project.folderId||'');
  const [name,setName]=useState('');
  const [versions,setVersions]=useState([]);
  const [version,setVersion]=useState('');
  const [error,setError]=useState('');
  const canEdit=project.role!=='viewer';
  useEffect(()=>{
    const abort=new AbortController();
    if(target===project.workspaceId) {setFolders(project.folders);setFolder(project.folderId||'');}
    else {
      setFolders([]);setFolder('');
      request('/api/platform/v1/workspaces/'+encodeURIComponent(target)+'/folders',{signal:abort.signal})
        .then(({folders})=>{if(!abort.signal.aborted)setFolders(folders);})
        .catch(e=>{if(!abort.signal.aborted)setError(copy.errors[e.message]||copy.errors.network);});
    }
    return ()=>abort.abort();
  },[target,project.workspaceId,project.folderId,project.folders,copy]);
  useEffect(()=>{
    const abort=new AbortController();
    if(project.premium) request(path+'/versions',{signal:abort.signal}).then(({versions})=>{
      if(!abort.signal.aborted){setVersions(versions);setVersion('');}
    }).catch(e=>{if(!abort.signal.aborted)setError(copy.errors[e.message]||copy.errors.network);});
    return ()=>abort.abort();
  },[path,project.revision,project.premium,copy]);
  function place(action) {
    act(async()=>{
      const result=await request(path+'/placement',jsonForm('POST',{action,revision:project.revision,workspaceId:target,
        folderId:folder||null,...(action==='duplicate'?{name:name.trim()||project.name}:{})}));
      if(action==='duplicate') openCopy(result); else reload(result);
    });
  }
  return <>
    {canEdit && <details className={styles.section}><summary>{c.actions}</summary><div className={shared.form}>
      {project.role==='owner' && <label className={shared.field}>{c.destinationWorkspace}<select className={styles.control} value={target} onChange={e=>setTarget(e.target.value)}>
        {workspaces.filter(w=>w.role==='owner').map(w=><option value={w.id} key={w.id}>{w.kind==='personal'?c.personal:w.name}</option>)}</select></label>}
      {project.premium && <label className={shared.field}>{c.destinationFolder}<select className={styles.control} value={folder} onChange={e=>setFolder(e.target.value)}>
        <option value="">{c.root}</option>{folderOptions(folders).map(f=><option value={f.id} key={f.id}>{f.path}</option>)}</select></label>}
      {project.premium && <button className={shared.historyButton} disabled={busy||dirty} onClick={()=>place('move')}>{c.moveProject}</button>}
      <label className={shared.field}>{c.copyName}<input value={name} maxLength={160} placeholder={project.name} onChange={e=>setName(e.target.value)}/></label>
      <button className={shared.historyButton} disabled={busy||dirty} onClick={()=>place('duplicate')}>{c.duplicate}</button>
      {dirty && <p>{c.saveFirst}</p>}
    </div></details>}
    {project.premium && <section className={styles.section}><h2>{c.history}</h2>
      {versions.length ? <label className={shared.field}>{c.revision}<select className={styles.control} value={version} onChange={e=>setVersion(e.target.value)}>
        <option value="">{c.selectRevision}</option>{versions.map(v=><option key={v.revision} value={v.revision}>
          {v.revision} · {v.name} · {new Date(v.createdAt).toLocaleString()} · {c.files.replace('{n}',v.fileCount)}</option>)}</select></label> : <p>{c.noVersions}</p>}
      {canEdit && <button className={shared.historyButton} disabled={busy||dirty||!version||Number(version)===project.revision} onClick={()=>act(async()=>{
        const restored=await request(path+'/versions',jsonForm('POST',{revision:project.revision,version:Number(version)}));reload(restored);
      })}>{c.restore}</button>}
    </section>}
    {error && <p role="alert">{error}</p>}
  </>;
}
