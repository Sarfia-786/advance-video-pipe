import { createAuthClient } from 'better-auth/react';

// Same-origin only. No provider keys or browser storage are used for sessions.
export const authClient = createAuthClient({
  basePath: '/api/platform/v1/auth',
});
