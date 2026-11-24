import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { changeFolder, foldersIn } from '@/lib/platform/projects/folders.mjs';
import { withWorkspace } from '@/lib/platform/projects/access.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = projectRoute(({ pool, owner, params }) => withWorkspace(pool,owner,params.workspaceId,'viewer',
  async ctx => ({ folders:await foldersIn(ctx) })));

export const POST = projectRoute(async ({ pool, owner, params, request }) => changeFolder(pool,owner,params.workspaceId,await projectInput(request)));
