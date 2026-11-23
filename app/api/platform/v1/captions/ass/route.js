import { captionActor, captionApiError } from '@/lib/platform/captions/private.mjs';
import { exportAss } from '@/lib/platform/captions/export.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    await captionActor(request);
    return await exportAss(request);
  } catch (error) {
    return captionApiError(error);
  }
}
