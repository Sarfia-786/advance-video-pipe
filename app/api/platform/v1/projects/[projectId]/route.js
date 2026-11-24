import { projectInput, projectRoute } from '@/lib/platform/projects/http.mjs';
import { getProject, updateProject, deleteProject } from '@/lib/platform/projects/repository.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = projectRoute(({ pool, owner, params }) => getProject(pool, owner, params.projectId));
export const PATCH = projectRoute(async ({ pool, owner, request, params }) =>
  updateProject(pool, owner, params.projectId, await projectInput(request)));
export const DELETE = projectRoute(async ({ pool, owner, params }) => {
  await deleteProject(pool, owner, params.projectId);
  return { deleted: true };
});
