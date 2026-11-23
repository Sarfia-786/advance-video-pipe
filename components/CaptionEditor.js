'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { formatTimestamp, MAX_CUES, MAX_TEXT, MAX_TIME_MS } from '@/lib/platform/captions/srt.mjs';
import WordTimingEditor from './WordTimingEditor';
import { downloadCaptionTrack } from './captionDownload.mjs';
import styles from './CaptionEditor.module.css';

const makeCue = (id, start) => ({ id, startMs: String(start), endMs: String(Math.min(start + 2000, MAX_TIME_MS)), text: '' });
const milliseconds = (value) => /^\d+$/.test(value) ? Number(value) : null;

export default function CaptionEditor({ copy, studioHref }) {
  const [mode, setMode] = useState('cues');
  const [rows, setRows] = useState(() => [makeCue(1, 0)]);
  const nextId = useRef(2);
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const cues = rows.map(({ startMs, endMs, text }) => ({ startMs: milliseconds(startMs), endMs: milliseconds(endMs), text }));
  const duration = Math.min(MAX_TIME_MS, Math.max(0, ...cues.map(cue => cue.endMs || 0)));
  const playhead = Math.min(time, duration);
  const active = cues.find(cue => cue.startMs !== null && cue.startMs <= playhead && playhead < cue.endMs);

  function updateRows(next) {
    setMessage('');
    setRows(next);
  }

  function edit(id, field, value) {
    updateRows(rows.map(row => row.id === id ? { ...row, [field]: value } : row));
  }

  async function download(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      setMessage(await downloadCaptionTrack({ cues }, copy));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <Link href={studioHref}>← {copy.studio}</Link>
      <header><h1>{copy.title}</h1><p>{copy.intro}</p></header>
      <div className={styles.modes} role="group" aria-label={copy.timingMode}>
        {['cues', 'words'].map(value => (
          <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
            {copy.modes[value]}
          </button>
        ))}
      </div>
      <div hidden={mode !== 'words'}><WordTimingEditor copy={copy} /></div>
      <form onSubmit={download} hidden={mode !== 'cues'}>
        <div className={styles.columns}>
          <section aria-label={copy.title}>
            {rows.map((row, index) => (
              <fieldset key={row.id} disabled={busy}>
                <legend>{copy.cue} {index + 1}</legend>
                <div className={styles.times}>
                  {['startMs', 'endMs'].map(field => (
                    <label key={field}>{field === 'startMs' ? copy.start : copy.end}
                      <input type="number" min="0" max={MAX_TIME_MS} step="1" required value={row[field]} onChange={event => edit(row.id, field, event.target.value)} />
                    </label>
                  ))}
                </div>
                <label>{copy.text}
                  <textarea rows="2" maxLength={MAX_TEXT} required value={row.text} onChange={event => edit(row.id, 'text', event.target.value)} />
                </label>
                <button type="button" onClick={() => updateRows(rows.filter(cue => cue.id !== row.id))}>{copy.remove}</button>
              </fieldset>
            ))}
            <button type="button" disabled={busy || rows.length >= MAX_CUES || duration >= MAX_TIME_MS}
              onClick={() => updateRows([...rows, makeCue(nextId.current++, duration)])}>{copy.add}</button>
          </section>
          <aside className={styles.panel}>
            <h2>{copy.preview}</h2>
            <div className={styles.screen}>{active?.text.trim() || copy.empty}</div>
            <label>{copy.playhead} <output>{formatTimestamp(playhead)}</output>
              <input type="range" min="0" max={duration} step="1" value={playhead} onChange={event => setTime(Number(event.target.value))} />
            </label>
            <button className={styles.primary} disabled={busy || !rows.length}>{busy ? copy.busy : copy.download}</button>
            <p role="status">{message}</p>
          </aside>
        </div>
      </form>
    </main>
  );
}
