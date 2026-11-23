import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { sendAccountEmail } from './email.mjs';
import { parseStarterCredits } from './provision.mjs';

export const AUTH_BASE_PATH = '/api/platform/v1/auth';

// PostgreSQL pool is lazy: builds may import this module without connecting.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://invalid:invalid@127.0.0.1:1/invalid',
  options: '-c platform.starter_credits=' + parseStarterCredits(),
  max: 10,
  connectionTimeoutMillis: 5000,
});

export function assertAuthConfigured(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  }
  if (!env.BETTER_AUTH_URL) throw new Error('BETTER_AUTH_URL is required');
  const url = new URL(env.BETTER_AUTH_URL);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !['https:', 'http:'].includes(url.protocol) ||
      (env.NODE_ENV === 'production' && url.protocol !== 'https:' &&
       !['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('BETTER_AUTH_URL must be an HTTPS origin (or local HTTP)');
  }
  return true;
}

export const auth = betterAuth({
  database: pool,
  // Only trust a single-address header overwritten by the deployment's ingress.
  // Without it Better Auth shares a per-path bucket across clients.
  advanced: { ipAddress: { ipAddressHeaders: process.env.AUTH_TRUSTED_IP_HEADER ? [process.env.AUTH_TRUSTED_IP_HEADER] : [] } },
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: AUTH_BASE_PATH,
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => sendAccountEmail({
      to: user.email,
      subject: 'Reset your Open Generative AI password',
      action: 'Use this one-time link to reset your password:',
      url,
    }),
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    sendVerificationEmail: async ({ user, url }) => sendAccountEmail({
      to: user.email,
      subject: 'Verify your Open Generative AI email',
      action: 'Verify your email address:',
      url,
    }),
  },
  session: {
    expiresIn: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    freshAge: 60 * 60,
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
    window: 60,
    max: 60,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 300, max: 5 },
      '/request-password-reset': { window: 300, max: 3 },
      '/send-verification-email': { window: 300, max: 3 },
    },
  },
  user: {
    deleteUser: {
      enabled: true,
      sendDeleteAccountVerification: async ({ user, url }) => sendAccountEmail({
        to: user.email,
        subject: 'Confirm account deletion',
        action: 'Permanently delete your account and personal workspace:',
        url,
      }),
    },
  },
});
