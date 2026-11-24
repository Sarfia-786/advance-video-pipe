import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { changeMember, teamManagement } from '@/lib/platform/projects/teams.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = projectRoute(({ pool, owner, params }) => teamManagement(pool,owner,params.workspaceId));
export const PATCH = projectRoute(async ({ pool, owner, params, request }) => changeMember(pool,owner,params.workspaceId,await projectInput(request)));
