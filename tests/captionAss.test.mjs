import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeAss } from '../lib/platform/captions/ass.mjs';
import { exportAss, exportSrt, MAX_BODY_BYTES } from '../lib/platform/captions/export.mjs';
import { expectedSrt, words } from './fixtures/captionWords.mjs';

const post = body => new Request('http://localhost/captions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const events = track => serializeAss(track).split('\n').filter(line => line.startsWith('Dialogue:'));

test('ASS highlights the current word, retains punctuation, and splits speakers and silence', () => {
  const track = words.map(word => ({ ...word }));
  track[0] = { ...track[0], endMs: 403, source: 'corrected', providerTiming: words[0] };
  track[1] = { ...track[1], startMs: 403, source: 'corrected', providerTiming: words[1] };
  const lines = events(track);
  assert.equal(lines.length, words.length);
  assert.ok(lines[0].startsWith('Dialogue: 0,0:00:00.12,0:00:00.41,'));
  assert.ok(lines[0].endsWith('{\\1c&HEEED99&}Hello{\\r}, there!'));
  assert.ok(lines[1].endsWith('Hello{\\1c&HEEED99&},{\\r} there!'));
  assert.ok(lines[3].startsWith('Dialogue: 0,0:00:01.20,0:00:01.49,'));
  assert.ok(lines[3].endsWith('{\\1c&HEEED99&}你好{\\r}。'));
  const adjacentSpeaker = events([words[0], { ...words[1], speakerId: 'Bo' }]);
  assert.ok(adjacentSpeaker[0].endsWith('Hello{\\r}'));
  assert.ok(adjacentSpeaker[1].endsWith(',{\\r}'));
});

test('dialogue text remains literal and unrepresentable intervals return the word number', () => {
  const [line] = events([{ ...words[0], text: '{hi}, \\N', speakerId: 'A,B' }]);
  assert.ok(line.endsWith('{\\1c&HEEED99&}\\{hi\\}, \\\u2060N{\\r}'));
  assert.throws(() => events([{ ...words[0], startMs: 11, endMs: 19 }]), { code: 'ASS_TIME_RESOLUTION', word: 1 });
  assert.throws(() => events([{ ...words[0], text: 'two\nlines' }]), { code: 'WORD_TEXT', word: 1 });
  assert.ok(events([{ ...words[0], startMs: 359999980, endMs: 359999999 }])[0].includes('99:59:59.98,100:00:00.00'));
});

test('ASS takes bounded word-aligned JSON and the existing word-to-SRT download stays byte exact', async () => {
  const response = await exportAss(post({ words }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="captions.ass"');
  assert.equal(await response.text(), serializeAss(words));
  for (const [body, status, code] of [[{ cues: [] }, 422, 'WORD_ALIGNMENT'], [{ words, cues: [] }, 422, 'TRACK_MODE'],
    [{ words: [{ ...words[0], startMs: 3, endMs: 5 }] }, 422, 'ASS_TIME_RESOLUTION'],
    [{ words, padding: 'x'.repeat(MAX_BODY_BYTES) }, 413, 'BODY_TOO_LARGE']]) {
    const invalid = await exportAss(post(body));
    assert.equal(invalid.status, status);
    assert.equal((await invalid.json()).error.code, code);
  }
  assert.equal(await (await exportSrt(post({ words }))).text(), expectedSrt);
});

test('style presets share validated controls and preserve source intervals when regrouping', async () => {
  const { CAPTION_STYLES, normalizeCaptionStyle } = await import('../lib/platform/captions/styles.mjs');
  for (const preset of Object.keys(CAPTION_STYLES)) {
    const style = normalizeCaptionStyle({ preset, font: 'Liberation Serif', groupWords: 2, marginX: 14, marginY: 12 });
    assert.deepEqual(normalizeCaptionStyle(JSON.parse(JSON.stringify(style))), style);
    const ass = serializeAss(words, style, { width: 1920, height: 1080 });
    assert.match(ass, /PlayResX: 1920\nPlayResY: 1080/);
    assert.match(ass, /Style: WordHighlight,Liberation Serif/);
    assert.match(ass, /,269,269,130,1\n/);
    assert.ok(ass.includes('0:00:00.45,0:00:00.91'), preset);
  }
  const karaoke = serializeAss(words, { preset: 'karaoke' });
  assert.ok(karaoke.includes('{\\kf29}Hello{\\kf4},{\\kf46} there!'));
  for (const input of [null, { preset: 'other' }, { font: 'Arial,100' }, { fontSize: 1000 }, { highlight: 'bad' },
    { highlightColor: '#fff\\n' }, { extra: true }, { groupWords: 0 }, { marginY: -2 }]) {
    assert.throws(() => serializeAss(words, input), { code: 'CAPTION_STYLE' });
  }
});
