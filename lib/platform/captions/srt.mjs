export const MAX_CUES = 500;
export const MAX_TEXT = 2000;
export const MAX_TIME_MS = 359999999; // 99:59:59,999

export class CaptionError extends Error {
  constructor(code, cue) {
    super(code);
    this.code = code;
    this.cue = cue;
  }
}

export function formatTimestamp(ms) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds) + ',' + pad(ms % 1000, 3);
}

export function serializeSrt(cues) {
  if (!Array.isArray(cues) || !cues.length || cues.length > MAX_CUES) {
    throw new CaptionError('CUE_COUNT');
  }
  let previousEnd = 0;
  const blocks = cues.map((cue, index) => {
    const number = index + 1;
    if (!cue || !Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) ||
        cue.startMs < previousEnd || cue.endMs <= cue.startMs || cue.endMs > MAX_TIME_MS) {
      throw new CaptionError('CUE_TIMING', number);
    }
    previousEnd = cue.endMs;
    if (typeof cue.text !== 'string' || cue.text.length > MAX_TEXT) throw new CaptionError('CUE_TEXT', number);
    const text = cue.text.replace(/\r\n?/g, '\n').trim();
    // A blank line ends an SRT block. Keep the user's visible line breaks inside a cue.
    if (!text || /\n[^\S\n]*\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      throw new CaptionError('CUE_TEXT', number);
    }
    return [number, formatTimestamp(cue.startMs) + ' --> ' + formatTimestamp(cue.endMs), text.replace(/\n/g, '\r\n')].join('\r\n');
  });
  return blocks.join('\r\n\r\n') + '\r\n';
}
