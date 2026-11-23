import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PlatformAccessError, requireCapability } from '../accounts/authorization.mjs';
import { serializeAss } from './ass.mjs';

const execute = promisify(execFile);
export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const maxOutput = 64 * 1024 * 1024;
const maxSeconds = 120;
const inputOptions = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];
const invalid = () => new PlatformAccessError('CAPTION_VIDEO', 422);

async function runMedia(tool, args, cwd, signal, timeout) {
  try {
    return await execute(tool, args, { cwd, signal, timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true });
  } catch (error) {
    if (error.name === 'AbortError') throw new PlatformAccessError('RENDER_CANCELED', 408);
    if (error.code === 'ENOENT' || error.code === 'EACCES') throw new PlatformAccessError('RENDER_UNAVAILABLE', 503);
    if (error.killed || error.signal) throw new PlatformAccessError('RENDER_TIMEOUT', 408);
    throw invalid();
  }
}

// Both the HTTP uploader and a future timeline worker must supply a current server-resolved actor.
export async function burnCaptionVideo(actor, video, track, signal) {
  requireCapability(actor, 'captions', 'animated');
  if (!track || !Array.isArray(track.words) || Object.hasOwn(track, 'cues')) throw new PlatformAccessError('WORD_ALIGNMENT', 422);
  if (!video.length || video.length > MAX_VIDEO_BYTES) throw new PlatformAccessError('CAPTION_VIDEO_SIZE', 413);
  const dir = await mkdtemp(join(tmpdir(), 'studio-captions-'));
  try {
    await writeFile(join(dir, 'input.mp4'), video, { mode: 0o600, signal });
    const { stdout } = await runMedia('ffprobe', ['-v', 'error', ...inputOptions, '-select_streams', 'V:0',
      '-show_entries', 'format=duration:stream=width,height,sample_aspect_ratio,avg_frame_rate:stream_side_data=rotation',
      '-of', 'json', 'input.mp4'], dir, signal, 10000);
    const probe = JSON.parse(stdout);
    const stream = probe.streams?.[0];
    const duration = Number(probe.format?.duration);
    if (!stream?.width || !stream.height || !(duration > 0 && duration <= maxSeconds)) throw invalid();
    const { width, height } = stream;
    const [frames, seconds] = stream.avg_frame_rate.split('/').map(Number);
    const maxShortEdge = Math.min(actor.entitlements.limits.maxOutputHeight, 2160);
    if (Math.min(width, height) > maxShortEdge || Math.max(width, height) > 3840 || !(frames / seconds > 0 && frames / seconds <= 60.01)) throw invalid();
    const [num, den] = (stream.sample_aspect_ratio || '1:1').split(':').map(Number);
    const displayWidth = width * (num > 0 && den > 0 ? num / den : 1);
    const rotated = stream.side_data_list?.some(data => Math.abs(data.rotation) % 180 === 90);
    const canvas = rotated ? { width: height, height: displayWidth } : { width: displayWidth, height };
    if (Math.max(canvas.width / canvas.height, canvas.height / canvas.width) > 16) throw invalid();
    const subtitles = serializeAss(track.words, track.style, canvas);
    await writeFile(join(dir, 'captions.ass'), subtitles, { mode: 0o600, signal });
    await runMedia('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...inputOptions, '-max_pixels', '8294400',
      '-threads', '2', '-i', 'input.mp4', '-map', '0:V:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
      '-filter_threads', '1', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,ass=captions.ass', '-c:v', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-ac', '2', '-b:a', '128k', '-t', String(maxSeconds),
      '-fpsmax', '60', '-fs', String(maxOutput + 1024 * 1024), '-movflags', '+faststart', 'output.mp4'], dir, signal, 180000);
    const output = join(dir, 'output.mp4');
    if ((await stat(output)).size > maxOutput) throw new PlatformAccessError('CAPTION_OUTPUT_SIZE', 413);
    return await readFile(output, { signal });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A connection-scoped lock is released even if the process exits during an encode.
export async function withCaptionRenderSlot(pool, actor, work) {
  const client = await pool.connect();
  try {
    const count = Math.min(actor.entitlements.limits.maxConcurrentJobs, pool.options.max);
    for (let slot = 0; slot < count; slot++) {
      const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext('caption-render:' || $1::text),$2::int) AS acquired", [actor.userId, slot]);
      if (rows[0].acquired) return await work();
    }
    throw new PlatformAccessError('CAPTION_RENDER_BUSY', 429);
  } finally {
    client.release(true);
  }
}
