# Starting point

Base commit `9cc70e5` contains a Next.js 15.5.15 / React 19 web app and a separate Vite/Electron desktop app. The four npm workspaces are checked into this repository. Build them with `npm run build:packages` before building Next.

| Area | Existing implementation | Implication for the next PR |
| --- | --- | --- |
| Web entry and language | `components/StandaloneShell.js`, `lib/locales.js`, EN and ZH routes | Preserve legacy studios and add an accessible entry in both locales. |
| Accounts and storage | Shell uses a browser-stored MuAPI key and provider balance. Compose starts the web app only. | Platform identity, private projects, PostgreSQL, object storage, queues and a credit ledger need dedicated implementation. |
| Media and workflows | `packages/studio/src/muapi.js`, the model registry, Vibe-Workflow nodes, Open-Poe-AI and Design Agent | Reuse existing provider and graph contracts. Verify live providers only when configured. |
| Desktop | `electron/main.js`, `electron/preload.js` and `electron/lib` handle local inference. Web security and context isolation are enabled; Node integration is disabled. | Keep model executables on the desktop/worker and review each new IPC capability. |
| Routing | `middleware.js` rewrites legacy provider API paths. | Put platform handlers under `/api/platform/v1`. |
| Release dependencies | Root MIT license, package-specific licenses and provider/model terms; no root CI workflow or lint configuration on the base. | Check the actual dependency/model terms and record test, build and environment evidence per PR. |
