import { PlatformAccessError, requireCapability } from '../accounts/authorization.mjs';
import { getPlatformActor, privateApiError, privateApiResponse } from '../accounts/server.mjs';
import { CaptionError } from './srt.mjs';
import { WordTimingError } from './words.mjs';
import { captionErrorStatus } from './body.mjs';

export async function captionActor(request) {
  const actor = await getPlatformActor(request.headers);
  requireCapability(actor, 'captions', 'animated');
  const origin = request.headers.get('origin');
  if (request.method !== 'GET' && (request.headers.get('sec-fetch-site') === 'cross-site' ||
      (origin && origin !== new URL(process.env.BETTER_AUTH_URL || request.url).origin))) {
    throw new PlatformAccessError('INVALID_ORIGIN', 403);
  }
  return actor;
}

export function captionApiError(error) {
  if (error instanceof CaptionError || error instanceof WordTimingError) {
    return privateApiResponse({ error: { code: error.code, word: error.word } }, captionErrorStatus(error));
  }
  return privateApiError(error);
}
