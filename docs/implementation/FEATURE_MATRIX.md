# Studio delivery map

[Tracker and follow-up issues](https://github.com/Sarfia-786/advance-video-pipe/issues/1) · [Reference PR](https://github.com/Sarfia-786/advance-video-pipe/pull/2)

| Feature | Free / Premium | Entry and contract | Storage or provider | Check and status |
| --- | --- | --- | --- | --- |
| Plain subtitles | Both | `/captions`, `/zh/captions`; POST `/api/platform/v1/captions/srt` | Stateless, no keys | Node tests and Chromium download in `tests/captionsSrt.test.mjs` and `e2e/captions.spec.mjs`; implemented in PR #2 |
| Word timing and animated captions | Manual edits / burned styles | Caption editor → word tracks → render | Alignment service or manually timed words, FFmpeg/libass | Next issue covers normalized words; frame verification follows in renderer |
| Accounts, dashboard, projects | 7-day projects / persistent projects, folders, history and teams | Shell, account and project pages → platform API | PostgreSQL, private S3, email | Planned; test expiry/upgrade race, roles and isolation |
| AI, workflows and batch | BYOK/local, manual and 2 templates / managed, 3 pipelines, 5–10 clips | Chat, scene editor and graph → persistent jobs | Existing workspace packages, providers, workers and credits | Planned; validate scenes, retry and single charge |
| Media, voice and design | Basic 720p, watermark, capped narration and thumbnail / 1080p or supported 4K, cloning, dubbing, branding and variants | Studio, timeline, voice and design → asset and render APIs | FFmpeg, Repo 2, model capabilities, storage | Planned; check dimensions, watermark, consent and asset rights |
| Billing, usage and deployment | Basic usage / subscription, packs, detailed history | Pricing, settings and billing → signed webhooks and ledger | Stripe, Razorpay, database, Redis | Planned; verify replay, deployment and end-to-end scenarios |

For the reference PR, install with `npm ci`, run `npm run build:packages`, `npm test` and `npm run build`. Run `npx playwright install chromium` then `npx playwright test`. To use an installed Chromium, set `CHROMIUM_PATH` to its executable. For manual verification start `npm start` and open `/captions`.

The export accepts JSON containing `cues`, an ordered array of 1–500 objects with integer `startMs`, `endMs` and `text`. End time is exclusive; gaps and adjacent cues are valid. Invalid cue data returns 422 with a stable error code and one-based cue number when applicable. Invalid JSON returns 400, oversized input 413, and unsupported media type 415. Success downloads UTF-8 SRT with CRLF. The handler processes submitted text in memory and does not retain it.
