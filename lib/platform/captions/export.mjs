import { buildWordTrack, WordTimingError } from './words.mjs';
import { CaptionError, serializeSrt } from './srt.mjs';
import { serializeAss } from './ass.mjs';
import { captionErrorStatus, readCaptionJson } from './body.mjs';
export { MAX_BODY_BYTES } from './body.mjs';

async function exportTrack(request, format) {
  const headers = format === 'ass' ? { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } : { 'Cache-Control': 'no-store' };
  headers['X-Content-Type-Options'] = 'nosniff';
  const fail = (status, code, cue, word) => Response.json({ error: { code, cue, word } }, { status, headers });
  try {
    const track = await readCaptionJson(request);
    const hasWords = track != null && Object.hasOwn(track, 'words');
    if (hasWords && Object.hasOwn(track, 'cues')) return fail(422, 'TRACK_MODE');
    const text = format === 'ass' ? serializeAss(track?.words, track?.style)
      : serializeSrt(hasWords ? buildWordTrack(track.words).cues : track?.cues);
    return new Response(text, { headers: {
      ...headers,
      'Content-Type': format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8',
      'Content-Disposition': 'attachment; filename="captions.' + format + '"',
    } });
  } catch (error) {
    if (error instanceof WordTimingError) return fail(422, error.code, undefined, error.word);
    if (error instanceof CaptionError) {
      return fail(captionErrorStatus(error), error.code, error.cue);
    }
    if (error instanceof SyntaxError || error instanceof TypeError) return fail(400, 'INVALID_JSON');
    throw error;
  }
}

export const exportSrt = request => exportTrack(request, 'srt');
export const exportAss = request => exportTrack(request, 'ass');
