import { extname } from 'node:path';
import { PlatformAccessError } from '../accounts/authorization.mjs';

export const MiB = 1024 * 1024;
export const maxDocumentBytes = MiB;
export const maxAssetBytes = 32 * MiB;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function projectError(code, status = 400) {
  return new PlatformAccessError(code, status);
}

export function validateProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw projectError('INVALID_PROJECT');
  const { name, script = '', document = {} } = input;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 160 ||
      typeof script !== 'string' || !document || Array.isArray(document) || typeof document !== 'object') {
    throw projectError('INVALID_PROJECT');
  }
  const validText = value => !value.includes('\0') && value.isWellFormed();
  if (!validText(name) || !validText(script)) throw projectError('INVALID_PROJECT');
  let json;
  try {
    json = JSON.stringify(document, (key, value) => {
      if (!validText(key) || (typeof value === 'string' && !validText(value))) throw new Error('Invalid database text');
      return value;
    });
  } catch { throw projectError('INVALID_PROJECT'); }
  if (Buffer.byteLength(script) + Buffer.byteLength(json) > maxDocumentBytes) throw projectError('PROJECT_TOO_LARGE', 413);
  return { name: name.trim(), script, document: json };
}

export const acceptedTypes = {
  txt: 'text/plain', md: 'text/markdown', ass: 'text/x-ssa', ssa: 'text/x-ssa', json: 'application/json', srt: 'application/x-subrip', vtt: 'text/vtt',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
const extensions = {
  script: ['txt','md','json'], subtitle: ['srt','vtt','ass','ssa'], thumbnail: ['png','jpg','jpeg','webp'],
  brand: ['png','jpg','jpeg','webp','json'], media: ['png','jpg','jpeg','webp','mp4','webm','mp3','wav'],
  render: ['mp4','webm','mp3','wav','png','jpg','jpeg','webp'],
};
function matchesFile(ext, bytes) {
  const starts = (...signature) => bytes.subarray(0, signature.length).equals(Buffer.from(signature));
  const label = (offset, n) => bytes.toString('latin1', offset, offset + n);
  switch (ext) {
    case 'png': return starts(137,80,78,71,13,10,26,10);
    case 'jpg': case 'jpeg': return starts(255,216,255);
    case 'webp': return label(0,4) === 'RIFF' && label(8,4) === 'WEBP';
    case 'wav': return label(0,4) === 'RIFF' && label(8,4) === 'WAVE';
    case 'mp4': return label(4,4) === 'ftyp';
    case 'webm': return starts(26,69,223,163);
    case 'mp3': return label(0,3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224);
    default: {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return false;
        if (ext === 'json') { JSON.parse(text); }
        if (ext === 'vtt') return /^WEBVTT(?:[ \t\r\n]|$)/.test(text);
        if (ext === 'ass' || ext === 'ssa') return /^\[Script Info\]\s*$/mi.test(text) && /^\[Events\]\s*$/mi.test(text);
        if (ext === 'srt') return /\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(text);
        return true;
      } catch { return false; }
    }
  }
}

export function validateAsset({ filename, kind, mediaType }, bytes) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 200 ||
      /[/\\\x00-\x1f\x7f]/.test(filename)) throw projectError('INVALID_FILENAME');
  const ext = extname(filename).slice(1).toLowerCase();
  const type = acceptedTypes[ext];
  if (!Object.hasOwn(extensions, kind) || !extensions[kind].includes(ext) || !type) throw projectError('UNSUPPORTED_ASSET', 415);
  if (bytes.length === 0 || bytes.length > maxAssetBytes) throw projectError('ASSET_SIZE', 413);
  const declared = (mediaType || '').split(';')[0].trim().toLowerCase();
  // Browsers often label subtitle files as plain text or supply no MIME type at all.
  if (declared && declared !== type && declared !== 'application/octet-stream' &&
      !((kind === 'subtitle' || ext === 'md') && declared === 'text/plain') && !(ext === 'wav' && declared === 'audio/x-wav')) {
    throw projectError('UNSUPPORTED_ASSET', 415);
  }
  if (!matchesFile(ext, bytes)) throw projectError('UNSUPPORTED_ASSET', 415);
  return { filename, kind, mediaType: type };
}

export async function readBounded(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw projectError('REQUEST_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  if (!reader) throw projectError('EMPTY_BODY');
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw projectError('REQUEST_TOO_LARGE', 413);
      }
      parts.push(value);
    }
    const declared = request.headers.get('content-length');
    if (declared !== null && Number(declared) !== size) throw projectError('INCOMPLETE_UPLOAD');
    return Buffer.concat(parts, size);
  } finally { reader.releaseLock(); }
}
