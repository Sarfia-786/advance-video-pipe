import { buildWordTrack, wordSeparator, WordTimingError } from './words.mjs';

const header = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1080',
  'PlayResY: 1920',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: WordHighlight,DejaVu Sans,72,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,86,86,160,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];

function timestamp(ticks) {
  const minutes = Math.floor(ticks / 6000);
  const pad = value => String(value).padStart(2, '0');
  return Math.floor(minutes / 60) + ':' + pad(minutes % 60) + ':' +
    pad(Math.floor(ticks / 100) % 60) + '.' + pad(ticks % 100);
}

function literal(text) {
  // A zero-width word joiner after a literal backslash keeps \N, \n and \h
  // visible as typed. Libass accepts escaped braces in dialogue text.
  return text.replaceAll('\\', '\\\u2060').replace(/[{}]/g, '\\$&');
}

export function serializeAss(words) {
  const { cues } = buildWordTrack(words);
  const lines = [...header];
  let wordNumber = 0;
  for (const cue of cues) {
    const tokens = cue.words.map((word, i) => ({
      text: literal(word.text), separator: wordSeparator(cue.words[i - 1]?.text, word.text),
    }));
    for (const [active, word] of cue.words.entries()) {
      wordNumber++;
      // Round shared boundaries in the same direction so a word never starts early.
      const start = Math.ceil(word.startMs / 10);
      const end = Math.ceil(word.endMs / 10);
      if (start === end) throw new WordTimingError('ASS_TIME_RESOLUTION', wordNumber);
      const text = tokens.map((token, i) => token.separator +
        (i === active ? '{\\1c&HEEED99&}' + token.text + '{\\r}' : token.text)).join('');
      lines.push('Dialogue: 0,' + timestamp(start) + ',' + timestamp(end) + ',WordHighlight,,0,0,0,,' + text);
    }
  }
  return lines.join('\n') + '\n';
}
