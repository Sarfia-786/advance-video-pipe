import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimestamp, MAX_CUES, MAX_TIME_MS, serializeSrt } from '../lib/platform/captions/srt.mjs';
import { exportSrt, MAX_BODY_BYTES } from '../lib/platform/captions/export.mjs';

const cue = { startMs: 0, endMs: 1250, text: '你好\r\nHello' };
const endpoint = 'http://localhost/api/platform/v1/captions/srt';
const post = (body, type = 'application/json') => exportSrt(new Request(endpoint, {
  method: 'POST', headers: { 'Content-Type': type }, body,
}));
const expected = '1\r\n00:00:00,000 --> 00:00:01,250\r\n你好\r\nHello\r\n';

test('exports numbered UTF-8 cues, preserving adjacent boundaries, gaps and line breaks', () => {
  assert.equal(serializeSrt([cue, { startMs: 1250, endMs: 3600001, text: 'Two' }]), expected + '\r\n2\r\n00:00:01,250 --> 01:00:00,001\r\nTwo\r\n');
  assert.match(serializeSrt([cue, { startMs: 3000, endMs: 4000, text: 'After silence' }]), /00:00:03,000/);
  assert.equal(formatTimestamp(MAX_TIME_MS), '99:59:59,999');
});
test('rejects invalid cue counts, unsafe times, overlaps and separator injection', () => {
  for (const cues of [null, [], Array(MAX_CUES + 1).fill(cue)]) {
    assert.throws(() => serializeSrt(cues), { code: 'CUE_COUNT' });
  }
  for (const fields of [{ startMs: -1 }, { startMs: '0' }, { endMs: 0 }, { endMs: 0.5 }, { endMs: MAX_TIME_MS + 1 }]) {
    assert.throws(() => serializeSrt([{ ...cue, ...fields }]), { code: 'CUE_TIMING', cue: 1 });
  }
  assert.throws(() => serializeSrt([cue, cue]), { code: 'CUE_TIMING', cue: 2 });
  for (const text of ['', ' \t ', 'A\r\n \r\nB', 'A\0B', 'x'.repeat(2001)]) {
    assert.throws(() => serializeSrt([{ ...cue, text }]), { code: 'CUE_TEXT' });
  }
});
test('HTTP download returns exact bytes, a fixed filename and private caching behavior', async () => {
  const response = await post(JSON.stringify({ cues: [cue] }), 'application/json; charset=utf-8');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="captions.srt"/);
  assert.equal(await response.text(), expected);
});
test('HTTP input errors are bounded and never echo subtitle text', async () => {
  for (const [body, type, status, code] of [
    ['bad', 'text/plain', 415, 'CONTENT_TYPE'], ['{', 'application/json', 400, 'INVALID_JSON'],
    [new Uint8Array([0xff]), 'application/json', 400, 'INVALID_JSON'],
    ['{"cues":[]}', 'application/json', 422, 'CUE_COUNT'],
    ['x'.repeat(MAX_BODY_BYTES + 1), 'application/json', 413, 'BODY_TOO_LARGE'],
  ]) {
    const response = await post(body, type);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: { code } });
  }
  const response = await post(JSON.stringify({ cues: [cue, cue] }));
  assert.deepEqual(await response.json(), { error: { code: 'CUE_TIMING', cue: 2 } });
});
