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
# only @vercel/functions is a runtime dep; keep it that way so Vercel's
# build stays trivial):
npm i playwright-core pngjs gifenc --no-save

# Regenerate still icons (icons/) and animated GIFs (icons/animated/):
node tools/make-icons.mjs
node tools/make-animations.mjs

# Rebuild the Stream Deck plugin package into public/downloads/:
node tools/build-plugin.mjs

# Regenerate hosted profiles (both flavors x MK2/Neo) into public/downloads/:
node tools/generate.mjs "https://stream-deck-habit-tracker.vercel.app/api/log" --plugin --static --outfile=public/downloads/HabitTracker-MK2.streamDeckProfile --name="Habit Tracker AI"
node tools/generate.mjs "https://stream-deck-habit-tracker.vercel.app/api/log" --model=neo --plugin --static --outfile=public/downloads/HabitTracker-Neo.streamDeckProfile --name="Habit Tracker AI"
node tools/generate.mjs "https://stream-deck-habit-tracker.vercel.app/api/log" --outfile=public/downloads/HabitTracker-MK2-WebRequests.streamDeckProfile
node tools/generate.mjs "https://stream-deck-habit-tracker.vercel.app/api/log" --model=neo --outfile=public/downloads/HabitTracker-Neo-WebRequests.streamDeckProfile

# Sanity: node --check every touched .js/.mjs file. There is no test suite;
# verification is against the live deployment (see below).
```

Headless Chromium lives at `/opt/pw-browsers/chromium` in this environment
(`CHROME_PATH` overrides). Playwright's bundled ffmpeg has **no PNG decoder or
GIF encoder** — that's why GIFs are assembled with pngjs+gifenc.

## Verifying changes

There are no unit tests; the loop is deploy-and-probe. After pushing, check:

- `GET /api/health` — storage + AI wiring (env var names only; never values)
- `GET /api/slots` — current AI slot assignments
- `GET /api/log?habit=Test` — writes a real row (`?slot=N` for slot keys)
- `GET /api/suggest?run=1` (or POST) — full AI refresh; 30s cooldown
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
- `lib/ai.js` — z.ai OpenAI-compatible client. Model = `ZAI_MODEL` env or
  `glm-5.2`, with automatic fallback to `glm-4.7-flash` on model-level errors.
  Key from `ZAI_API_KEY` (also accepts `Z_AI_API_KEY`/`GLM_API_KEY`/`ZHIPU_API_KEY`).
- `lib/coach.js` — the AI coach. `fullSuggest()` (manual refresh) and
  `reactTo(entry)` (per-tap background pass via `waitUntil` from
  `@vercel/functions`, 45s cooldown claimed in Redis *before* the model call to
  prevent double-fire). Both sanitize model output hard (`sanitize()`) and
  replace all 4 slots atomically.
- `api/log.js` — resolves `?slot=N` to the *current* assignment at tap time and
  stores the habit name+emoji in the entry, so history stays truthful after
  swaps. Responds before the reactive pass runs.
- CORS is open (`*`) on read/log endpoints because the Stream Deck plugin
  fetches from a CEF page.

**Frontend** (`public/index.html`) — single static file, no framework, no build
step. Dashboard + AI Coach section; polls every 20s.

**Stream Deck plugin** (`streamdeck-plugin/com.kalmansforge.habit-tracker.sdPlugin/`)
— classic SDKVersion-2 JS plugin (WebSocket, `connectElgatoStreamDeckSocket`
global). Two actions: `…habit` (static face from settings) and `…slot` (face
canvas-rendered from `/api/slots`, polled 15s + ~9s after each tap). All
per-key config (base URL, habit, colors, slot number) is **baked into profile
Settings by the generator** — the plugin has no property inspector and no
hardcoded server. Untested on physical hardware as of writing; the
`-WebRequests` profile flavor (third-party `gg.datagram.web-requests` plugin)
is the guaranteed-working fallback.

**Asset pipeline** (`tools/`): `config/habits.json` is the single source for
habits (name = logged id + URL param; label/emoji = display). Icons and
animations are rendered in headless Chromium (emoji via Noto Color Emoji) and
committed. `generate.mjs` builds `.streamDeckProfile` files — zips (via
`lib-zip.mjs`, hand-rolled writer, no deps) containing profile manifests with
base64 data-URI images and per-key Settings; `--plugin` targets our plugin,
default targets Web Requests; `--model=mk2|neo|xl|mini|original` sets grid
layout. `build-plugin.mjs` packages the `.sdPlugin` folder the same way.

**Distribution** (`public/downloads/` + `public/setup.ps1`): built artifacts
are committed and served by Vercel. Windows bootstrap one-liner:
`irm https://stream-deck-habit-tracker.vercel.app/setup.ps1 | iex`.
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
