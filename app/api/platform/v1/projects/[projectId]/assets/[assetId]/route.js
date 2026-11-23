import { projectRoute } from '@/lib/platform/projects/http.mjs';
import { removeAsset } from '@/lib/platform/projects/repository.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = projectRoute(async ({ pool, owner, params }) => {
  await removeAsset(pool, owner, params.projectId, params.assetId);
  return { deleted: true };
});
