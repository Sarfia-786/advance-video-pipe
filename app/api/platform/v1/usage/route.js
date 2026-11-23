import { getPlatformActor, privateApiError, privateApiResponse } from '@/lib/platform/accounts/server.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const actor = await getPlatformActor(request.headers);
    return privateApiResponse({
      plan: actor.plan,
      credits: actor.creditMeter,
      history: actor.entitlements.capabilities.usageHistory,
    });
  } catch (error) {
    return privateApiError(error);
  }
}
