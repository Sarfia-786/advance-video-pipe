'use client';

import { useMemo, useRef, useState } from 'react';
import { buildWordTrack, MAX_WORDS, wordSeparator } from '@/lib/platform/captions/words.mjs';
import { formatTimestamp, MAX_TIME_MS } from '@/lib/platform/captions/srt.mjs';
import { captionErrorMessage, downloadCaptionTrack, saveCaptionFile } from './captionDownload.mjs';
import styles from './CaptionEditor.module.css';

function toMilliseconds(value) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function readDrafts(rows) {
  try {
    const input = rows.map(({ startMs, endMs, ...word }) => ({
      ...word, startMs: toMilliseconds(startMs), endMs: toMilliseconds(endMs),
    }));
    return { track: buildWordTrack(input) };
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
  const result = useMemo(() => readDrafts(rows), [rows]);
  const cues = result.track?.cues ?? [];
  const duration = cues.at(-1)?.endMs ?? 0;
  const playhead = Math.min(time, duration);
  const active = cues.find(cue => cue.startMs <= playhead && playhead < cue.endMs);

  function changeRows(next) {
    setRows(next);
    setMessage('');
  }

  function edit(id, field, value) {
    changeRows(rows.map(row => row.id === id ? { ...row, [field]: value } : row));
  }

  function importWords() {
    try {
      const { words } = buildWordTrack(JSON.parse(input)?.words);
      changeRows(words.map(word => ({ ...word, id: nextId.current++, startMs: String(word.startMs), endMs: String(word.endMs) })));
      setTime(words[0].startMs);
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
    const json = JSON.stringify({ words: result.track.words }, null, 2);
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
      setMessage(await downloadCaptionTrack({ words: result.track.words }, copy, format));
    } finally {
      setBusy(false);
    }
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
          <h2>{copy.wordPreview}</h2>
          <div className={styles.screen}>
            {active ? <div><small>{active.speakerId}</small><p>{active.words.map((word, index) => (
              <span key={word.startMs}>{wordSeparator(active.words[index - 1]?.text, word.text)}
                {word.startMs <= playhead && playhead < word.endMs ? <mark>{word.text}</mark> : word.text}
              </span>
            ))}</p></div> : copy.empty}
          </div>
          <label>{copy.playhead} <output>{formatTimestamp(playhead)}</output>
            <input type="range" min="0" max={duration} step="1" value={playhead} onChange={event => setTime(Number(event.target.value))} />
          </label>
          <button className={styles.primary} disabled={busy || !rows.length}>{busy ? copy.busy : copy.download}</button>
          <button type="submit" value="ass" className={styles.saveTimings} disabled={busy || !rows.length}>{copy.downloadAss}</button>
          <button type="button" className={styles.saveTimings} disabled={busy || !rows.length} onClick={saveTimings}>{copy.saveTimings}</button>
          <p role="status">{message}</p>
        </aside>
      </div>
    </form>
  );
}
