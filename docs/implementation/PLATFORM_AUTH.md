# Platform accounts

The web studio's **Account and settings** link opens the account portal in English or Chinese. It is available before entering a provider key and in studio settings. The same pages are available at `/signup`, `/login`, `/forgot-password`, `/reset-password`, and `/account` with optional `/zh` prefixes.

## Local setup

Use Node.js 22 LTS or later and PostgreSQL 16 or later. Start a local database and Mailpit, then install the application dependencies.

```sh
docker compose -f compose.accounts.yml up -d
cp .env.example .env.local
openssl rand -hex 32
npm ci
```

Put the generated value in `BETTER_AUTH_SECRET` in the untracked `.env.local`. The example connects to PostgreSQL on port 5432 and sends mail to Mailpit on port 1025. Set `BETTER_AUTH_URL` to the exact public origin the browser uses, including its port. Start the application after applying the migrations.

```sh
node --env-file=.env.local scripts/migrate-platform-auth.mjs
npm run build:packages
npm run dev
```

Open the studio at `http://localhost:3000/studio`. Mailpit displays verification, recovery and deletion messages at `http://localhost:8025`. The Chinese studio starts at `/zh/studio`. Follow the verification message in the browser. Deletion confirmation requires a session for the same account.

## API

| Method and path | Behavior |
| --- | --- |
| `GET /api/platform/v1/me` | Returns the current verified user's profile, plan, personal workspace ID and credit balance. |
| `GET /api/platform/v1/workspaces/{workspaceId}` | Reads membership and plan for the current session. Returns 401 for a missing or expired session and 404 for an inaccessible workspace. |
| `/api/platform/v1/auth/*` | Better Auth handles signup, verification, credential login, password recovery, profile updates, sign-out, session revocation and deletion. The portal uses its same-origin React client. |

Better Auth stores sessions in PostgreSQL. Private reads use the verified session cookie, check ownership on the server, and send `Cache-Control: private, no-store`. A MuAPI key authorizes provider operations only.

## Database lifecycle

The migration command takes a PostgreSQL advisory lock, applies the platform schema, runs the locked Better Auth adapter's schema migration, then installs the account lifecycle triggers. Run it again after updating the application. Existing signup events retain their original allocation. An older auth identity missing an account-created event is provisioned during migration.

A successful auth identity insert creates the personal workspace, membership, wallet and configured starter grant in the same transaction. `PLATFORM_STARTER_CREDITS` accepts integers from 0 through 1,000,000 and defaults to 25. A deletion commits the removal of platform data and a row in `platform.account_deletions` together. The tombstone prevents later signup deliveries from re-creating the profile. The project cleanup worker records completion after removing private objects. See [Private projects and assets](PRIVATE_PROJECTS.md) for the retention and accounting archive behavior.

## Deployment settings

Use the canonical HTTPS origin and a private database role. The migration role needs schema and trigger creation rights. A separate application role needs access to the auth and platform tables, sequences, and execution of the provisioning function. Keep direct database access restricted to trusted services.

Set `SMTP_HOST`, `SMTP_PORT` and `SMTP_FROM` for the deployment's mail relay. Set `SMTP_USER` and `SMTP_PASSWORD` together when the relay requires authentication. `SMTP_SECURE=true` selects implicit TLS. Authenticated SMTP on other ports requires STARTTLS.

Auth rate limits use PostgreSQL. Set `AUTH_TRUSTED_IP_HEADER` only when a trusted ingress overwrites that header with a single client IP and clients cannot reach the app directly. Without this setting, requests share a bucket per auth path. Verify delivery and the proxy configuration against the chosen deployment before launch.

## Verification

Use a disposable database and a local inbox for these commands. Export `DATABASE_URL`, `BETTER_AUTH_URL`, the auth secret and SMTP settings in the test shell. Set `MAILPIT_URL` when the inbox is served somewhere other than `http://localhost:8025`. The fixture uses the default 25 starter credits. Run the foundation SQL checks against an empty database. They reapply the SQL to a populated fixture internally.

```sh
npm test
bash tests/platformAccounts.pg.sh
node scripts/migrate-platform-auth.mjs
node --test tests/platformAuth.integration.mjs
node scripts/migrate-platform-auth.mjs
npm run build:packages
npm run build
npx --no-install playwright install --only-shell chromium
npx --no-install playwright test -c playwright.accounts.config.mjs
```

The browser suite starts its own production server at the configured loopback origin. It follows real Mailpit links in both languages, edits a profile, recovers a password, confirms deletion, checks two real tenants, and revokes sessions on two devices. The integration suite also verifies expired email links, session denial, rate limits, transaction rollback, and delayed signup events after deletion. The separate `node --test tests/platformAuth.http.mjs` smoke test runs against an already running production server.
