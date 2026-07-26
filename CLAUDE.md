# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Stream Deck habit tracker with an AI coach. Physical Stream Deck keys hit
`/api/log` on a Vercel-hosted backend; taps land in Redis and appear on a live
dashboard. Beyond 5 fixed habits, up to 4 **AI slot keys** are controlled by an
LLM (z.ai GLM): it assigns habits it wants tracked, reacts to taps in near real
time (e.g. Eat → food-feedback keys), and a custom Stream Deck plugin repaints
the physical key faces to match. The slot keys are the AI's interface to its
human — treat prompt/UX changes with that framing.

Production: https://stream-deck-habit-tracker.vercel.app (project
`stream-deck-habit-tracker` in the `shaiss-projects` Vercel team, git-connected
to this repo — **every push to the default branch deploys production**).

## Commands

```bash
# One-time per machine (tool deps are intentionally NOT in package.json —
# runtime deps are kept lean on purpose so Vercel's build stays trivial, but
# they are NOT just @vercel/functions: the coach runs on a Mastra agent, so
# @vercel/functions, @mastra/core, @ai-sdk/openai-compatible, and zod are all
# load-bearing runtime deps and belong in package.json; do not prune them):
npm i playwright-core pngjs gifenc --no-save

# Regenerate still icons (icons/) and animated GIFs (icons/animated/):
node tools/make-icons.mjs
node tools/make-animations.mjs

# Rebuild the Stream Deck plugin package into public/downloads/:
node tools/build-plugin.mjs

# Regenerate the hosted profile (single-user build: 15-key, plugin flavor only):
node tools/generate.mjs "https://stream-deck-habit-tracker.vercel.app/api/log" --plugin --static --outfile=public/downloads/HabitTracker-MK2.streamDeckProfile --name="Habit Tracker AI"

# Tests — run before every PR (the ship skill enforces this):
npm test          # unit suite, zero-dep (glob form is required on this Node —
                  # `node --test tests/unit/` fails, the script uses the glob)
npm run test:e2e  # browser tests vs a mock server (needs playwright-core + Chromium)

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
- `GET /api/slots` — current AI slot assignments
- `GET /api/log?habit=Test` — writes a real row (`?slot=N` for slot keys)
- `GET /api/suggest?run=1` (or POST) — full AI refresh; 30s cooldown
- `GET /api/nudge` — proactive-nudge state + gate evaluation (`?run=1` forces
  a nudge pass, bypassing the gates; 30s cooldown, may repaint a slot key —
  the passive loop rides the plugin's /api/slots poll, no cron)
- `GET /api/roster` — pending roster proposals + retirement archive
  (`?run=1` forces a coach roster pass; 30s cooldown)
- `GET /api/experiment?run=1&models=a,b&n=3` — replay captured coach contexts
  against multiple models, rule-scored (lib/quality.js); CI wrapper in
  .github/workflows/coach-experiment.yml

Direct egress to `*.vercel.app` is blocked from this sandbox's proxy; use the
Vercel MCP `web_fetch_vercel_url` tool to probe the live site.

## Architecture

**Backend** (`api/*.js`, plain Vercel Node functions, ESM):
- `lib/store.js` — Redis-over-REST (Upstash/KV env vars auto-detected). Two
  keys: `habits:log` (RPUSH list of `{h,t,note,e?,slot?}`) and `habits:slots`
  (`{slots:[def|null x4], suggestedAt, reactedAt, model}`).
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
- CORS is open (`*`) on read/log endpoints because the Stream Deck plugin
  fetches from a CEF page.

**Frontend** (`public/index.html`) — single static file, no framework, no build
step. Dashboard + AI Coach section; polls every 20s.

**Stream Deck plugin** (`streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/`)
— classic SDKVersion-2 JS plugin (WebSocket, `connectElgatoStreamDeckSocket`
global). Two actions, both live: `…habit` ({base, index} — resolves the habit
at that position from `/api/slots`) and `…slot` ({base, slot}); faces are
canvas-rendered from one `/api/slots` poll, so habit-manager edits and coach
swaps repaint physical keys. Taps resolve server-side (`?hkey=`/`?slot=`). No
property inspector, no hardcoded server — per-key Settings come from the
generator.

⚠️ **The plugin page is a CEF page that is never visible, so page timers cannot
be trusted.** Chromium throttles `setInterval`/`setTimeout` on hidden pages
(~1/min under intensive throttling; page freezing can stop them outright), which
is why a plain 15s poll kept the *virtual* deck current but let *physical* faces
go stale (issue #5). Do not "simplify" the clock in `app.js` back to a bare
interval. Four layers, and the fix depends on all of them:
1. `ticker.js` — a Web Worker beat (3s), off-thread where throttling doesn't
   apply. Same workaround Elgato shipped as `streamdeck-timerfix`.
2. Wall-clock **deadlines** (`nextPollAt`, `rechecks[]`) re-evaluated on every
   wake instead of trusted to fire on time, so a throttled clock converges late
   rather than dropping work. `pump()` is the only scheduler; it's idempotent
   and rate-limited by `nextPollAt` + the single-flight guard. That guard
   (`inflightAt`) is itself a **deadline, not a boolean** — a silent backend
   would otherwise wedge every layer at once, since `pump()` short-circuits
   while a poll is in flight. `pump()` expires a stuck poll after
   `POLL_TIMEOUT_MS`, aborts it, and bumps `pollSeq` so its late rejection
   can't clear the guard belonging to the retry. Don't reach for `setTimeout`
   here — page timers are the thing that doesn't fire.
3. Every inbound Stream Deck WebSocket event calls `pump()`. That socket is a
   native push channel throttling can't touch, so any keypress/wake/device
   reconnect un-sticks a frozen page.
4. A page `setInterval` backstop, for a CEF build where `Worker` fails.

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
20). `tests/e2e/plugin.e2e.mjs` loads the real `app.js` against a mock
Stream Deck socket with page timers stubbed to no-ops — that suite is what keeps
the throttling fix honest.

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
The script is a **clean reinstall** and the supported upgrade path: it stops
the Stream Deck app, removes prior installs (both plugin ids —
`com.shaiss.…` and the legacy `com.kalmansforge.…` — plus any
`Habit Tracker*` profiles found in `ProfilesV2` by manifest Name), extracts
the plugin zip straight into `%APPDATA%\Elgato\StreamDeck\Plugins` (silent —
no app prompt, no "already installed" refusal), relaunches the app, and
imports the profile (the one prompt left). Keep it PowerShell-5.1-safe and
`irm | iex`-safe: no `$PSScriptRoot`, no param blocks, no pwsh-7-only syntax.
After changing the plugin or generator, **rebuild and re-commit the artifacts**
— they don't rebuild themselves (Vercel runs no build step; `dist/` is
gitignored scratch, `public/downloads/` is the published copy).

## Conventions & gotchas

- ESM everywhere (`"type": "module"`); plugin `app.js` is browser ES5-ish.
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
