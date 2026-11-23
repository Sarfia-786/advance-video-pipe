import { MAX_WORDS, buildWordTrack, wordSeparator, WordTimingError } from './words.mjs';
import { normalizeCaptionStyle } from './styles.mjs';

function timestamp(ticks) {
  const minutes = Math.floor(ticks / 6000);
  const pad = value => String(value).padStart(2, '0');
  return Math.floor(minutes / 60) + ':' + pad(minutes % 60) + ':' +
    pad(Math.floor(ticks / 100) % 60) + '.' + pad(ticks % 100);
}

function literal(text) {
  // Prevent typed backslashes from combining with N, n or h into ASS commands.
  return text.replaceAll('\\', '\\\u2060').replace(/[{}]/g, '\\$&');
}

function bgr(color) {
  return (color.slice(5, 7) + color.slice(3, 5) + color.slice(1, 3)).toUpperCase();
}

export function serializeAss(words, inputStyle, canvas = { width: 1080, height: 1920 }) {
  const style = normalizeCaptionStyle(inputStyle);
  const { cues } = buildWordTrack(words, style.groupWords, MAX_WORDS);
  const scale = 1080 / Math.min(canvas.width, canvas.height);
  const width = Math.round(canvas.width * scale), height = Math.round(canvas.height * scale);
  const marginX = Math.round(width * style.marginX / 100);
  const marginY = Math.round(height * style.marginY / 100);
  const base = bgr(style.textColor), highlight = bgr(style.highlightColor);
  const align = { top: 8, center: 5, bottom: 2 }[style.position];
  const lines = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + width, 'PlayResY: ' + height,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: ' + ['WordHighlight', style.font, style.fontSize, '&H00' + base, '&H00' + base, '&H00' + bgr(style.strokeColor),
      '&H80000000', -1, 0, 0, 0, 100, 100, 0, 0, 1, style.stroke, style.shadow, align, marginX, marginX, marginY, 1].join(','),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const emit = (start, end, text) => lines.push('Dialogue: 0,' + timestamp(start) + ',' + timestamp(end) + ',WordHighlight,,0,0,0,,' + text);
  let wordNumber = 0;
  for (const cue of cues) {
    const tokens = cue.words.map((word, i) => {
      wordNumber++;
      const start = Math.ceil(word.startMs / 10), end = Math.ceil(word.endMs / 10);
      if (start === end) throw new WordTimingError('ASS_TIME_RESOLUTION', wordNumber);
      return { start, end, text: literal(word.text), separator: i && word.lineBreakBefore ? '\\N' : wordSeparator(cue.words[i - 1]?.text, word.text) };
    });
    const start = tokens[0].start, end = tokens.at(-1).end;
    if (style.highlight === 'word') {
      for (const [active, word] of tokens.entries()) {
        const duration = Math.min(style.animationMs, (word.end - word.start) * 10);
        const pop = duration ? '\\fscx118\\fscy118\\t(0,' + duration + ',\\fscx100\\fscy100)' : '';
        emit(word.start, word.end, tokens.map((token, i) => token.separator + (i === active
          ? '{\\1c&H' + highlight + '&' + pop + '}' + token.text + '{\\r}' : token.text)).join(''));
      }
    } else {
      const fade = style.animationMs ? '{\\fad(' + Math.min(style.animationMs, (end - start) * 10) + ',0)}' : '';
      const text = style.highlight === 'karaoke'
        ? '{\\1c&H' + highlight + '&\\2c&H' + base + '&}' + tokens.map(t => '{\\kf' + (t.end - t.start) + '}' + t.separator + t.text).join('')
        : tokens.map(t => t.separator + t.text).join('');
      emit(start, end, fade + text);
    }
  }
  return lines.join('\n') + '\n';
}
