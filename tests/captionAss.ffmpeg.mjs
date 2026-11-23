import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeAss } from '../lib/platform/captions/ass.mjs';

const width = 270;
const height = 480;
const frameBytes = width * height * 3;

function measure(frame) {
  assert.equal(frame.length, frameBytes);
  let highlighted = 0, sumX = 0;
  let left = width, right = -1, top = height, bottom = -1;
  for (let i = 0; i < frame.length; i += 3) {
    const r = frame[i], g = frame[i + 1], b = frame[i + 2];
    if (Math.max(r, g, b) < 60) continue;
    const x = (i / 3) % width, y = Math.floor(i / 3 / width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    if (g - r > 30 && b - r > 30) {
      highlighted++;
      sumX += x;
    }
  }
  return { highlighted, center: sumX / highlighted, left, right, top, bottom };
}

test('libass moves the highlight at the corrected boundary and leaves the speaker pause blank', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'caption-frames-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const words = [
    { text: 'Keep', speakerId: 'Ana', startMs: 100, endMs: 360, source: 'corrected', providerTiming: { startMs: 100, endMs: 500 } },
    { text: 'going!', speakerId: 'Ana', startMs: 360, endMs: 750, source: 'corrected', providerTiming: { startMs: 500, endMs: 750 } },
    ...['Another', 'speaker', 'wraps', 'these', 'words.'].map((text, i) => ({
      text, speakerId: 'Bo', startMs: 1000 + 60 * i, endMs: 1060 + 60 * i, source: 'manual',
    })),
  ];
  await writeFile(join(dir, 'track.ass'), serializeAss(words));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=black:s=270x480:r=50:d=1.3', '-vf', 'ass=track.ass', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-qp', '0', '-threads', '1', 'burned.mp4'], { cwd: dir });
  // Decode samples at 80, 340, 360, 480, 760 and 1,000 ms from the burned MP4.
  const selected = [4, 17, 18, 24, 38, 50].map(n => 'eq(n\\,' + n + ')').join('+');
  const pixels = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'burned.mp4', '-vf', 'select=' + selected,
    '-fps_mode', 'passthrough', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    { cwd: dir, maxBuffer: 7 * frameBytes });
  assert.equal(pixels.length, 6 * frameBytes);
  const frame = n => pixels.subarray(n * frameBytes, (n + 1) * frameBytes);
  assert.equal(measure(frame(0)).right, -1);
  const before = measure(frame(1)), after = measure(frame(2)), wrapped = measure(frame(5));
  for (const sample of [before, after, wrapped]) {
    assert.ok(sample.highlighted > 5, 'active word should have colored pixels');
    assert.ok(sample.left >= 18 && sample.right < width - 18, 'caption should fit inside the side margins');
    assert.ok(sample.bottom < height - 36, 'caption should stay above the bottom margin');
  }
  assert.ok(before.center < after.center - 12, 'highlight should move from Keep to going!');
  assert.deepEqual(frame(2), frame(3), 'the corrected word stays active before its original provider start');
  assert.equal(measure(frame(4)).right, -1);
  assert.ok(wrapped.bottom - wrapped.top > 1.5 * (before.bottom - before.top), 'the second speaker should wrap to multiple lines');
});
