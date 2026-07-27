# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Stream Deck habit tracker with an AI coach. Physical Stream Deck keys hit
`/api/log` on a Vercel-hosted backend; taps land in Redis and appear on a live
dashboard. Beyond the fixed habits, **AI slot keys** are controlled by an
LLM (z.ai GLM): 4 front-page slots plus up to 12 more on the Coach page of the
bundled two-page profile (#52). It assigns habits it wants tracked, reacts to
taps in near real time (e.g. Eat → food-feedback keys), and a custom Stream
Deck plugin repaints the physical key faces to match. The slot keys are the
AI's interface to its human — treat prompt/UX changes with that framing.

Production: https://stream-deck-habit-tracker.vercel.app (project
`stream-deck-habit-tracker` in the `shaiss-projects` Vercel team, git-connected
to this repo — **every push to the default branch deploys production**).

## Commands

```bash
# One-time per machine (tool deps are intentionally NOT in package.json —
# runtime deps are kept lean on purpose so Vercel's build stays trivial, but
# they are NOT just @vercel/functions: the coach runs on a Mastra agent, so
# @vercel/functions, @mastra/core, @ai-sdk/openai-compatible, and zod are all
# load-bearing runtime deps and belong in package.json; do not prune them.
# esbuild + @elgato/streamdeck are BUILD-time deps of the Stream Deck plugin —
# the SDK is bundled into bin/plugin.js, never installed at runtime):
npm i playwright-core pngjs gifenc esbuild @elgato/streamdeck --no-save

# Regenerate still icons (icons/) and animated GIFs (icons/animated/):
node tools/make-icons.mjs
node tools/make-animations.mjs

# Rebuild the Stream Deck plugin package into public/downloads/ (renders
# manifest images, bundles src/ -> bin/plugin.js, zips). Bundle-only rebuild:
# node tools/bundle-plugin.mjs
node tools/build-plugin.mjs

# Regenerate the bundled profile (single-user build: 15-key, plugin flavor,
# 2 pages). It ships INSIDE the .sdPlugin (manifest Profiles[] AutoInstall,
# issue #50) — re-run build-plugin.mjs afterwards so the package picks it up:
node tools/generate.mjs "https://stream-deck-habit-tracker.vercel.app/api/log" --plugin --static --pages=2 --outfile="streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/profiles/Habit Tracker AI.streamDeckProfile" --name="Habit Tracker AI"

# Tests — run before every PR (the ship skill enforces this):
npm test          # unit suite, zero-dep (glob form is required on this Node —
                  # `node --test tests/unit/` fails, the script uses the glob)
npm run test:e2e  # habit-manager suites drive Chromium; the plugin suite spawns
                  # the real Node plugin against a mock Stream Deck WebSocket
                  # (needs playwright-core + Chromium + @elgato/streamdeck + esbuild)

# Plus: node --check every touched .js/.mjs file. Final verification is still
# against the live deployment (see below).
```

Headless Chromium lives at `/opt/pw-browsers/chromium` in this environment
(`CHROME_PATH` overrides). Playwright's bundled ffmpeg has **no PNG decoder or
GIF encoder** — that's why GIFs are assembled with pngjs+gifenc.

## Verifying changes

`tests/unit/` (pure logic: validation, scorer, quality, JSON extraction, hue
drift guard) and `tests/e2e/` (habit-manager flows in headless Chromium against
a mock server) run locally and in CI (.github/workflows/ci.yml). New UI behavior
ships with a regression test. After merging, also probe the live deployment:

- `GET /api/health` — storage + AI wiring (env var names only; never values),
  plus `deck` — when a *physical* Stream Deck last polled (`null` = the plugin
  has never connected). First thing to check when hardware keys look stale.
