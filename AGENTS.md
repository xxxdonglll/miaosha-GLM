# AGENTS.md

High-signal notes for OpenCode sessions working in this repo. Read before editing.

## Toolchain

- **Package manager is `pnpm`** (pinned to `pnpm@10.33.0` via `packageManager`). Don't use npm/yarn — lockfile is `pnpm-lock.yaml`.
- No CI, no linter, no formatter, no typecheck script is wired up. `pnpm test` is the only pre-merge gate besides `pnpm build`.
- `tsconfig.json` extends `.wxt/tsconfig.json`, which is **generated** by WXT. If TS can't resolve `#imports` / `wxt/*`, run `pnpm dev` (or `wxt prepare`) first to regenerate `.wxt/`.

## Commands (exact)

- `pnpm dev` — WXT dev server (HMR + extension auto-reload). Outputs to `output/chrome-mv3/`; load that folder unpacked in `chrome://extensions`.
- `pnpm build` — **not** just `wxt build`. Runs: `scripts/build-overlay.js` → `wxt build` → `scripts/verify-no-minifier-collision.mjs`. All three must pass.
- `pnpm build:overlay` — regenerate only the MAIN-world overlay files (`public/*-main.js`) without a full wxt build. Useful partial step.
- `pnpm test` / `test:watch` / `test:ui` — Vitest.
- `pnpm zip` — build + `scripts/zip-prepare.mjs`. **Requires the `zip` CLI** (macOS/Linux); fails on a bare Windows shell.
- `docs/testing.md` mentions `pnpm test:coverage` — **it does not exist** in `package.json`. Don't run or recommend it.

## Build quirks (load-bearing)

- **Minifier is forced to Terser** in `wxt.config.ts`. The WXT/Vite default (esbuild/rolldown) reused one mangled identifier for both a top-level constant and a top-level helper function, silently corrupting runtime semantics. `keep_fnames: true` is set — do not remove it.
- `scripts/verify-no-minifier-collision.mjs` runs post-build and **fails the build** if a top-level function declaration and a top-level literal assignment share a name. If you touch minifier config and this fires, the guard is right and the config is wrong.
- `public/*-main.js` are **auto-generated** by `scripts/build-overlay.js` from `src/*-main/*.js` (concatenates sorted `.js` files, wraps in an IIFE with a per-directory injection guard). **Never hand-edit `public/*-main.js`** — edit `src/*-main/` and rebuild.
- Gitignore inconsistency: `public/bm-main.js` is gitignored, but `public/volc-agentplan-main.js` and `public/volc-codingplan-main.js` are committed. All three are regenerated identically by `build-overlay.js` — check what you're committing.

## Architecture (not obvious from filenames)

- **`docs/architecture.md` describes only bigmodel.cn and is partially stale.** The codebase is now multi-platform: bigmodel.cn + volcengine.com (agentplan + codingplan). Trust the code, not that doc.
- The platform seam is `lib/platform/` — an adapter registry (`IPlatformAdapter` in `lib/platform/types.ts`). New platforms are added by implementing an adapter under `lib/platform/adapters/` and registering it in `lib/platform/index.ts`. Per the `types.ts` header: **do not edit the shared interfaces to add a platform** ("Iron Law") — implement them.
- **MAIN world vs ISOLATED world is fundamental.** bigmodel.cn (and volcengine) reject `chrome-extension://` origin requests (return empty body). All platform API calls must execute in the page's MAIN world via `chrome.scripting.executeScript({ world: 'MAIN' })`. This is why the `*-main.js` overlay scripts exist and why `lib/api/client.ts` proxies through a bigmodel tab.
- `src/*-main/*.js` are **vanilla JS with no module system**. Files load in numeric order (00-css → 10-*) and share globals — later modules depend on earlier ones' globals (e.g. `05-product.js` uses `_planOrder` from `02-state.js`).
- WXT storage key convention: `storage.setItem('local:foo', v)` stores under the **literal** key `local:foo` in `chrome.storage.local` (prefix is NOT stripped at runtime).
- `entrypoints/background.ts`: `chrome.alarms.onAlarm.addListener` **must** be registered at top level, never inside an async function — otherwise the MV3 service worker misses wake-up events after being stopped.
- `lib/api/fire-plan.ts` (bigmodel AutoFire, waves + ticket allocation) and `lib/api/strike-plan.ts` (volcengine strike queue) are parallel but distinct planners — don't conflate them.
- `scripts/captcha-server/` is an **optional local Python dev helper** (FastAPI + PaddleOCR, with a hardcoded `C:\ocr-py\Lib\site-packages` path). Not part of the build; ignore unless working on captcha OCR.

## Testing quirks

- Svelte component test files **must** be named `*.svelte.test.ts` — the `.svelte` in the name is what triggers runes-aware compilation. `.svelte.test.js` will not work.
- `vitest.config.ts`: `resolve.conditions: ['browser']` is **required** — without it Svelte 5 resolves to the SSR runtime and `mount()` throws `lifecycle_function_unavailable`. Don't remove it.
- `test.deps.optimizer.{web,ssr}.enabled = false` is intentional: WXT `fakeBrowser` + happy-dom pull in Node builtins (e.g. `node:module`) that Vite 6/rolldown can't pre-bundle. Don't "fix" this by enabling optimization.
- `tests/setup.ts` calls `fakeBrowser.reset()` in `beforeEach`. Never share storage state across tests.
- WXT `fakeBrowser` does **not** implement `chrome.scripting`/`chrome.tabs` real behavior. Tests for `authStore.captureFromTab()` / `client.ts` need `vi.mock('wxt/browser', ...)` (see `docs/testing.md` §5.5). `tests/integration/` currently exists but is empty.
- bm-main vanilla-JS tests run in a Node `vm` sandbox via `tests/unit/bm-main/_harness.ts` → `loadBmMainModules(['01-utils','02-state','05-product'])`. Always pass modules **in dependency order** or you get `ReferenceError`.
- `entrypoints/background.ts` exports a `defineBackground()` callback and is not directly importable. Pure logic like `getNextSaleTime` is **copied** into `tests/unit/entrypoints/background.test.ts` and tested there — when you change the algorithm, update the copy (the test fails to remind you).
- E2E/regression gates were removed; `pnpm build` no longer runs Playwright. `docs/testing.md` §5.6 documents the removal.

## Workflow

- Default branch in this clone is `dev`. README contribution flow: branch from `feature/...`, ensure `pnpm test` and `pnpm build` pass, then PR.
- Bump `version` in `package.json` for releases — `scripts/zip-prepare.mjs` and the README download links derive the zip name from it.
