'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { authClient } from '@/lib/platform/accounts/client.mjs';
import shared from './AccountPortal.module.css';
import styles from './ProjectWorkspace.module.css';

const api = '/api/platform/v1/projects';
async function request(path, init) {
  const res = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.code || 'network');
  return body;
}
function jsonForm(method, payload) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

function Retention({ expiresAt, now, copy }) {
  if (!expiresAt) return <p className={styles.note}>{copy.persistent}</p>;
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return <p>{copy.expired}</p>;
  const hour = 3600000;
  const [unit, duration] = left > 24*hour ? ['days',24*hour] : left > hour ? ['hours',hour] : ['minutes',60000];
  return <div className={styles.note}><time dateTime={expiresAt} title={new Date(expiresAt).toLocaleString()}>
    {copy[unit].replace('{n}', Math.ceil(left / duration))}</time>
    {left <= 24*hour && <p className={styles.warning}>{copy.warning}</p>}</div>;
}

function Workspace({ copy, root, projectId }) {
  const router = useRouter();
  const list = root + '/projects';
  const path = projectId ? api + '/' + projectId : api;
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const [documentText, setDocument] = useState('{}');
  const [kind, setKind] = useState('script');
  const [file, setFile] = useState(null);
  const [confirm, setConfirm] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    request(path, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setData(value);
      if (projectId) { setName(value.name); setScript(value.script); setDocument(JSON.stringify(value.document, null, 2)); }
    }).catch(error => {
      if (!controller.signal.aborted) { setData(null); setNotice(copy.errors[error.message] || copy.errors.network); }
    });
    return () => controller.abort();
  }, [path, projectId, copy, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!data) return;
    const deadlines = (projectId ? [data] : data.projects).filter(p => p.expiresAt).map(p => Date.parse(p.expiresAt));
    if (!deadlines.length) return;
    const timer = setTimeout(() => { setNow(Date.now()); setRefresh(n => n+1); },
      Math.max(0, Math.min(2147483647, deadlines.reduce((first, time) => Math.min(first, time), Infinity) - Date.now() + 1)));
    return () => clearTimeout(timer);
  }, [data, projectId]);

  async function act(action) {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await action(); }
    catch (error) {
      setNotice(copy.errors[error.message] || copy.errors.network);
      if (['PROJECT_EXPIRED','PROJECT_NOT_FOUND','AUTH_REQUIRED'].includes(error.message)) setData(null);
    } finally { setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    act(async () => {
      if (!projectId) {
        const project = await request(api, jsonForm('POST', { name }));
        router.push(list + '/' + project.id);
        return;
      }
      let document;
      try { document = JSON.parse(documentText); } catch { throw new Error('INVALID_PROJECT'); }
      const saved = await request(path, jsonForm('PATCH', { name, script, document, revision: data.revision }));
      setData(current => ({ ...current, ...saved })); setNotice(copy.saved);
    });
  }
  function deleteButton(target, label) {
    return confirm === target ? <span className={styles.actions}>{copy.confirm}
      <button disabled={busy} onClick={() => act(async () => {
        await request(target, { method: 'DELETE' });
        setConfirm('');
        if (projectId && target === path) router.push(list);
        else if (projectId) setData(current => ({ ...current, assets: current.assets.filter(a => target !== path + '/assets/' + a.id) }));
        else setRefresh(n => n+1);
      })}>{copy.yes}</button><button onClick={() => setConfirm('')}>{copy.cancel}</button>
    </span> : <button disabled={busy} onClick={() => setConfirm(target)}>{label}</button>;
  }
  const expired = data?.expiresAt && Date.parse(data.expiresAt) <= now;
  return <>
    {!data && !notice && <p>{copy.loading}</p>}
    {data && !expired && <>
      {projectId && <><h1>{data.name}</h1><Retention expiresAt={data.expiresAt} now={now} copy={copy}/></>}
      <form onSubmit={save} className={shared.form}>
        <label className={shared.field}>{copy.name}<input value={name} required maxLength={160}
          onChange={event => setName(event.target.value)} /></label>
        {projectId && <>
          <label className={shared.field}>{copy.script}<textarea className={styles.control} rows={7}
            value={script} onChange={event => setScript(event.target.value)}/></label>
          <label className={shared.field}>{copy.document}<textarea className={styles.control} rows={4}
            value={documentText} onChange={event => setDocument(event.target.value)}/></label>
        </>}
        <button className={shared.button} disabled={busy}>{projectId ? copy.save : copy.create}</button>
      </form>
      {!projectId ? <section className={styles.section}>
        <p className={styles.note}>{copy.used.replace('{used}', (data.usedBytes/1048576).toLocaleString(undefined,{maximumFractionDigits:2}))
          .replace('{quota}', data.quotaBytes/1048576)}</p>
        {!data.projects.length && <p>{copy.empty}</p>}
        <ul className={styles.rows}>{data.projects.map(p => <li className={styles.row} key={p.id}>
          <div><Link href={list + '/' + p.id}>{p.name}</Link><Retention expiresAt={p.expiresAt} now={now} copy={copy}/></div>
          <span className={styles.actions}>{deleteButton(api + '/' + p.id, copy.remove)}</span>
        </li>)}</ul>
      </section> : <>
        <section className={styles.section}><h2>{copy.files}</h2>
          <form className={shared.form} onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            act(async () => {
              const query = new URLSearchParams({ kind, filename: file.name });
              const asset = await request(path + '/assets?' + query, { method: 'POST', body: file });
              setData(current => ({ ...current, assets: [...current.assets, asset] }));
              setFile(null); form.reset();
            });
          }}>
            <label className={shared.field}>{copy.kind}<select className={styles.control} value={kind}
              onChange={event => setKind(event.target.value)}>{Object.entries(copy.types).map(([key,label]) =>
                <option value={key} key={key}>{label}</option>)}</select></label>
            <label className={shared.field}>{copy.file}<input required type="file" onChange={event => setFile(event.target.files[0])}/></label>
            <button className={shared.button} disabled={!file || busy}>{copy.upload}</button>
          </form>
          {!data.assets.length && <p className={styles.note}>{copy.noFiles}</p>}
          <ul className={styles.rows}>{data.assets.map(asset => <li className={styles.row} key={asset.id}>
            <span>{asset.filename} · {copy.types[asset.kind]}</span><span className={styles.actions}>
              <button disabled={busy} onClick={() => act(async () => {
                const ticket = await request(path + '/assets/' + asset.id + '/download', { method: 'POST' });
                const anchor = window.document.createElement('a'); anchor.href = ticket.url; anchor.download = asset.filename; anchor.click();
              })}>{copy.download}</button>{deleteButton(path + '/assets/' + asset.id, copy.remove)}
            </span></li>)}</ul>
        </section><div className={styles.actions}>{deleteButton(path, copy.deleteProject)}</div>
      </>}
    </>}
    {expired && <p>{copy.expired}</p>}
    <p className={shared.feedback} role="status">{notice}</p>
  </>;
}
export default function ProjectWorkspace({ copy, root, projectId }) {
  const { data: session, isPending } = authClient.useSession();
  return <main className={shared.page}><div className={shared.usageShell}>
    <Link className={shared.back} href={root + (projectId ? '/projects' : '/account')}>← {projectId ? copy.list : copy.account}</Link>
    <section className={shared.card}>
      {!projectId && <h1>{copy.title}</h1>}
      {isPending ? <p>{copy.loading}</p> : session?.user?.id ?
        <Workspace key={session.user.id + (projectId || '')} copy={copy} root={root} projectId={projectId} /> :
        <Link href={root + '/login'}>{copy.signin}</Link>}
    </section></div></main>;
}
