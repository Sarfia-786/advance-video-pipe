# Studio delivery map

[Tracker and follow-up issues](https://github.com/Sarfia-786/advance-video-pipe/issues/1) · [Reference PR](https://github.com/Sarfia-786/advance-video-pipe/pull/2)

| Feature | Free / Premium | Entry and contract | Storage or provider | Check and status |
| --- | --- | --- | --- | --- |
| Plain subtitles | Both | `/captions`, `/zh/captions`; POST `/api/platform/v1/captions/srt` | Stateless, no keys | Node tests and Chromium download in `tests/captionsSrt.test.mjs` and `e2e/captions.spec.mjs`; implemented in PR #2 |
| Word timing | Both | Caption editor → timed words → SRT or timing JSON | Imported provider timestamps or manual entry | Implemented for #3. Unit, HTTP and EN/ZH browser cases use a two-speaker fixture. |
| Animated captions | Premium | Word timing → appearance, brand presets, ASS or captioned MP4 | FFmpeg/libass and private PostgreSQL caption projects | Four styles, synchronized preview, frame checks, project round-trip, and account isolation in #15. |
| Accounts and entitlements | Both tiers | Studio → Account, `/zh/account`, `/api/platform/v1/me` | PostgreSQL sessions and subscription state | #4 and #5 cover account lifecycle, tier changes, limits and workspace isolation |
| Dashboard and projects | 7-day projects / persistent projects, folders, history and teams | Shell and project pages → platform API | PostgreSQL and private object storage | #7–#9 cover storage, expiry, collaboration and the dashboard |
| AI, workflows and batch | BYOK/local, manual and 2 templates / managed, 3 pipelines, 5–10 clips | Chat, scene editor and graph → persistent jobs | Existing workspace packages, providers, workers and credits | Planned; validate scenes, retry and single charge |
| Media, voice and design | Basic 720p, watermark, capped narration and thumbnail / 1080p or supported 4K, cloning, dubbing, branding and variants | Studio, timeline, voice and design → asset and render APIs | FFmpeg, Repo 2, model capabilities, storage | Planned; check dimensions, watermark, consent and asset rights |
| Credits and usage | Basic persisted meter / detailed tenant-scoped history | `/usage`, `/zh/usage`, GET `/api/platform/v1/usage`, Premium GET `/api/platform/v1/usage/history` | PostgreSQL append-only ledger and reservations | #6 implements atomic reserve/capture/release, grants, purchases, subscription allocations, refunds, adjustments, reversals and expiry with retry-safe operation keys |
| Billing and deployment | Provider checkout, receipts and renewal data / subscriptions and packs | Pricing/billing → signed webhooks | Stripe, Razorpay and the #6 ledger | Payment providers remain in #19; deployment and end-to-end release verification remain in #20 |

For the reference PR, install with `npm ci`, run `npm run build:packages`, `npm test` and `npm run build`. Run `npx playwright install chromium` then `npx playwright test`. To use an installed Chromium, set `CHROMIUM_PATH` to its executable. For manual verification start `npm start` and open `/captions`.

The export accepts JSON containing `cues`, an ordered array of 1–500 objects with integer `startMs`, `endMs` and `text`. End time is exclusive; gaps and adjacent cues are valid. Invalid cue data returns 422 with a stable error code and one-based cue number when applicable. Invalid JSON returns 400, oversized input 413, and unsupported media type 415. Success downloads UTF-8 SRT with CRLF. The handler processes submitted text in memory and does not retain it.

### Word timing contract

In either caption editor, choose **Word timing**. Paste JSON from an alignment service or add words and enter their actual times. The playhead highlights the active word and shows its speaker. Edits stay in the tab. **Save timing JSON** downloads a track that can be imported again with its original provider intervals and corrections.

The existing SRT endpoint also accepts an object with a single `words` array. Supply 1–1,000 ordered entries such as `{"text":"Hello","startMs":120,"endMs":410,"speakerId":"Ana"}`. Times are integer milliseconds with an exclusive end. Intervals can touch; gaps are silent. This single track rejects overlapping intervals. Raw provider entries default to `source: "provider"`. Manual entries use `source: "manual"`. Editing an imported interval keeps both the current interval and its `providerTiming` and displays `source: "corrected"`. Returning to the original interval restores its provider label. Source describes the submitted metadata.

Cues start at the first real word and end at the last. Silence or a speaker change starts a new cue. Plain SRT uses groups of up to eight words. Styled tracks use the selected group size. Missing intervals return HTTP 422 with an error code and, where available, a one-based word index. Issue #13 wires live voice-provider output to this contract. Issue #15 handles burning word highlights into video.

### Styled captions and burned MP4s

In **Word timing**, import aligned words or enter manual timestamps. **Caption style** offers TikTok highlights, Hormozi emphasis, a karaoke sweep, and bold centered captions. Adjust font, size, colors, outline, shadow, placement, grouping, safe margins, animation and highlight behavior. A word’s optional `lineBreakBefore: true` preserves an explicit break within a group. Speaker changes and pauses always start fresh groups.

Choose a local MP4 or MOV to preview and download **captioned MP4** on a verified Premium account. The renderer preserves the source video's display orientation and first audio track, encoding H.264 video and AAC audio. The interactive renderer accepts up to 32 MiB, two minutes, 4K and 60 fps, and returns up to 64 MiB. The server needs FFmpeg and FFprobe with libass, libx264 and AAC support. Install fonts for the source languages, such as Noto Sans CJK SC for Chinese. Project saves hold normalized words, original provider timings, manual corrections, and style. A brand preset holds only its style. The source video is temporary and must be selected again when reopening a project.

| Endpoint | Input and result |
| --- | --- |
| `POST /api/platform/v1/captions/ass` | JSON with `words` and optional `style`. Downloads a UTF-8 ASS track. |
| `POST /api/platform/v1/captions/render` | Multipart `video` and a `track` JSON string. Returns `captioned.mp4`. The server checks current Premium access before accepting the upload and before encoding. |
| `GET /api/platform/v1/captions/saved` | Lists the caller's caption projects and brand presets. Pass `?id=<uuid>` to load a document. |
| `PUT /api/platform/v1/captions/saved` | Send a UUID, revision, kind (`project` or `preset`), name, style, and project words. Revision 0 creates a document. A conflicting edit returns 409. An identical retry returns the saved revision. |

ASS uses 10 ms ticks. Boundaries round up to the next tick when needed. An interval that collapses to a single timestamp returns 422 with `ASS_TIME_RESOLUTION` and its word number. Plain SRT retains millisecond precision. `burnCaptionVideo` in `lib/platform/captions/render.mjs` is the reusable caption pass for the future timeline worker in #14. The caption project table provides storage until the general project workspace in #7 can link to these documents.

Apply the normal platform migrations, then run the contract and decoded-frame tests.

```sh
node scripts/migrate-platform-auth.mjs
node --test tests/captionAss.test.mjs tests/captionAss.ffmpeg.mjs
npx --no-install playwright test -c playwright.accounts.config.mjs
```

### Account entitlements

After applying `node scripts/migrate-platform-auth.mjs`, sign in and open **Account and settings** or **账户与设置**. The account page displays the current plan, subscription status, retention, cloud storage limit, monthly voice allowance and export watermark policy. Members with detailed usage access can open and paginate their credit history.

`GET /api/platform/v1/me` returns the effective `plan` and an `entitlements` object with `status`, `accessUntil`, `capabilities` and `limits`. Both account and workspace reads recompute the tier from the verified user's current database profile. Server handlers can call `requireCapability(actor, name, value)` after loading the actor. For example, `GET /api/platform/v1/usage` returns the verified caller's persisted available, reserved, spent and settled totals for both tiers. `GET /api/platform/v1/usage/history` requires detailed usage access and returns up to 50 of only that caller's entries, newest first, including operation, reason, tool, model, job and top-up metadata. Pass the returned `nextBefore` as `?before=` for older entries. Anonymous requests receive 401 and Free history requests receive 403.

| Persisted subscription | Effective access |
| --- | --- |
| Free | Free |
| Premium active | Premium until the exclusive cutoff. Active profiles with no cutoff keep access, including migrated Premium accounts. |
| Premium trialing or canceling | Premium until the exclusive cutoff. A missing or elapsed cutoff gives Free access. |
| Past due, payment failed, canceled, expired, or unknown | Free immediately |

| Limit or policy | Free | Premium |
| --- | --- | --- |
| Project retention | 7 days | Persistent |
| Workflow templates and batch size | 2 starters, no batch | All templates, 5–10 clips per batch |
| Maximum output height and watermark | 720p, required | Up to 2160p on supported renderers, no watermark |
| Default storage, monthly voice allowance and concurrent jobs | 512 MiB, 5 minutes, 1 job | 10,240 MiB, 60 minutes, 3 jobs |
| Commercial use | Read provider terms | Show eligibility based on applicable provider, model and asset terms |

The service quotas are configurable through the per-tier variables in `.env.example`. Zero is a valid quota. The ledger balance is independent of the subscription. Issue #6 adds wallet-serialized reservations and idempotent settlement: a trusted service estimates the maximum configured cost, reserves it before enqueueing, captures actual usage, releases the remainder, and records failed-job or reversal reasons. Purchase, subscription, refund, signed adjustment, reversal and optional expiry entries use the same per-user operation-key boundary and cannot make available credits negative. Storage, jobs and voice services consume these limits in #7, #10 and #13. The billing integration in #19 should post verified payment effects into this ledger and update subscription state in its own retry-safe transaction.

`tests/platformCredits.test.mjs` checks server-side estimates and ledger wrappers. `tests/platformCredits.pg.mjs` races two reservations, exercises retry-safe success/failure settlement and all non-payment ledger event kinds. `tests/platformEntitlements.http.mjs` checks a real session through upgrades and downgrades, Free meter access, Premium-only detailed history, metadata and tenant isolation. Account integration tests replay signup callbacks and replace/revoke sessions without duplicating the starter grant.
