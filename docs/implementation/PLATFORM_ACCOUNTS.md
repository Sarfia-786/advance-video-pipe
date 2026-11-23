> **Current implementation:** The historical first-checkpoint notes below are preserved for handoff. The subsequent maintained-auth, session, email, bilingual account UI and deletion implementation now lives in [PLATFORM_AUTH.md](PLATFORM_AUTH.md) with commands and deployment constraints. Use draft PR #22's most recent CI run for actual verification results.

# Platform accounts — first checkpoint (#4)

Branch: \`feat/platform-accounts\`, based on main. Follow PR #2 for independent milestones.
This checkpoint **does not provide login, cookies or real sessions yet**; private endpoints must fail closed until a maintained auth integration is wired.

## Delivered contract

- \`db/migrations/0001_platform_accounts.sql\`: platform profiles, personal/team workspaces, role memberships, credit wallets and append-only credit entries, with uniqueness constraints.
- \`platform.provision_account_created(user_id, event_id, starter_credits)\`: one atomic PostgreSQL operation after an *authenticated/trusted* account-created event, serialized per user. An event replay or different event ID for the same user cannot recreate the grant (unique \`signup:<user_id>\`). Colliding event IDs for different users raise an error. Configured grant 0 is supported.
- \`lib/platform/accounts/provision.mjs\`: validated event and parameterized adapter entry point. Default starter credits: 25; configurable using \`PLATFORM_STARTER_CREDITS\`.
- \`lib/platform/accounts/authorization.mjs\`: server-only injectable session, membership, role and plan access checks. If session integration is absent, return 503 instead of accepting MuAPI credentials.

## Migration execution

With PostgreSQL already running, execute the SQL file using \`psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0001_platform_accounts.sql\`. Repeat against a populated fixture to verify idempotent DDL. The database owner must control the \`platform\` schema; the \`provision_account_created\` function is not for anonymous/public database roles. Restrict \`USAGE\` and \`EXECUTE\` privileges appropriately before exposing the database to less-trusted roles.

After the maintained authentication adapter creates a real user, deliver one trusted event:

\`\`\`js
await provisionAccountCreated(db.query.bind(db), {
  type: 'account.created',
  userId: serverVerifiedUser.id,
  eventId: providerEventId,
});
\`\`\`

The function must run **after** the auth provider has committed its user record. It is retryable if event delivery fails. Connect this through an outbox/retry worker in the next checkpoint rather than issuing credits from the client.

## Checkpoint tests

\`node --test tests/platformAccounts.test.mjs\` tests validation, parameterization, no-session denial, role isolation and server-side plan enforcement. Tests use an injectable query double and do **not** validate an actual PostgreSQL migration, concurrent DB callbacks, session expiration, CSRF or email flows. Those require an integration environment.

## Remaining tasks (not implemented)

1. Add and lock maintained auth + PostgreSQL driver dependencies and adapter-owned user/session/account/verification schema; wire real signup/login and auth lifecycle.
2. Migrate empty and populated PostgreSQL fixtures; test concurrent grant callbacks and event-ID reuse on a real database.
3. Add email verification, password recovery, invalid/expired-session tests, logout-all, rate limits and CSRF/origin checks with a local mail inbox.
4. Mount private \`/api/platform/v1\` profile/settings/delete endpoints, transactionally delete user and revoke sessions; add EN/ZH login/signup/profile/settings pages.
5. Verify isolation, MuAPI-key denial and account deletion end-to-end, with real commands/outcomes in the next PR checkpoint.

This feature does not overlap captions (#3).
