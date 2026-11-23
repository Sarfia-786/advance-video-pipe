import { projectRoute } from '@/lib/platform/projects/http.mjs';
import { getPrivateAsset } from '@/lib/platform/projects/repository.mjs';
import { attachmentHeaders, downloadTicket, verifyTicket } from '@/lib/platform/projects/download.mjs';
import { projectStorage } from '@/lib/platform/projects/storage.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = projectRoute(async ({ pool, owner, params }) => {
  const { project, now } = await getPrivateAsset(pool, owner, params.projectId, params.assetId);
  return downloadTicket(owner, project, params.assetId, now);
});
export const GET = projectRoute(async ({ pool, owner, request, params }) => {
  const { asset, project, now } = await getPrivateAsset(pool, owner, params.projectId, params.assetId);
  verifyTicket(new URL(request.url).searchParams, owner, project.id, asset.id, now);
  const bytes = await projectStorage(asset.backend).get(asset.id);
  return new Response(bytes, { headers: attachmentHeaders(asset) });
});
