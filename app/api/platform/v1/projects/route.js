import { privateApiResponse } from '@/lib/platform/accounts/server.mjs';
import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { listProjects, createProject } from '@/lib/platform/projects/repository.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = projectRoute(({ pool, owner, request }) => {
  const query = new URL(request.url).searchParams;
  return listProjects(pool, owner, { workspaceId: query.get('workspace'), q: query.get('q') || '',
    folder: query.get('folder'), kind: query.get('kind') || '' });
});
export const POST = projectRoute(async ({ pool, owner, request }) =>
  privateApiResponse(await createProject(pool, owner, await projectInput(request)), 201));
