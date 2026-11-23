import { CaptionError } from './srt.mjs';

export const CAPTION_FONTS = ['DejaVu Sans', 'Liberation Sans', 'Liberation Serif', 'Noto Sans CJK SC'];
export const HIGHLIGHTS = ['word', 'karaoke', 'line'];
export const POSITIONS = ['top', 'center', 'bottom'];

const standard = {
  preset: 'tiktok', font: 'DejaVu Sans', fontSize: 72, textColor: '#ffffff', highlightColor: '#99edee',
  strokeColor: '#101010', stroke: 4, shadow: 1, position: 'bottom', groupWords: 8,
  marginX: 8, marginY: 8, highlight: 'word', animationMs: 0,
};
export const CAPTION_STYLES = Object.freeze({
  tiktok: standard,
  hormozi: { ...standard, preset: 'hormozi', highlightColor: '#ffde37', fontSize: 88, stroke: 6, groupWords: 3, animationMs: 140 },
  karaoke: { ...standard, preset: 'karaoke', highlight: 'karaoke', highlightColor: '#ff75bf' },
  boldCenter: { ...standard, preset: 'boldCenter', position: 'center', fontSize: 104, stroke: 6, highlight: 'line', groupWords: 4 },
});
export const STYLE_RANGES = {
  fontSize: [24, 160], stroke: [0, 12], shadow: [0, 12], groupWords: [1, 12],
  marginX: [0, 30], marginY: [0, 35], animationMs: [0, 500],
};
export const COLOR_FIELDS = ['textColor', 'highlightColor', 'strokeColor'];

export function normalizeCaptionStyle(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CaptionError('CAPTION_STYLE');
  const preset = input.preset === undefined ? 'tiktok' : input.preset;
  if (typeof preset !== 'string' || !Object.hasOwn(CAPTION_STYLES, preset) ||
      Object.keys(input).some(key => !Object.hasOwn(standard, key))) throw new CaptionError('CAPTION_STYLE');
  const style = { ...CAPTION_STYLES[preset], ...input };
  if (!CAPTION_FONTS.includes(style.font) || !POSITIONS.includes(style.position) || !HIGHLIGHTS.includes(style.highlight)) {
    throw new CaptionError('CAPTION_STYLE');
  }
  for (const [key, [min, max]] of Object.entries(STYLE_RANGES)) {
    if (!Number.isInteger(style[key]) || style[key] < min || style[key] > max) throw new CaptionError('CAPTION_STYLE');
  }
  for (const key of COLOR_FIELDS) {
    if (typeof style[key] !== 'string' || !/^#[a-f0-9]{6}$/i.test(style[key])) throw new CaptionError('CAPTION_STYLE');
    style[key] = style[key].toLowerCase();
  }
  return style;
}
