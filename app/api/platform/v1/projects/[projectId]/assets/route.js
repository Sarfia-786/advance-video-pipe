import { addSecurityHeaders } from '@/lib/securityHeaders';
import { privateApiResponse } from '@/lib/platform/accounts/server.mjs';
import { projectRoute } from '@/lib/platform/projects/http.mjs';
import { requireProjectAccess, saveProjectAsset } from '@/lib/platform/projects/repository.mjs';
import { maxAssetBytes, readBounded } from '@/lib/platform/projects/validation.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const upload = projectRoute(async ({ pool, owner, request, params }) => {
  await requireProjectAccess(pool, owner, params.projectId);
  const query = new URL(request.url).searchParams;
  const metadata = { filename: query.get('filename'), kind: query.get('kind'), mediaType: request.headers.get('content-type') };
  const bytes = await readBounded(request, maxAssetBytes);
  return privateApiResponse(await saveProjectAsset(pool, owner, params.projectId, metadata, bytes), 201);
});

export async function POST(request, context) {
  return addSecurityHeaders(await upload(request, context));
}
