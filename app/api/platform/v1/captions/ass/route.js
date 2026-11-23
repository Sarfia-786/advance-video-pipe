import { requireCapability } from '@/lib/platform/accounts/authorization.mjs';
import { getPlatformActor, privateApiError } from '@/lib/platform/accounts/server.mjs';
import { exportAss } from '@/lib/platform/captions/export.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const actor = await getPlatformActor(request.headers);
    requireCapability(actor, 'captions', 'animated');
    return await exportAss(request);
  } catch (error) {
    return privateApiError(error);
  }
}
