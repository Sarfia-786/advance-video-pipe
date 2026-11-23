'use client';

import { useEffect, useRef, useState } from 'react';
import { wordSeparator } from '@/lib/platform/captions/words.mjs';
import { formatTimestamp } from '@/lib/platform/captions/srt.mjs';
import styles from './CaptionEditor.module.css';

export default function CaptionWordPreview({ copy, active, time, setTime, duration, style, file }) {
  const player = useRef(null);
  const [src, setSrc] = useState('');
  const [media, setMedia] = useState({ aspect: 9 / 16, duration: 0 });
  useEffect(() => {
    setMedia({ aspect: 9 / 16, duration: 0 });
    if (!file) { setSrc(''); return; }
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    const video = player.current;
    if (!video?.requestVideoFrameCallback) return;
    let handle;
    const frame = (_, meta) => {
      setTime(Math.round(meta.mediaTime * 1000));
      handle = video.requestVideoFrameCallback(frame);
    };
    handle = video.requestVideoFrameCallback(frame);
    return () => video.cancelVideoFrameCallback(handle);
  }, [src, setTime]);
  const width = 1080 * Math.max(1, media.aspect);
  const size = n => (n * 100 / width) + 'cqw';
  const inset = style.marginY + '%';
  const fade = style.animationMs && active && style.highlight !== 'word'
    ? Math.min(1, Math.max(0, (time - active.startMs) / style.animationMs)) : 1;
  const caption = {
    left: style.marginX + '%', right: style.marginX + '%', top: style.position === 'bottom' ? undefined : style.position === 'center' ? '50%' : inset,
    bottom: style.position === 'bottom' ? inset : undefined, transform: style.position === 'center' ? 'translateY(-50%)' : undefined,
    fontFamily: style.font + ', sans-serif', fontSize: size(style.fontSize), color: style.textColor,
    WebkitTextStroke: size(style.stroke * 2) + ' ' + style.strokeColor, paintOrder: 'stroke fill', opacity: fade,
    textShadow: style.shadow ? size(style.shadow) + ' ' + size(style.shadow) + ' 0 #0008' : undefined,
  };
  function wordText(word) {
    const current = time >= word.startMs && time < word.endMs;
    if (style.highlight === 'line') return word.text;
    if (!current) return style.highlight === 'karaoke' && time >= word.endMs ? <span style={{ color: style.highlightColor }}>{word.text}</span> : word.text;
    const elapsed = time - word.startMs;
    const fraction = 100 * elapsed / (word.endMs - word.startMs);
    const effect = style.highlight === 'karaoke'
      ? { backgroundImage: 'linear-gradient(to right,' + style.highlightColor + ' ' + fraction + '%,' + style.textColor + ' ' + fraction + '%)', backgroundClip: 'text', color: 'transparent' }
      : { color: style.highlightColor, transform: style.animationMs ? 'scale(' + (1 + .18 * Math.max(0, 1 - elapsed / Math.min(style.animationMs, word.endMs - word.startMs))) + ')' : undefined };
    return <mark style={effect}>{word.text}</mark>;
  }
  return <>
    <h2>{copy.wordPreview}</h2>
    <div className={styles.stage} style={{ aspectRatio: media.aspect, maxWidth: 'min(100%, ' + (22 * media.aspect) + 'rem)' }}>
      {src && <video ref={player} src={src} playsInline preload="metadata" onLoadedMetadata={({ currentTarget: video }) =>
        setMedia({ aspect: video.videoWidth / video.videoHeight || 9 / 16, duration: Math.round(video.duration * 1000) || 0 })}
        onTimeUpdate={({ currentTarget: video }) => setTime(Math.round(video.currentTime * 1000))} />}
      {active ? <p className={styles.overlay} style={caption}>{active.words.map((word, i) => <span key={word.startMs}>
        {wordSeparator(active.words[i - 1]?.text, word.text)}{wordText(word)}
      </span>)}</p> : <span className={styles.silent}>{copy.empty}</span>}
    </div>
    {active && <small>{active.speakerId}</small>}
    {src && <button type="button" onClick={() => { const v = player.current; if (v.paused) v.play().catch(() => {}); else v.pause(); }}>{copy.playPause}</button>}
    <label>{copy.playhead} <output>{formatTimestamp(time)}</output>
      <input type="range" min="0" max={Math.max(duration, media.duration)} step="1" value={time} onChange={event => {
        const ms = Number(event.target.value);
        setTime(ms);
        if (player.current && media.duration) player.current.currentTime = Math.min(ms, media.duration) / 1000;
      }} />
    </label>
  </>;
}
