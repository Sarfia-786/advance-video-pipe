'use client';

import { useState } from 'react';
import { folderOptions, jsonForm, request } from '@/lib/platform/projects/client.mjs';
import shared from './AccountPortal.module.css';
import styles from './ProjectWorkspace.module.css';

export default function ProjectLibraryControls({ data, workspaces, filters, setFilters, copy, act, busy, refresh }) {
  const c=copy.collaboration;
  const [folderName,setFolderName]=useState('');
  const [parent,setParent]=useState('');
  const options=folderOptions(data.folders);
  const selected=data.folders.find(f=>f.id===filters.folder);
  const fields={className:styles.control,disabled:busy};
  const folderChange=(input,after)=>act(async()=>{
    await request('/api/platform/v1/workspaces/'+encodeURIComponent(data.workspaceId)+'/folders',jsonForm('POST',input));
    setFolderName(''); setParent('');
    if(after) after(); else refresh();
  });
  return <section className={styles.section}>
    <div className={styles.controls}>
      <label className={shared.field}>{c.workspace}<select {...fields} value={data.workspaceId}
        onChange={e=>setFilters({...filters,workspace:e.target.value,folder:'',q:'',kind:''})}>
        {workspaces.map(w=><option key={w.id} value={w.id}>{w.kind==='personal'?c.personal:w.name}</option>)}</select></label>
      <label className={shared.field}>{c.search}<input type="search" maxLength={200} value={filters.q}
        onChange={e=>setFilters({...filters,q:e.target.value})}/></label>
      <label className={shared.field}>{c.filterType}<select {...fields} value={filters.kind} onChange={e=>setFilters({...filters,kind:e.target.value})}>
        <option value="">{c.any}</option>{Object.entries(copy.types).map(([v,label])=><option value={v} key={v}>{label}</option>)}</select></label>
      {data.premium && <label className={shared.field}>{c.folder}<select {...fields} value={filters.folder} onChange={e=>{
        setFolderName('');setParent('');setFilters({...filters,folder:e.target.value});
      }}><option value="">{c.allFolders}</option><option value="root">{c.root}</option>
        {options.map(f=><option value={f.id} key={f.id}>{f.path}</option>)}</select></label>}
    </div>
    {data.premium && data.role!=='viewer' && <details className={styles.section}><summary>{c.organize}</summary>
      <div className={shared.form}><label className={shared.field}>{c.folderName}<input maxLength={160} value={folderName} onChange={e=>setFolderName(e.target.value)}/></label>
        <div className={styles.actions}><button disabled={busy||!folderName.trim()} onClick={()=>folderChange({name:folderName,parentId:selected?.id??null})}>{c.addFolder}</button>
          {selected && <button disabled={busy||!folderName.trim()} onClick={()=>folderChange({id:selected.id,name:folderName})}>{c.renameFolder}</button>}</div>
        {selected && <><label className={shared.field}>{c.parent}<select {...fields} value={parent} onChange={e=>setParent(e.target.value)}>
          <option value="">{c.root}</option>{options.filter(f=>f.id!==selected.id).map(f=><option value={f.id} key={f.id}>{f.path}</option>)}</select></label>
          <div className={styles.actions}><button disabled={busy} onClick={()=>folderChange({id:selected.id,parentId:parent||null})}>{c.moveFolder}</button>
          <button disabled={busy} onClick={()=>folderChange({id:selected.id,action:'delete'},()=>setFilters({...filters,folder:''}))}>{c.deleteFolder}</button></div></>}
      </div></details>}
  </section>;
}
