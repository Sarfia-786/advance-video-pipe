import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { createTeam, listWorkspaces } from '@/lib/platform/projects/teams.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = projectRoute(({ pool, owner }) => listWorkspaces(pool,owner));
export const POST = projectRoute(async ({ pool, owner, request }) => createTeam(pool,owner,(await projectInput(request)).name));
