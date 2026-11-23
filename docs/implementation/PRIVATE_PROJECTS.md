# Private projects and assets

Open **Projects** from Account and settings, or visit `/projects` or `/zh/projects`. A verified account can save scripts and structured project JSON, reopen a workspace, upload files and download originals. A saved revision protects edits made in a second tab. Free projects display their seven-day deadline and a warning in the last 24 hours. A currently entitled Premium owner can reopen an older project until cleanup has committed its deletion.

## Storage and retention

Run the account migrations before starting the app. PostgreSQL stores project content, asset metadata and originating job IDs. The storage quota counts the UTF-8 script, PostgreSQL's JSON text representation, ready files and in-progress reservations across the owner's personal workspace. Each document and script together can use up to 1 MiB. Each file can use up to 32 MiB within the owner's plan limit.

| Setting | Purpose |
| --- | --- |
| `PLATFORM_PROJECT_STORAGE=local` | Write files below `PLATFORM_PROJECT_ROOT`, which defaults to `.private-projects` outside the web's public directory. Mount a persistent directory shared by the web service and cleanup worker. |
| `PLATFORM_PROJECT_STORAGE=s3` | Use an existing private S3-compatible bucket. Set `PLATFORM_S3_ENDPOINT`, `PLATFORM_S3_BUCKET`, `PLATFORM_S3_REGION`, `PLATFORM_S3_ACCESS_KEY` and `PLATFORM_S3_SECRET_KEY`. Temporary credentials also use `PLATFORM_S3_SESSION_TOKEN`. |
| `PLATFORM_FREE_STORAGE_MIB`, `PLATFORM_PREMIUM_STORAGE_MIB` | Set the quotas through the platform entitlement policy. |

Keep the bucket private and give the service credentials permission to put, get and delete objects under `projects/`. Use an HTTPS endpoint, or loopback HTTP for a local MinIO instance. Asset rows remember their original backend. Keep the original bucket or directory available while it still contains referenced objects.

Run a cleanup pass with the same database and storage configuration as the web service.

```sh
node --env-file=.env.local scripts/migrate-platform-auth.mjs
node --env-file=.env.local scripts/cleanup-platform-projects.mjs
```

For continuous cleanup, supervise `node --env-file=.env.local scripts/cleanup-platform-projects.mjs --watch`. It runs immediately and then every five minutes. The scheduler in #10 can also call the exported `cleanupProjects(pool)` on its maintenance queue. Both paths use the same transactional cleanup. The one-shot command reports counts and returns a failing exit status if an object needs another attempt.

Reads and new tickets require the owner's current verified session. Free access ends at creation plus 168 hours, even when a cleanup worker is offline. A ticket expires after five minutes or at an earlier Free deadline. Cleanup locks the same profile row that billing updates, then rechecks the subscription and deadline. Removing a project or account queues the original object keys in PostgreSQL. An interrupted upload or failed delete remains recoverable. Account tombstones receive a completion time after queued objects are gone. Retirement retains credit entries and account events in `platform.retired_account_audit` under the opaque account ID.

## Private API

All paths are relative to `/api/platform/v1/projects`.

| Request | Result |
| --- | --- |
| `GET /` and `POST /` | List accessible projects and quota, or create a project with a name and optional script and document. |
| `GET /{project}`, `PATCH /{project}`, `DELETE /{project}` | Read, save or delete an owned project. Save the full editable payload with its last revision. A concurrent edit returns HTTP 409. |
| `POST /{project}/assets?kind=…&filename=…` | Upload the raw bytes with the declared content type. The server checks the extension, file signature or text format, owner and quota. |
| `POST /{project}/assets/{asset}/download` | Issue a time-limited download URL for the signed-in owner. Fetch it with the same session to receive the original bytes as an attachment. |
| `DELETE /{project}/assets/{asset}` | Remove the file reference and queue physical removal. |

A trusted generation worker calls `saveProjectAsset(pool, ownerId, projectId, metadata, bytes, { jobId })` with its own validated job identity. The HTTP upload handler accepts only the file category, filename, content type and bytes.

## Checks

```sh
node --test tests/platformProjects.test.mjs
node --test tests/platformProjects.pg.mjs
node --test tests/platformProjects.http.mjs
npx --no-install playwright test -c playwright.accounts.config.mjs projects.account.spec.mjs
```

The PostgreSQL checks use a disposable migrated database. The HTTP checks require the matching local auth origin, Mailpit and a Free quota of 1 MiB on the test server. The platform accounts workflow runs them against a private MinIO bucket. The browser checks open both language versions, save and reopen a project, download a script and delete the project.
