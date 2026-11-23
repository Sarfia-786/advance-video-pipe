import { pool } from '@/lib/platform/accounts/auth.mjs';
import { requireWorkspaceAccess } from '@/lib/platform/accounts/authorization.mjs';
import { getVerifiedSession, privateApiResponse, privateApiError } from '@/lib/platform/accounts/server.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A workspace ID is a locator, never proof of access. Resolve a verified
// auth session, current plan and membership on the server for EVERY read.
export async function GET(request, { params }) {
  try {
    const { workspaceId } = await params;
    const session = await getVerifiedSession(request.headers);
    const actor = await requireWorkspaceAccess({
      getSession: async () => session,
      query: pool.query.bind(pool),
    }, workspaceId, 'viewer');
    return privateApiResponse({
      workspace: { id: actor.workspaceId, role: actor.role },
      plan: actor.plan,
    });
  } catch (error) {
    return privateApiError(error);
  }
}
