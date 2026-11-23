import { pool } from '@/lib/platform/accounts/auth.mjs';
import { PlatformAccessError } from '@/lib/platform/accounts/authorization.mjs';
import { MAX_BODY_BYTES, readCaptionBytes } from '@/lib/platform/captions/body.mjs';
import { captionActor, captionApiError } from '@/lib/platform/captions/private.mjs';
import { burnCaptionVideo, MAX_VIDEO_BYTES, withCaptionRenderSlot } from '@/lib/platform/captions/render.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const actor = await captionActor(request);
    const contentType = request.headers.get('content-type') || '';
    if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new PlatformAccessError('CONTENT_TYPE', 415);
    return await withCaptionRenderSlot(pool, actor, async () => {
      const uploadSignal = AbortSignal.any([request.signal, AbortSignal.timeout(60000)]);
      const bytes = await readCaptionBytes(request, MAX_VIDEO_BYTES + MAX_BODY_BYTES + 8192, uploadSignal);
      let form, track;
      try {
        form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
        const raw = form.get('track');
        if (typeof raw !== 'string') throw new TypeError();
        if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new PlatformAccessError('BODY_TOO_LARGE', 413);
        track = JSON.parse(raw);
      } catch (error) {
        if (error instanceof PlatformAccessError) throw error;
        throw new PlatformAccessError('INVALID_JSON', 400);
      }
      const file = form.get('video');
      if (!(file instanceof Blob)) throw new PlatformAccessError('CAPTION_VIDEO', 422);
      if (file.size > MAX_VIDEO_BYTES) throw new PlatformAccessError('CAPTION_VIDEO_SIZE', 413);
      const currentActor = await captionActor(request);
      const video = await burnCaptionVideo(currentActor, Buffer.from(await file.arrayBuffer()), track, request.signal);
      return new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="captioned.mp4"',
        'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
    });
  } catch (error) { return captionApiError(error); }
}
