import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnCaptionVideo } from '../lib/platform/captions/render.mjs';
import { getEntitlements } from '../lib/platform/entitlements/policy.mjs';

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
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=black:s=270x480:r=50:d=1.3', '-f', 'lavfi', '-i', 'sine=f=330:d=1.3', '-c:a', 'aac',
    '-c:v', 'libx264', '-threads', '1', '-shortest', 'source.mp4'], { cwd: dir });
  const video = await readFile(join(dir, 'source.mp4'));
  const actor = { entitlements: getEntitlements({ plan: 'premium', subscriptionStatus: 'active' }) };
  await assert.rejects(burnCaptionVideo({ entitlements: getEntitlements({}) }, video, { words }), { code: 'PLAN_REQUIRED' });
  await writeFile(join(dir, 'burned.mp4'), await burnCaptionVideo(actor, video, { words }));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', 'burned.mp4'], { cwd: dir }));
  assert.deepEqual(probe.streams.map(s => s.codec_name), ['h264', 'aac']);
  assert.equal(probe.streams[0].width, width);
  assert.equal(probe.streams[0].height, height);
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
  assert.ok(Math.abs(after.center - measure(frame(3)).center) < 2, 'the corrected word stays active before its original provider start');
  assert.equal(measure(frame(4)).right, -1);
  assert.ok(wrapped.bottom - wrapped.top > 1.5 * (before.bottom - before.top), 'the second speaker should wrap to multiple lines');
  for (const preset of ['karaoke', 'boldCenter', 'hormozi']) {
    const style = { preset, highlightColor: '#99edee' };
    await writeFile(join(dir, 'styled.mp4'), await burnCaptionVideo(actor, video, { words, style }));
    const frames = execFileSync('ffmpeg', ['-v', 'error', '-i', 'styled.mp4', '-vf', 'select=eq(n\\,6)+eq(n\\,15)+eq(n\\,38)',
      '-fps_mode', 'passthrough', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { cwd: dir, maxBuffer: 4 * frameBytes });
    const early = measure(frames.subarray(0, frameBytes)), late = measure(frames.subarray(frameBytes, 2 * frameBytes));
    assert.equal(measure(frames.subarray(2 * frameBytes)).right, -1, preset + ' clears during pauses');
    if (preset === 'karaoke') assert.ok(late.highlighted > early.highlighted + 15, 'karaoke progressively fills the active word');
    if (preset === 'boldCenter') assert.ok(early.top < height / 2 && early.bottom > height / 2, 'bold caption straddles the center');
    if (preset === 'hormozi') assert.ok(early.highlighted > late.highlighted, 'emphasis settles back to normal size');
  }
});

test('phone rotation is applied once and an explicit break adds a visible line to the MP4', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'caption-rotation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=480x270:r=25:d=0.5',
    '-c:v', 'libx264', '-threads', '1', 'source.mp4'], { cwd: dir });
  execFileSync('ffmpeg', ['-v', 'error', '-display_rotation:v:0', '90', '-i', 'source.mp4', '-c', 'copy', 'phone.mp4'], { cwd: dir });
  const video = await readFile(join(dir, 'phone.mp4'));
  const actor = { entitlements: getEntitlements({ plan: 'premium', subscriptionStatus: 'active' }) };
  const heights = [];
  for (const lineBreakBefore of [false, true]) {
    const words = [{ text: 'First', speakerId: 'A', startMs: 0, endMs: 200 },
      { text: 'line.', speakerId: 'A', startMs: 200, endMs: 500, lineBreakBefore }];
    await writeFile(join(dir, 'result.mp4'), await burnCaptionVideo(actor, video, { words }));
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height:stream_side_data=rotation', '-of', 'json', 'result.mp4'], { cwd: dir })).streams[0];
    assert.equal(info.width, width);
    assert.equal(info.height, height);
    assert.equal(info.side_data_list?.find(item => item.rotation)?.rotation ?? 0, 0);
    const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', 'result.mp4', '-frames:v', '1',
      '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { cwd: dir, maxBuffer: 2 * frameBytes });
    const bounds = measure(rgb);
    heights.push(bounds.bottom - bounds.top);
  }
  assert.ok(heights[1] > heights[0] * 1.5);
});
