import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { placeProject } from '@/lib/platform/projects/history.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = projectRoute(async ({ pool, owner, params, request }) => placeProject(pool,owner,params.projectId,await projectInput(request)));
