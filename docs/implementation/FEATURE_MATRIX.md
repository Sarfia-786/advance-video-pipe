# Studio delivery map

[Tracker and follow-up issues](https://github.com/Sarfia-786/advance-video-pipe/issues/1) · [Reference PR](https://github.com/Sarfia-786/advance-video-pipe/pull/2)

| Feature | Free / Premium | Entry and contract | Storage or provider | Check and status |
| --- | --- | --- | --- | --- |
| Plain subtitles | Both | `/captions`, `/zh/captions`; POST `/api/platform/v1/captions/srt` | Stateless, no keys | Node tests and Chromium download in `tests/captionsSrt.test.mjs` and `e2e/captions.spec.mjs`; implemented in PR #2 |
| Word timing | Both | Caption editor → timed words → SRT or timing JSON | Imported provider timestamps or manual entry | Implemented for #3. Unit, HTTP and EN/ZH browser cases use a two-speaker fixture. |
| Animated captions | Premium | Timed words → render | FFmpeg/libass | Queued in issue #15. |
| Accounts and entitlements | Both tiers | Studio → Account, `/zh/account`, `/api/platform/v1/me` | PostgreSQL sessions and subscription state | #4 and #5 cover account lifecycle, tier changes, limits and workspace isolation |
| Dashboard and projects | 7-day projects / persistent projects, folders, history and teams | Shell and project pages → platform API | PostgreSQL and private object storage | #7–#9 cover storage, expiry, collaboration and the dashboard |
| AI, workflows and batch | BYOK/local, manual and 2 templates / managed, 3 pipelines, 5–10 clips | Chat, scene editor and graph → persistent jobs | Existing workspace packages, providers, workers and credits | Planned; validate scenes, retry and single charge |
| Media, voice and design | Basic 720p, watermark, capped narration and thumbnail / 1080p or supported 4K, cloning, dubbing, branding and variants | Studio, timeline, voice and design → asset and render APIs | FFmpeg, Repo 2, model capabilities, storage | Planned; check dimensions, watermark, consent and asset rights |
| Billing, usage and deployment | Basic meter / detailed credit history, subscriptions and packs | Account → credit history, billing → signed webhooks | PostgreSQL ledger, Stripe and Razorpay | Balance and private credit history in #5. Credit accounting, payment providers and deployment in #6, #19 and #20 |

For the reference PR, install with `npm ci`, run `npm run build:packages`, `npm test` and `npm run build`. Run `npx playwright install chromium` then `npx playwright test`. To use an installed Chromium, set `CHROMIUM_PATH` to its executable. For manual verification start `npm start` and open `/captions`.

The export accepts JSON containing `cues`, an ordered array of 1–500 objects with integer `startMs`, `endMs` and `text`. End time is exclusive; gaps and adjacent cues are valid. Invalid cue data returns 422 with a stable error code and one-based cue number when applicable. Invalid JSON returns 400, oversized input 413, and unsupported media type 415. Success downloads UTF-8 SRT with CRLF. The handler processes submitted text in memory and does not retain it.

### Word timing contract

In either caption editor, choose **Word timing**. Paste JSON from an alignment service or add words and enter their actual times. The playhead highlights the active word and shows its speaker. Edits stay in the tab. **Save timing JSON** downloads a track that can be imported again with its original provider intervals and corrections.

The existing SRT endpoint also accepts an object with a single `words` array. Supply 1–1,000 ordered entries such as `{"text":"Hello","startMs":120,"endMs":410,"speakerId":"Ana"}`. Times are integer milliseconds with an exclusive end. Intervals can touch; gaps are silent. This single track rejects overlapping intervals. Raw provider entries default to `source: "provider"`. Manual entries use `source: "manual"`. Editing an imported interval keeps both the current interval and its `providerTiming` and displays `source: "corrected"`. Returning to the original interval restores its provider label. Source describes the submitted metadata.

Cues start at the first real word and end at the last. Silence, a speaker change, or eight words starts a new cue. Missing intervals return HTTP 422 with an error code and, where available, a one-based word index. Issue #13 wires live voice-provider output to this contract. Issue #15 handles burning word highlights into video.

### Account entitlements

After applying `node scripts/migrate-platform-auth.mjs`, sign in and open **Account and settings** or **账户与设置**. The account page displays the current plan, subscription status, retention, cloud storage limit, monthly voice allowance and export watermark policy. Members with detailed usage access can open and paginate their credit history.

`GET /api/platform/v1/me` returns the effective `plan` and an `entitlements` object with `status`, `accessUntil`, `capabilities` and `limits`. Both account and workspace reads recompute the tier from the verified user's current database profile. Server handlers can call `requireCapability(actor, name, value)` after loading the actor. For example, `GET /api/platform/v1/usage/history` requires detailed usage access. It returns up to 50 of the caller's entries, newest first. Pass the returned `nextBefore` as `?before=` for older entries. Anonymous requests receive 401 and Free requests receive 403.

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

The service quotas are configurable through the per-tier variables in `.env.example`. Zero is a valid quota. The ledger balance is independent of the subscription. Storage, jobs and voice services consume these limits in #7, #10 and #13. The billing integration in #19 should write the persisted plan, subscription status and cutoff in one transaction.

`node --test tests/platformEntitlements.test.mjs` checks every feature in the tracker matrix for each lifecycle state. `tests/platformEntitlements.http.mjs` checks a real session through upgrades and downgrades, an attempted client-supplied tier, tenant isolation and pagination. The English and Chinese account journeys in `e2e/accounts.spec.mjs` also exercise Free limits and Premium credit history.
