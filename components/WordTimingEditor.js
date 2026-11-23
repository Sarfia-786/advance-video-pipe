'use client';

import { useMemo, useRef, useState } from 'react';
import { buildWordTrack, MAX_WORDS } from '@/lib/platform/captions/words.mjs';
import { formatTimestamp, MAX_TIME_MS } from '@/lib/platform/captions/srt.mjs';
import { captionErrorMessage, downloadCaptionTrack, saveCaptionFile } from './captionDownload.mjs';
import { normalizeCaptionStyle } from '@/lib/platform/captions/styles.mjs';
import CaptionAppearance from './CaptionAppearance';
import CaptionWordPreview from './CaptionWordPreview';
import SavedCaptionDocuments from './SavedCaptionDocuments';
import styles from './CaptionEditor.module.css';

function toMilliseconds(value) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function readDrafts(rows, groupWords) {
  try {
    const input = rows.map(({ startMs, endMs, ...word }) => ({
      ...word, startMs: toMilliseconds(startMs), endMs: toMilliseconds(endMs),
    }));
    return { track: buildWordTrack(input, groupWords, MAX_WORDS) };
  } catch (error) {
    return { error };
  }
}

export default function WordTimingEditor({ copy }) {
  const [rows, setRows] = useState([]);
  const nextId = useRef(1);
  const [input, setInput] = useState('');
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [style, setStyle] = useState(() => normalizeCaptionStyle());
  const [file, setFile] = useState(null);
  const result = useMemo(() => readDrafts(rows, style.groupWords), [rows, style.groupWords]);
  const cues = result.track?.cues ?? [];
  const duration = cues.at(-1)?.endMs ?? 0;
  const playhead = file ? time : Math.min(time, duration);
  const active = cues.find(cue => cue.startMs <= playhead && playhead < cue.endMs);

  function changeRows(next) {
    setRows(next);
    setMessage('');
  }

  function edit(id, field, value) {
    changeRows(rows.map(row => row.id === id ? { ...row, [field]: value } : row));
  }

  function openProject(data) {
    const nextStyle = data?.style === undefined ? style : normalizeCaptionStyle(data.style);
    const { words } = buildWordTrack(data?.words, nextStyle.groupWords, MAX_WORDS);
    changeRows(words.map(word => ({ ...word, id: nextId.current++, startMs: String(word.startMs), endMs: String(word.endMs) })));
    setStyle(nextStyle);
    setTime(words[0].startMs);
  }

  function importWords() {
    try {
      openProject(JSON.parse(input));
      setInput('');
      setMessage(copy.imported);
    } catch (error) {
      setMessage(error instanceof SyntaxError ? copy.invalidImport : captionErrorMessage(error, copy));
    }
  }

  function addWord() {
    changeRows([...rows, { id: nextId.current++, source: 'manual', text: '', speakerId: '', startMs: '', endMs: '' }]);
  }

  function saveTimings() {
    if (result.error) {
      setMessage(captionErrorMessage(result.error, copy));
      return;
    }
    const json = JSON.stringify({ words: result.track.words, style }, null, 2);
    saveCaptionFile(new Blob([json], { type: 'application/json' }), 'word-timings.json');
    setMessage(copy.timingsSaved);
  }

  async function download(event) {
    event.preventDefault();
    const format = event.nativeEvent.submitter?.value === 'ass' ? 'ass' : 'srt';
    if (result.error) {
      setMessage(captionErrorMessage(result.error, copy));
      return;
    }
    setBusy(true);
    try {
      setMessage(await downloadCaptionTrack({ words: result.track.words, ...(format === 'ass' ? { style } : {}) }, copy, format));
    } finally {
      setBusy(false);
    }
  }

  async function burnVideo() {
    if (!file || busy) return;
    if (result.error) { setMessage(captionErrorMessage(result.error, copy)); return; }
    setBusy(true);
    setMessage(copy.rendering);
    try {
      const body = new FormData();
      body.append('video', file);
      body.append('track', JSON.stringify({ words: result.track.words, style }));
      const res = await fetch('/api/platform/v1/captions/render', { method: 'POST', body });
      if (!res.ok) { setMessage(captionErrorMessage((await res.json()).error, copy)); return; }
      saveCaptionFile(await res.blob(), 'captioned.mp4');
      setMessage(copy.renderDone);
    } catch { setMessage(copy.network); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={download}>
      <div className={styles.columns}>
        <section aria-label={copy.modes.words}>
          <details className={styles.importer}>
            <summary>{copy.importTitle}</summary>
            <label>{copy.importLabel}
              <textarea value={input} rows={4} maxLength={1024 * 1024} placeholder={'{"words":[{"text":"Hello","startMs":100,"endMs":480,"speakerId":"a"}]}'}
                onChange={event => setInput(event.target.value)} />
            </label>
            <button type="button" disabled={busy || !input.trim()} onClick={importWords}>{copy.importAction}</button>
          </details>
          {!rows.length && <p className={styles.wordHint}>{copy.WORD_ALIGNMENT}</p>}
          {rows.map((row, index) => {
            const original = row.providerTiming;
            const changed = original && (toMilliseconds(row.startMs) !== original.startMs || toMilliseconds(row.endMs) !== original.endMs);
            return (
              <fieldset key={row.id} disabled={busy}>
                <legend>{copy.word} {index + 1}</legend>
                <label>{copy.wordText}<input type="text" value={row.text} maxLength={128} required onChange={event => edit(row.id, 'text', event.target.value)} /></label>
                <label>{copy.speaker}<input type="text" value={row.speakerId} maxLength={100} required onChange={event => edit(row.id, 'speakerId', event.target.value)} /></label>
                <label className={styles.breakLine}><input type="checkbox" checked={Boolean(row.lineBreakBefore)}
                  onChange={event => edit(row.id, 'lineBreakBefore', event.target.checked)} />{copy.lineBreakBefore}</label>
                <div className={styles.times}>
                  {['startMs', 'endMs'].map(field => (
                    <label key={field}>{field === 'startMs' ? copy.start : copy.end}
                      <input type="number" value={row[field]} min="0" max={MAX_TIME_MS} step="1" required onChange={event => edit(row.id, field, event.target.value)} />
                    </label>
                  ))}
                </div>
                <p className={styles.wordHint}>{original ? (changed ? copy.corrected : copy.provider) : copy.manual}
                  {changed && ' · ' + copy.original + ' ' + formatTimestamp(original.startMs) + ' – ' + formatTimestamp(original.endMs)}
                </p>
                <button type="button" onClick={() => changeRows(rows.filter(word => word.id !== row.id))}>{copy.remove}</button>
              </fieldset>
            );
          })}
          <button type="button" disabled={busy || rows.length >= MAX_WORDS} onClick={addWord}>{copy.addWord}</button>
        </section>
        <aside className={styles.panel}>
          <CaptionWordPreview copy={copy} active={active} time={playhead} setTime={setTime} duration={duration} style={style} file={file} />
          <CaptionAppearance copy={copy} style={style} onChange={setStyle} />
          <SavedCaptionDocuments copy={copy} style={style} setStyle={setStyle} openProject={openProject}
            getWords={() => { if (result.error) throw result.error; return result.track.words; }} />
          <button className={styles.primary} disabled={busy || !rows.length}>{busy ? copy.busy : copy.download}</button>
          <button type="submit" value="ass" className={styles.saveTimings} disabled={busy || !rows.length}>{copy.downloadAss}</button>
          <button type="button" className={styles.saveTimings} disabled={busy || !rows.length} onClick={saveTimings}>{copy.saveTimings}</button>
          <label className={styles.videoInput}>{copy.videoInput}<input type="file" accept="video/mp4,video/quicktime,.mp4,.mov"
            onChange={e => { setFile(e.target.files[0] || null); setMessage(''); }} /></label>
          <button type="button" disabled={busy || !file || !rows.length} onClick={burnVideo}>{copy.burnVideo}</button>
          <p role="status">{message}</p>
        </aside>
      </div>
    </form>
  );
}
