import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { acceptInvitation } from '@/lib/platform/projects/teams.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = projectRoute(async ({ pool, owner, request }) => acceptInvitation(pool,owner,(await projectInput(request)).token));
