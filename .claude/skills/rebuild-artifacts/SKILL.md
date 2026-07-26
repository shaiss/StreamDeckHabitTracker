---
name: rebuild-artifacts
description: >
  Regenerate every Stream Deck asset this repo distributes — still icons,
  animated GIF key faces, the 15-key .streamDeckProfile, and the packaged
  .streamDeckPlugin — then stage the results. Use this whenever config/habits.json changes, icon colors/motions
  change, anything under streamdeck-plugin/ changes, or tools/generate.mjs
  gains new output — the hosted files in public/downloads/ are committed
  artifacts and NEVER rebuild themselves, so skipping this ships stale
  downloads to the setup one-liner.
---

# Rebuild the distributed artifacts

Vercel runs no build step: whatever sits in `public/downloads/` is exactly what
`setup.ps1` and the README links serve. After changing habits, icons, the
plugin, or the generator, rebuild in this order (later steps embed earlier
steps' outputs).

## Habit list source (read this first)

All three generators read the LIVE habit list from `/api/habits` (what the
habit manager edits) and fall back — loudly — to `config/habits.json` when the
deployment is unreachable. **This sandbox cannot reach `*.vercel.app`**, so the
fallback always fires here. Before rebuilding from the sandbox, sync the config
from the live API so the fallback is fresh:

1. Fetch `https://stream-deck-habit-tracker.vercel.app/api/habits` with the
   Vercel MCP `web_fetch_vercel_url` tool.
2. Write the returned list into `config/habits.json` (keep the `//` comment keys).
3. Commit the sync together with the rebuilt artifacts.

On a machine with normal egress (the owner's PC), no sync is needed — the tools
fetch live directly (`--base=URL` / `HABITS_BASE` override the default origin).

## One-time per machine

Tool deps are intentionally NOT in package.json (keeps Vercel's install lean —
only runtime deps belong there). Install unsaved, all in one command so npm
doesn't prune previously-unsaved ones:

```bash
npm i playwright-core pngjs gifenc --no-save
```

Chromium is pre-installed at `/opt/pw-browsers/chromium` (`CHROME_PATH`
overrides). Playwright's bundled ffmpeg lacks PNG decode and GIF encode — that
is why GIFs go through pngjs+gifenc; don't "simplify" back to ffmpeg.

## Rebuild sequence

```bash
# 1) Still icons (icons/) — needed by profiles as static fallbacks
node tools/make-icons.mjs

# 2) Animated GIF faces (icons/animated/) — embedded in Web-Requests profiles
node tools/make-animations.mjs

# 3) Sync the virtual deck's copies (served at /icons/…)
cp icons/animated/*.gif public/icons/animated/

# 4) Plugin package (renders manifest images, zips the .sdPlugin folder)
node tools/build-plugin.mjs

# 5) Hosted profile (single-user build: 15-key, plugin flavor only)
BASE="https://stream-deck-habit-tracker.vercel.app/api/log"
node tools/generate.mjs "$BASE" --plugin --static --outfile=public/downloads/HabitTracker-MK2.streamDeckProfile --name="Habit Tracker AI"
```

If `HABIT_KEY` is ever set in Vercel, add `--key=<value>` to every generate call
— otherwise the shipped profiles will get 401s on every tap.

## Verify before committing

- `unzip -l public/downloads/com.shaiss.habit-tracker.streamDeckPlugin`
  — expect the `com.shaiss.habit-tracker.sdPlugin/` prefix on all files.
- `unzip -p "public/downloads/HabitTracker-MK2.streamDeckProfile" "*/Profiles/*/manifest.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const line of s.split(/(?<=\})\s*(?=\{)/)){if(!line.trim())continue;const m=JSON.parse(line);const a=m.Controllers?.[0]?.Actions;if(a){console.log(Object.keys(a));break;}}})"`
  — expect habit keys, the Stats key, and AI slot keys at the right cells (v3.0 page manifest; the empty Default page has `Actions:null` and is skipped).
- Visually spot-check a rendered icon (Read one PNG / a probe frame) if icon
  code changed — the generators can succeed while producing wrong art (it has
  happened: viewport bugs rendered half-off-screen icons that still "built").

Commit `icons/`, `public/icons/`, `streamdeck-plugin/…/images/`, and
`public/downloads/` together with the source change, then land it with the
`ship` skill. Bump the plugin manifest Version on plugin behavior changes.
