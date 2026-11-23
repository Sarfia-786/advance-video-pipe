import { getPlatformActor, privateApiResponse, privateApiError } from '@/lib/platform/accounts/server.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Protected platform endpoint. Unlike /api/v1, this never proxies to MuAPI.
export async function GET(request) {
  try {
    const actor = await getPlatformActor(request.headers);
    return privateApiResponse({
      user: { id: actor.session.user.id, name: actor.session.user.name,
              email: actor.session.user.email, emailVerified: actor.session.user.emailVerified },
      plan: actor.plan,
      entitlements: actor.entitlements,
      personalWorkspaceId: actor.workspaceId,
      creditBalance: actor.creditBalance,
    });
  } catch (error) {
    return privateApiError(error);
  }
}
