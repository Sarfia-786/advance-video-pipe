import { MAX_CUES, MAX_TIME_MS } from './srt.mjs';

export const MAX_WORDS = 1000;
const WORDS_PER_CUE = 8;

export class WordTimingError extends Error {
  constructor(code, word) {
    super(code);
    this.code = code;
    this.word = word;
  }
}

function validInterval(interval) {
  return Number.isSafeInteger(interval?.startMs) && Number.isSafeInteger(interval.endMs) &&
    interval.startMs >= 0 && interval.startMs < interval.endMs && interval.endMs <= MAX_TIME_MS;
}

function validLabel(value, limit) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

export function wordSeparator(previous, current) {
  if (!previous || /^[\p{Pe}\p{Pf}.,!?;:%…，。！？、：；]/u.test(current) ||
      /[\p{Ps}\p{Pi}]$/u.test(previous)) return '';
  const compactEnd = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、：；]$/u;
  const compactStart = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  if (compactEnd.test(previous) && compactStart.test(current)) return '';
  return ' ';
}

function normalizeWord(word, index, previousEnd) {
  if (!validInterval(word) || word.startMs < previousEnd) throw new WordTimingError('WORD_TIME', index);
  if (!validLabel(word.text, 128)) throw new WordTimingError('WORD_TEXT', index);
  if (!validLabel(word.speakerId, 100)) throw new WordTimingError('WORD_SPEAKER', index);

  const { startMs, endMs } = word;
  const result = { text: word.text.trim(), speakerId: word.speakerId.trim(), startMs, endMs };
  const source = word.source === undefined ? 'provider' : word.source;
  if (source === 'manual' && word.providerTiming === undefined) return { ...result, source };
  if (source !== 'provider' && source !== 'corrected') throw new WordTimingError('WORD_SOURCE', index);
  const original = word.providerTiming === undefined && source === 'provider' ? word : word.providerTiming;
  if (!validInterval(original)) throw new WordTimingError('WORD_SOURCE', index);
  const corrected = startMs !== original.startMs || endMs !== original.endMs;
  return { ...result, source: corrected ? 'corrected' : 'provider',
    providerTiming: { startMs: original.startMs, endMs: original.endMs } };
}

export function buildWordTrack(input) {
  if (!Array.isArray(input) || !input.length) throw new WordTimingError('WORD_ALIGNMENT');
  if (input.length > MAX_WORDS) throw new WordTimingError('WORD_LIMIT');
  const words = [];
  const cues = [];
  for (const raw of input) {
    const word = normalizeWord(raw, words.length + 1, words.at(-1)?.endMs ?? 0);
    words.push(word);
    let cue = cues.at(-1);
    if (!cue || cue.speakerId !== word.speakerId || cue.endMs !== word.startMs || cue.words.length === WORDS_PER_CUE) {
      if (cues.length === MAX_CUES) throw new WordTimingError('WORD_CUE_LIMIT');
      cue = { startMs: word.startMs, endMs: word.endMs, speakerId: word.speakerId, text: '', words: [] };
      cues.push(cue);
    }
    cue.text += wordSeparator(cue.words.at(-1)?.text, word.text) + word.text;
    cue.words.push(word);
    cue.endMs = word.endMs;
  }
  return { words, cues };
}
