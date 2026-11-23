import { buildWordTrack, WordTimingError } from './words.mjs';
import { CaptionError, serializeSrt } from './srt.mjs';
import { serializeAss } from './ass.mjs';

export const MAX_BODY_BYTES = 256 * 1024;

async function readTrack(request) {
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new CaptionError('BODY_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

async function exportTrack(request, format) {
  const headers = format === 'ass' ? { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } : { 'Cache-Control': 'no-store' };
  headers['X-Content-Type-Options'] = 'nosniff';
  const fail = (status, code, cue, word) => Response.json({ error: { code, cue, word } }, { status, headers });
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return fail(415, 'CONTENT_TYPE');
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return fail(413, 'BODY_TOO_LARGE');
  try {
    const track = await readTrack(request);
    const hasWords = track != null && Object.hasOwn(track, 'words');
    if (hasWords && Object.hasOwn(track, 'cues')) return fail(422, 'TRACK_MODE');
    const text = format === 'ass' ? serializeAss(track?.words)
      : serializeSrt(hasWords ? buildWordTrack(track.words).cues : track?.cues);
    return new Response(text, { headers: {
      ...headers,
      'Content-Type': format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8',
      'Content-Disposition': 'attachment; filename="captions.' + format + '"',
    } });
  } catch (error) {
    if (error instanceof WordTimingError) return fail(422, error.code, undefined, error.word);
    if (error instanceof CaptionError) {
      return fail(error.code === 'BODY_TOO_LARGE' ? 413 : 422, error.code, error.cue);
    }
    if (error instanceof SyntaxError || error instanceof TypeError) return fail(400, 'INVALID_JSON');
    throw error;
  }
}

export const exportSrt = request => exportTrack(request, 'srt');
export const exportAss = request => exportTrack(request, 'ass');
