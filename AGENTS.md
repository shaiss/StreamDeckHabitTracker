# AGENTS.md

This repo keeps a single source of truth for agent guidance:
**[CLAUDE.md](./CLAUDE.md)**. Read it first.

It exists so the same guidance serves every coding agent (Claude Code, ZCode,
Codex, Cursor, etc.) without duplication — switch tools freely; the instructions
don't move. The file is named `CLAUDE.md` for historical reasons only.

## What's in CLAUDE.md

Treat it as authoritative for:

- **What the project is** — Stream Deck habit tracker with an AI coach (z.ai GLM)
  that owns up to 4 slot keys on the physical deck.
- **Commands** — icon/animation/profile/plugin generators under `tools/`, and the
  test suites (`npm test`, `npm run test:e2e`).
- **How to verify changes** — which endpoints to probe on the live Vercel
  deployment, and the unit/e2e test layout.
- **Architecture** — backend (`api/`, `lib/`), static frontend
  (`public/index.html`), the Stream Deck plugin, and the asset pipeline.
- **Conventions & gotchas** — ESM everywhere, `Date.now()` timestamps, the
  `extractJson` parsing rules, env-var-bind-at-deploy-time, and more.

## Project-local skills (under `.claude/skills/`)

These are Claude-Code-flavored skill files, but the *procedures* they describe
apply no matter which agent you are. Follow them when the trigger conditions
match:

- **[`ship`](.claude/skills/ship/SKILL.md)** — landing a change end-to-end:
  pre-flight tests, feature branch, PR, squash-merge, then probe the Vercel
  production deployment. Triggered by "ship it", "merge this", "deploy", etc.
  Every push to the default branch **is** a production deploy, so merging and
  verifying are one motion.
- **[`rebuild-artifacts`](.claude/skills/rebuild-artifacts/SKILL.md)** —
  regenerating the distributed assets (icons, animated GIFs, the
  `.streamDeckProfile`, and the packaged `.streamDeckPlugin` in
  `public/downloads/`). Required whenever `config/habits.json`, icons, the
  plugin, or `tools/generate.mjs` change; `public/downloads/` never rebuilds
  itself.

## Quick orientation

- **Default branch deploys production** — don't push broken code to it.
- **Vercel project**: `stream-deck-habit-tracker` (team `shaiss-projects`),
  git-connected. Production at https://stream-deck-habit-tracker.vercel.app.
- **Tool deps are NOT in `package.json`** (keeps Vercel's install lean):
  `npm i playwright-core pngjs gifenc --no-save` once per machine.
