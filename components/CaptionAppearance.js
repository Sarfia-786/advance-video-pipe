'use client';

import { CAPTION_FONTS, CAPTION_STYLES, COLOR_FIELDS, HIGHLIGHTS, normalizeCaptionStyle, POSITIONS, STYLE_RANGES } from '@/lib/platform/captions/styles.mjs';
import styles from './CaptionEditor.module.css';

export default function CaptionAppearance({ copy, style, onChange }) {
  const set = (key, value) => onChange({ ...style, [key]: value });
  return <details className={styles.controls}>
    <summary>{copy.appearance}</summary>
    <div className={styles.controlGrid}>
      <label>{copy.preset}<select value={style.preset} onChange={e => onChange(normalizeCaptionStyle({ preset: e.target.value }))}>
        {Object.keys(CAPTION_STYLES).map(k => <option key={k} value={k}>{copy.styles[k]}</option>)}
      </select></label>
      <label>{copy.font}<select value={style.font} onChange={e => set('font', e.target.value)}>
        {CAPTION_FONTS.map(font => <option key={font}>{font}</option>)}
      </select></label>
      <label>{copy.position}<select value={style.position} onChange={e => set('position', e.target.value)}>
        {POSITIONS.map(v => <option key={v} value={v}>{copy.positions[v]}</option>)}
      </select></label>
      <label>{copy.highlight}<select value={style.highlight} onChange={e => set('highlight', e.target.value)}>
        {HIGHLIGHTS.map(v => <option key={v} value={v}>{copy.highlights[v]}</option>)}
      </select></label>
      {COLOR_FIELDS.map(key => <label key={key}>{copy[key]}
        <input type="color" value={style[key]} onChange={e => set(key, e.target.value)} />
      </label>)}
      {Object.entries(STYLE_RANGES).map(([key, [min, max]]) => <label key={key}>{copy[key]} <output>{style[key]}</output>
        <input type="range" min={min} max={max} value={style[key]} onChange={e => set(key, Number(e.target.value))} />
      </label>)}
    </div>
  </details>;
}
