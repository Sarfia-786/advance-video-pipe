import { toNextJsHandler } from 'better-auth/next-js';
import { auth, assertAuthConfigured } from '@/lib/platform/accounts/auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const handlers = toNextJsHandler(auth);

function guard(handler) {
  return async function platformAuthHandler(request) {
    try {
      assertAuthConfigured();
      return await handler(request);
    } catch (error) {
      console.error('platform_auth_route_failed', { name: error?.name || 'UnknownError' });
      return Response.json({ error: { code: 'AUTH_UNAVAILABLE' } }, {
        status: 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
  };
}

export const GET = guard(handlers.GET);
export const POST = guard(handlers.POST);
