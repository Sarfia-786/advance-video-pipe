# Platform accounts, sessions and PostgreSQL — Issue #4, PR #22

This milestone extends the first platform-schema checkpoint without touching caption code
(#3). It uses **Better Auth 1.7.27**, PostgreSQL through \`pg\`, and SMTP through
Nodemailer. MuAPI BYOK credentials never authenticate private platform routes.

## Local setup

1. Start PostgreSQL 16 (or later). Create an empty app database, with a role that
   owns migrations and can execute \`platform.provision_account_created\`. Better Auth
   uses the default \`public\` schema for \`user\`, \`session\`, \`account\`,
   \`verification\`, and \`rateLimit\`.
2. Start a local-only SMTP inbox:
   \`docker run --rm -p 127.0.0.1:8025:8025 -p 127.0.0.1:1025:1025 axllent/mailpit\`.
   The inbox is at http://localhost:8025; do not expose it publicly.
3. Set environment values in your untracked \`.env.local\`:
   - \`DATABASE_URL=postgresql://user:password@localhost:5432/platform\`
   - \`BETTER_AUTH_URL=http://localhost:3000\` (use a real HTTPS origin in production)
   - \`BETTER_AUTH_SECRET=<unique random 32+ character value>\` (for example, generate with \`openssl rand -base64 32\`)
   - \`SMTP_HOST=localhost\`, \`SMTP_PORT=1025\`, \`SMTP_FROM=Studio <noreply@example.test>\`
   - \`PLATFORM_STARTER_CREDITS=25\` (integer 0–1,000,000)
   - Optional authenticated SMTP: \`SMTP_USER\` and \`SMTP_PASSWORD\` together; use \`SMTP_SECURE=true\` for implicit TLS
4. Run \`npm ci\`. Run \`psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0001_platform_accounts.sql\`;
   then \`node scripts/migrate-platform-auth.mjs\`. These two migrations are
   independent: the platform SQL is versioned here, and Better Auth maintains
   its own adapter schema. Inspect migration changes before upgrading Better Auth.
5. Run \`npm run build:packages\` and \`npm run dev\`. Open \`/signup\`, \`/login\`,
   \`/forgot-password\`, \`/reset-password\` or \`/account\`. Chinese routes have
   \`/zh\` in front.

## Auth and provisioning contract

- All auth methods live under \`/api/platform/v1/auth/*\` (not the legacy MuAPI proxy).
- Better Auth handles password hashing (scrypt), verification/reset token validity,
  HTTP-only cookies, origin/CSRF checks and database-backed session expiration.
  Sessions expire after seven days; password resets revoke sessions.
- Production rate limits use the database store, so limits persist across web
  instances. Behind a proxy, configure and validate the real client IP chain
  rather than blindly trusting browser-supplied forwarded headers.
- A server-authenticated user-created hook invokes
  \`platform.provision_account_created(userId, "auth-user:"+userId, credits)\`.
  On the first authenticated private profile read, the same event is
  safely retried if a callback was interrupted. The server-side idempotent
  PostgreSQL function guarantees at most one starter grant, **including when the
  initial grant amount is zero**.
- \`GET /api/platform/v1/me\` resolves the Better Auth session, not a MuAPI key;
  reads current plan, personal workspace and credit history from PostgreSQL; and
  uses private/no-store cache headers. Invalid and expired sessions receive 401.
- Settings allow name updates, sign-out, revoke sessions + sign-out, and account
  deletion authenticated by the current password. Better Auth deletes its auth
  records and a post-deletion hook deletes platform profile (cascading membership,
  workspace and wallet rows). Cloud object cleanup is **not** implemented.
- No changes to \`components/StandaloneShell.js\` or caption paths were made,
  to avoid conflicts with captions PRs. Account entry routes are directly usable;
  navigation integration should be coordinated after #3 lands.

## Automated verification

- \`node --test tests/platformAccounts.test.mjs tests/platformAuthConfig.test.mjs\`
  validates contracts and configuration.
- \`bash tests/platformAccounts.pg.sh\` checks fresh and repeated migrations,
  duplicate events, zero-credit retries and concurrent provisioning.
- \`node scripts/migrate-platform-auth.mjs\` creates/updates the maintained auth schema.
- \`node --test tests/platformAuth.integration.mjs\` requires a running isolated
  PostgreSQL database and Mailpit, and runs signup, email verification, login,
  session/plan reads, event replay, invalid/expired sessions, reset email,
  cross-origin CSRF rejection and rate limit checks.
- \`npm run build:packages && npm run build\` verifies the Next.js app and all workspaces.
- The GitHub Actions \`Platform accounts foundation\` workflow performs all checks.
  Only treat a test as passed if its **latest** run shows success.

## Security/production handoff

Review the following before shipping: proxy/IP trust configuration, email deliverability,
mandatory HTTPS, database role permissions, token/email enumeration behavior, migrations
against an existing populated fixture, session revocation from different devices, and
object-storage cleanup during deletion.

Next independently testable work in #4: deploy a real SMTP provider and verify
email expiry; add browser E2E in both locales; implement account-deletion
reconciliation/outbox and object cleanup; add robust multi-user workspace
isolation and private profile/settings API mutation tests. Preserve PR #2's
contract → API → EN/ZH entry → automated checks → tracker handoff pattern.
