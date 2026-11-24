import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { projectHistory, restoreVersion } from '@/lib/platform/projects/history.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = projectRoute(({ pool, owner, params }) => projectHistory(pool,owner,params.projectId));
export const POST = projectRoute(async ({ pool, owner, params, request }) => restoreVersion(pool,owner,params.projectId,await projectInput(request)));
