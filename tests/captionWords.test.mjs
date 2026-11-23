import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWordTrack, MAX_WORDS, wordSeparator } from '../lib/platform/captions/words.mjs';
import { serializeSrt } from '../lib/platform/captions/srt.mjs';
import { exportSrt } from '../lib/platform/captions/export.mjs';
import { expectedSrt, words } from './fixtures/captionWords.mjs';

const post = track => exportSrt(new Request('http://localhost/api/platform/v1/captions/srt', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(track),
}));

test('uses observed timings for two speakers, silence, unequal words and attached punctuation', () => {
  const track = buildWordTrack(words);
  assert.equal(serializeSrt(track.cues), expectedSrt);
  assert.equal(track.words[1].source, 'provider');
  assert.deepEqual(track.words[1].providerTiming, { startMs: 410, endMs: 450 });
  assert.equal(wordSeparator('你', '好'), '');
  assert.equal(wordSeparator('𠮷', '野'), '');
  assert.equal(wordSeparator('好。', '再见'), '');
  assert.equal(serializeSrt(buildWordTrack(track.words).cues), expectedSrt);
});

test('splits adjacent speakers, same-speaker gaps and groups longer than eight words using exact boundaries', () => {
  const token = (n, speakerId = 'a') => ({ text: 'yes', startMs: n, endMs: n + 1, speakerId });
  const { cues } = buildWordTrack([...Array.from({ length: 9 }, (_, i) => token(i)), token(9, 'b'), token(11, 'b')]);
  assert.deepEqual(cues.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 8], [8, 9], [9, 10], [11, 12]]);
});

test('manual timing and corrections preserve provenance, including after a correction is reverted', () => {
  const [provider] = buildWordTrack(words).words;
  const [changed, manual] = buildWordTrack([{ ...provider, endMs: 415 }, { ...words[2], source: 'manual' }]).words;
  assert.equal(changed.source, 'corrected');
  assert.deepEqual(changed.providerTiming, { startMs: 120, endMs: 410 });
  assert.deepEqual(manual, { ...words[2], source: 'manual' });
  assert.equal(buildWordTrack([{ ...changed, endMs: 410 }]).words[0].source, 'provider');
});

test('rejects missing alignment, invalid source and invalid or overlapping word intervals', () => {
  for (const input of [undefined, [], 'hello']) assert.throws(() => buildWordTrack(input), { code: 'WORD_ALIGNMENT' });
  assert.throws(() => buildWordTrack(Array(MAX_WORDS + 1).fill(words[0])), { code: 'WORD_LIMIT' });
  for (const fields of [{ startMs: null }, { startMs: -1 }, { endMs: 0 }, { startMs: 3.5 }, { endMs: 360000000 }]) {
    assert.throws(() => buildWordTrack([{ ...words[0], ...fields }]), { code: 'WORD_TIME', word: 1 });
  }
  assert.throws(() => buildWordTrack([words[0], words[0]]), { code: 'WORD_TIME', word: 2 });
  for (const [patch, code] of [[{ text: 'x\ny' }, 'WORD_TEXT'], [{ speakerId: '  ' }, 'WORD_SPEAKER'],
    [{ source: 'guessed' }, 'WORD_SOURCE'], [{ source: 'corrected' }, 'WORD_SOURCE'], [{ providerTiming: null }, 'WORD_SOURCE']]) {
    assert.throws(() => buildWordTrack([{ ...words[0], ...patch }]), { code, word: 1 });
  }
  assert.throws(() => buildWordTrack(Array.from({ length: 501 }, (_, i) => ({ ...words[0], startMs: i * 2, endMs: i * 2 + 1 }))), { code: 'WORD_CUE_LIMIT' });
});

test('new HTTP word input and existing cue input produce identical SRT attachments', async () => {
  for (const track of [{ words }, { cues: buildWordTrack(words).cues }]) {
    const response = await post(track);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="captions.srt"');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(expectedSrt));
  }
  for (const [track, expected] of [[{ words: [] }, { code: 'WORD_ALIGNMENT' }],
    [{ cues: [], words: [] }, { code: 'TRACK_MODE' }], [{ words: [words[0], words[0]] }, { code: 'WORD_TIME', word: 2 }]]) {
    const response = await post(track);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: expected });
  }
});
