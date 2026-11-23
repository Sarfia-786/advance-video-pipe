'use client';

import { useRef, useState } from 'react';
import { captionErrorMessage } from './captionDownload.mjs';
import styles from './CaptionEditor.module.css';

const endpoint = '/api/platform/v1/captions/saved';
async function request(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  const data = await res.json();
  if (!res.ok) throw data.error;
  return data;
}

export default function SavedCaptionDocuments({ copy, style, setStyle, getWords, openProject }) {
  const [docs, setDocs] = useState([]);
  const [active, setActive] = useState({});
  const [names, setNames] = useState({ project: '', preset: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pendingIds = useRef({});
  async function perform(action) {
    setBusy(true);
    setMessage('');
    try { await action(); }
    catch (error) {
      if (error?.code === 'AUTH_REQUIRED' || error?.code === 'PLAN_REQUIRED') {
        setDocs([]); setActive({}); setNames({ project: '', preset: '' });
      }
      setMessage(captionErrorMessage(error || {}, copy));
    }
    finally { setBusy(false); }
  }
  async function open(kind, id) {
    const record = id ? await request(endpoint + '?id=' + encodeURIComponent(id)) : null;
    if (record?.kind === 'project') openProject(record);
    if (record?.kind === 'preset') setStyle(record.style);
    setActive(prev => ({ ...prev, [kind]: record }));
    setNames(prev => ({ ...prev, [kind]: record?.name || '' }));
    delete pendingIds.current[kind];
  }
  async function save(kind) {
    const current = active[kind];
    const id = current?.id || (pendingIds.current[kind] ??= crypto.randomUUID());
    const body = { id, revision: current?.revision || 0, kind, name: names[kind], style };
    if (kind === 'project') body.words = getWords();
    const saved = await request(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setActive(prev => ({ ...prev, [kind]: saved }));
    setDocs(prev => [saved, ...prev.filter(item => item.id !== saved.id)]);
    delete pendingIds.current[kind];
    setMessage(copy.saved);
  }
  return <details className={styles.controls} onToggle={e => {
    if (e.currentTarget.open) perform(async () => setDocs((await request(endpoint)).documents));
  }}>
    <summary>{copy.savedItems}</summary>
    {['project', 'preset'].map(kind => <fieldset key={kind} disabled={busy}>
      <legend>{copy.kinds[kind]}</legend>
      <label>{copy.openSaved}<select value={active[kind]?.id || ''} onChange={e => perform(() => open(kind, e.target.value))}>
        <option value="">{copy.newItem}</option>
        {docs.filter(d => d.kind === kind).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select></label>
      <label>{copy.itemName}<input value={names[kind]} maxLength={80} onChange={e => setNames({ ...names, [kind]: e.target.value })} /></label>
      <button type="button" disabled={!names[kind].trim()} onClick={() => perform(() => save(kind))}>{copy.saveItem}</button>
    </fieldset>)}
    {message && <p role="status">{message}</p>}
  </details>;
}
