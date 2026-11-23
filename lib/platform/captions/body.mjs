import { CaptionError } from './srt.mjs';

export const MAX_BODY_BYTES = 256 * 1024;

export async function readCaptionBytes(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new CaptionError('BODY_TOO_LARGE');
  if (!request.body) throw new CaptionError('INVALID_JSON');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CaptionError('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function readCaptionJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new CaptionError('CONTENT_TYPE');
  const bytes = await readCaptionBytes(request, MAX_BODY_BYTES);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new CaptionError('INVALID_JSON'); }
}

export function captionErrorStatus(error) {
  return { CONTENT_TYPE: 415, BODY_TOO_LARGE: 413, INVALID_JSON: 400 }[error.code] ?? 422;
}