- `GET /api/slots` — current AI slot assignments, plus `coachPage` (the wider
  Coach-page array, #52) and `coachNav` (navigation consent, #54)
- `GET /api/log?habit=Test` — writes a real row (`?slot=N` for slot keys)
- `GET /api/suggest?run=1` (or POST) — full AI refresh; 30s cooldown
- `GET /api/nudge` — proactive-nudge state + gate evaluation (`?run=1` forces
  a nudge pass, bypassing the gates; 30s cooldown, may repaint a slot key —
  the passive loop rides the plugin's /api/slots poll, no cron). POST-only
  `?suppress=1` (24h takeover kill switch) and `?takeover=1` (atomic once-a-day
  budget claim via SET NX) back the coach-navigation guardrails (#54)
- `GET /api/roster` — pending roster proposals + retirement archive
  (`?run=1` forces a coach roster pass; 30s cooldown)
- `GET /api/experiment?run=1&models=a,b&n=3` — replay captured coach contexts
  against multiple models, rule-scored (lib/quality.js); CI wrapper in
  .github/workflows/coach-experiment.yml

Direct egress to `*.vercel.app` is blocked from this sandbox's proxy; use the
Vercel MCP `web_fetch_vercel_url` tool to probe the live site.

## Architecture

**Backend** (`api/*.js`, plain Vercel Node functions, ESM):
- `lib/store.js` — Redis-over-REST (Upstash/KV env vars auto-detected). Core
  keys: `habits:log` (RPUSH list of `{h,t,note,e?,slot?}`), `habits:slots`
  (`{slots:[def|null x4], suggestedAt, reactedAt, model}` — the length-4 front
  page is load-bearing, do not widen it), and `habits:coach:page`
  (`[def|null x12]`, the Coach page behind slots 5..16, #52). The once-a-day
  takeover budget is a `SET NX EX` on `habits:takeover:<day>` (#54).
- `lib/ai.js` — z.ai OpenAI-compatible client used directly only by
  `/api/experiment` (byte-identical model-vs-model comparison). Model =
  `ZAI_MODEL` env or `glm-5.2`, with automatic fallback to `glm-4.7-flash` on
  model-level errors. Key from `ZAI_API_KEY` (also accepts
  `Z_AI_API_KEY`/`GLM_API_KEY`/`ZHIPU_API_KEY`). Also home to `extractJson`,
  the fenced/wrapped-JSON parser every coach pass runs its reply through.
- `lib/agent.js` — the coach as a Mastra `Agent`. z.ai plugs in via the AI
  SDK's OpenAI-compatible provider, but through a **custom `zaiFetch` that
  injects `thinking:{type:'disabled'}`** into every `/chat/completions` body —
  GLM-5.x are hybrid reasoning models and burn the whole token budget thinking
  otherwise (PR #2). Never wire the agent up without that fetch; it is the only
  guardrail. Hypothesis memory is a two-tool loop: `recall_hypotheses` (reads
  prior notes at the start of a pass) and `update_hypotheses` (rewrites them
  when the model's understanding changes). Both are Mastra-mediated; the bytes
  persist in the `habits:coach:memory` Redis key via `lib/store.js` (survives
  cold starts — Mastra's in-process memory would not, and we deliberately do
  not add a full storage adapter).
- `lib/coach.js` — the AI coach, **purely Mastra-routed** (no raw-z.ai
  fallback). Six entry points: `fullSuggest()` (manual refresh), `morningPass()`
  (cron), `reactTo(entry)` (per-tap background pass via `waitUntil` from
  `@vercel/functions`, 45s cooldown claimed in Redis *before* the model call to
  prevent double-fire), `nudgePass()` (proactive single-slot repaint, driven by
  the deck's `/api/slots` poll), `rosterPass()` (self-managing roster), and
  `dailyDigest()` (cron insight). A coach failure no longer silently rescues —
  it surfaces as a clean error: `reactTo`/`nudgePass` no-op (already inside
  `waitUntil(...catch)`), `fullSuggest`/`morningPass`/`dailyDigest` return null
  → a 502 at the API, `rosterPass` queues nothing. All slot output is sanitized
  hard (`sanitize()`) and replaces all 4 slots atomically.
- `lib/roster.js` — the **self-managing roster**: the coach proposes changes to
  the *fixed* habit list (`rosterPass()` in coach.js, run by the morning cron
  after the keys pass and never allowed to fail it). Proposals only ever queue;
  a human decision in the habit manager applies one (`api/roster.js`). Pure
  functions, so the rules are unit-tested without Redis. Invariants worth
  keeping: nothing self-applies, the projected roster stays within 1..10 in any
  approval order, retirement is soft (archived + restorable, `habits:log`
  untouched), and a dismissal is remembered in `rejected` so the coach stops
  re-asking. Roster passes are deliberately **not** captured into the dataset —
  that corpus and `lib/quality.js` are slot-shaped.
- `api/log.js` — resolves `?slot=N` to the *current* assignment at tap time and
  stores the habit name+emoji in the entry, so history stays truthful after
  swaps. Responds before the reactive pass runs.
- CORS is open (`*`) on read/log endpoints for the dashboard and any legacy
  in-browser callers (the Node plugin itself doesn't need CORS).

**Frontend** (`public/index.html`) — single static file, no framework, no build
step. Dashboard + AI Coach section; polls every 20s.

**Stream Deck plugin** (`streamdeck-plugin/`) — a **Node.js-runtime** plugin:
Stream Deck ≥7.1 spawns `bin/plugin.js` under its bundled Node 24. The legacy
HTML/QtWebEngine runtime — and its whole hidden-page pathology (timer
throttling, the Worker-kills-the-renderer "code 18" crash-loop, the
`streamdeck-timerfix` beat) — is gone; see git history if archaeology calls.
Source is `src/` (plain ESM, no TypeScript, no property inspector):
- `src/faces.mjs` — key faces as SVG data URIs (Nocturne Ritual look). Hue
  comes from the shared `tools/lib-hue.mjs`; the unit drift guard asserts the
  import so the formula can't fork. Colors are pre-baked to hex (SVG
  rasterizers disagree on `hsl()`), and every AI-supplied string is
  XML-escaped.
- `src/scheduler.mjs` — the pure wall-clock poll scheduler. Kept from the HTML
  era **on purpose**: it defends against a *hung backend*, not a throttled
  page. The single-flight guard is a deadline (`POLL_TIMEOUT_MS`); an expired
  poll is aborted and retried immediately, and a sequence number orphans its
  late settle so it can't clear the retry's guard.
- `src/plugin.mjs` — wires it all into `@elgato/streamdeck` (2.x). Three
  actions, all live: `…habit` ({base, index} — resolves the habit at that
  position from `/api/slots`), `…slot` ({base, slot 1-16} — 1-4 render from
  the front array, 5-16 from `coachPage`, #52), and `…coach` (#53 — attention
  face, tap → `switchToProfile` to the Coach page of the bundled profile,
  long-press → 24h takeover suppression). Faces render from one `/api/slots`
  poll, taps resolve server-side (`?hkey=`/`?slot=`). Missing `settings.base`
  falls back to the compiled-in production origin so hand-placed keys stay
  alive (#55). Timing is env-overridable (`HT_POLL_MS`, `HT_TICK_MS`,
  `HT_POLL_TIMEOUT_MS`, `HT_RECHECK_MS`) so e2e runs in seconds; production
  defaults are 15s poll / 3s tick / 10s timeout / 2,5,9,15,25s rechecks.
- `src/visibility.mjs` — pure page-visibility inference (#53): generated keys
  carry `{page: N}`; the appeared-key set derives `visiblePage`/`anyVisible`.
  A page-tagged key is the only proof our profile is the one on screen —
  hand-placed keys in foreign profiles abstain, and navigation refuses.
- Takeover (#54): `lib/takeover.js` is the pure gate (consent default-off,
  live-nudge-only, quiet hours, 10min human-priority lock, ≤1/day budget,
  kill switch; fail-closed on a broken clock). The plugin evaluates it on the
  poll beat; the budget and kill switch are re-checked server-side at claim
  time so a restarted plugin can't double-spend. Auto-restore after 90s or on
  any tap.

⚠️ Hard-won SD 7.x facts, each verified on hardware:
- **A profile-baked `States[].Image` silently vetoes plugin `setImage`** — the
  app treats it as a user customization. That's why `generate.mjs` emits
  image-less states (`liveStates()`) for plugin-flavor keys; the manifest's
  default action images cover the seconds before the first poll paints. Never
  re-add images to plugin profile keys, or physical faces will never repaint
  again (they were live-verified dead this way).
- The SDK reads `manifest.json` from `process.cwd()` (the app launches the
  plugin from inside the `.sdPlugin` folder) and **routes errors to a file
  logger** (`logs/` under cwd) — a broken plugin exits code 0 with silent
  stdio. When "nothing happens", read those logs, not the console.
- Action events are refused for devices the SDK doesn't know — the mock app in
  e2e must announce the device in the registration `-info` payload.
- In plain JS the `@action` decorator is applied as a function
  (`action({ UUID })(class …)`), stamping `manifestId` for `registerAction`.

Taps push a **chain** of rechecks (2/5/9/15/25s) because the reactive coach pass
runs in the background after `/api/log` answers — one recheck often lands before
the swap exists. The poll tags itself `?deck=<version>&keys=N` (plus `?key=` when
`HABIT_KEY` is set); `api/slots.js` records that as `habits:deck` so
`/api/health` and the dashboard can say whether a *physical* deck is live (the
only way to tell a dead plugin from a dead backend). That heartbeat is the **one
write on an otherwise read-only, open-CORS endpoint**, so it honors the same
`HABIT_KEY` gate as `/api/log` — otherwise anyone could forge "the hardware is
live". `plugin` is query-string input all the way to the dashboard: stripped of
non-`[\w.+-]` on write and `esc()`d again at render. Don't drop either end — the
server's 20-char truncation is *not* a defense (`<svg onload=alert()>` is exactly
20). `bin/plugin.js` is an **esbuild bundle and a committed artifact** —
rebuild with `node tools/bundle-plugin.mjs` after any `src/` change, or ship a
stale plugin. `tests/e2e/plugin.e2e.mjs` spawns the real entry against a mock
Stream Deck WebSocket server + mock backend (no Chromium for this suite) and
includes a bundle boot smoke.

**Asset pipeline** (`tools/`): generators read the LIVE habit list from
`/api/habits` (tools/lib-habits.mjs), falling back loudly to
`config/habits.json` when the deployment is unreachable — which is always the
case in this sandbox, so sync the config from the live API before rebuilding
here (see the rebuild-artifacts skill). Icons and
animations are rendered in headless Chromium (emoji via Noto Color Emoji) and
committed. `generate.mjs` builds `.streamDeckProfile` files — zips (via
`lib-zip.mjs`, hand-rolled writer, no deps) containing profile manifests with
base64 data-URI images and per-key Settings; `--plugin` targets our plugin,
default targets Web Requests; `--model=mk2|neo|xl|mini|original` sets grid
layout. `build-plugin.mjs` packages the `.sdPlugin` folder the same way.

**Distribution** (`public/downloads/` + `public/setup.ps1`): built artifacts
are committed and served by Vercel. Windows bootstrap one-liner:
`irm https://stream-deck-habit-tracker.vercel.app/setup.ps1 | iex`.
The script is a **clean reinstall** and the supported upgrade path: it
downloads + stages + validates first (fail closed — nothing destructive
until the replacement is proven good), then stops the Stream Deck app,
removes prior installs (both plugin ids — `com.shaiss.…` and the legacy
`com.kalmansforge.…` — plus any `Habit Tracker*` profiles found in
**both** `ProfilesV2` (SD 6.x) and `ProfilesV3` (SD 7.x) by manifest Name),
copies the staged plugin into `%APPDATA%\Elgato\StreamDeck\Plugins` (silent —
no app prompt, no "already installed" refusal), and relaunches the app (which
also re-enables a plugin SD had marked unstable). There is no import step:
the profile ships inside the `.sdPlugin` (manifest `Profiles[]` with
`AutoInstall: true`, issue #50), so the run ends with **zero prompts** —
but uninstalling the plugin removes the profile with it. Keep the script
PowerShell-5.1-safe and `irm | iex`-safe:
no `$PSScriptRoot`, no param blocks, no pwsh-7-only syntax, **pure ASCII**
(irm decodes charset-less text as ISO-8859-1).
After changing the plugin or generator, **rebuild and re-commit the artifacts**
— they don't rebuild themselves (Vercel runs no build step; `dist/` is
gitignored scratch, `public/downloads/` is the published copy).

## Conventions & gotchas

- ESM everywhere (`"type": "module"`); the plugin's `src/` is Node ESM like
  the rest of the repo (the browser-ES5 `app.js` died with the HTML runtime).
- API functions read `config/habits.json` via `createRequire` (`lib/ai.js`
  exports `BASE_HABITS`) so Vercel's bundler traces it.
- `Date.now()` timestamps (epoch ms) everywhere; the dashboard groups days in
  the *viewer's* timezone by design.
- Env vars bind at deploy time — after adding one in Vercel, a redeploy (any
  push) is required before functions see it.
- The optional `HABIT_KEY` env var gates writes (`?key=`); regenerate profiles
  with `--key=...` if it's ever set.
- Model replies are parsed with `extractJson` (first `{`…last `}`) — GLM often
  wraps JSON in fences; never assume clean JSON.
