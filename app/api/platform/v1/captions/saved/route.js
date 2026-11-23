import { pool } from '@/lib/platform/accounts/auth.mjs';
import { privateApiResponse } from '@/lib/platform/accounts/server.mjs';
import { readCaptionJson } from '@/lib/platform/captions/body.mjs';
import { captionActor, captionApiError } from '@/lib/platform/captions/private.mjs';
import { readCaptionDocuments, saveCaptionDocument } from '@/lib/platform/captions/saved.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const { userId } = await captionActor(request);
    return privateApiResponse(await readCaptionDocuments(pool, userId, new URL(request.url).searchParams.get('id')));
  } catch (error) { return captionApiError(error); }
}

export async function PUT(request) {
  try {
    const { userId } = await captionActor(request);
    return privateApiResponse(await saveCaptionDocument(pool, userId, await readCaptionJson(request)));
  } catch (error) { return captionApiError(error); }
}
