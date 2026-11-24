import { pool } from '../accounts/auth.mjs';
import { getVerifiedSession, privateApiError, privateApiResponse } from '../accounts/server.mjs';
import { maxDocumentBytes, projectError, readBounded } from './validation.mjs';

export function projectRoute(action) {
  return async (request, context) => {
    try {
      const session = await getVerifiedSession(request.headers);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const origin = request.headers.get('origin');
        if ((origin && origin !== new URL(process.env.BETTER_AUTH_URL).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
          throw projectError('ORIGIN_DENIED', 403);
        }
      }
      const result = await action({ request, params: await context.params, owner: session.user.id, pool });
      return result instanceof Response ? result : privateApiResponse(result);
    } catch (error) { return privateApiError(error); }
  };
}

export async function projectInput(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw projectError('JSON_REQUIRED', 415);
  const bytes = await readBounded(request, 2 * maxDocumentBytes + 2048);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new TypeError('Expected an object');
    return value;
  }
  catch { throw projectError('INVALID_PROJECT'); }
}
