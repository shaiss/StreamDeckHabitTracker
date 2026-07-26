---
name: ship
description: >
  Ship a change in this repo end-to-end: feature branch, commit, push, PR into
  the default branch, squash-merge, sync local, then verify the Vercel
  production deployment with live probes. Use this whenever work in this repo
  is ready to land — the user says "ship it", "merge this", "PR and merge",
  "deploy", or a feature/fix is complete and needs to reach production. Every
  push to the default branch deploys production, so landing code and verifying
  the deployment are one motion, not two.
---

# Ship a change

Production deploys straight from the default branch (`claude/stream-deck-developers-tqy1gj`
unless the repo has migrated to `main`) via Vercel's git integration. There is no CI
and no test suite — the deploy-and-probe loop below IS the verification, so never
skip step 6.

## Procedure

1. **Pre-flight**: `node --check` every touched `.js`/`.mjs` file. If assets or
   the plugin changed, run the `rebuild-artifacts` skill first so
   `public/downloads/` is current — artifacts never rebuild themselves.
2. **Branch + commit**: `git checkout -b <type>/<slug>` (`feat/`, `fix/`).
   Commit with a body that explains why, not just what.
3. **Push with retry**: `git push -u origin <branch>`; on network failure retry
   up to 4 times with 2s/4s/8s/16s backoff.
4. **PR + squash-merge** (GitHub MCP tools, not gh):
   - `create_pull_request` — base = default branch. Reference issues with
     "Closes #N" so they auto-close. Include a Verification section: what will
     be probed after merge.
   - `merge_pull_request` with `merge_method: "squash"`.
   - Bot comments (vercel, qodo, coderabbit rate-limits) are informational —
     don't act on them unless they contain a real finding.
5. **Sync local**: `git checkout <default>` then `git fetch origin <default> &&
   git reset --hard origin/<default>`. Never stack new work on the pre-squash
   local history.
6. **Verify the deployment** — the part that actually matters:
   - Wait for the new production deployment to be READY (Vercel MCP
     `list_deployments` / `get_deployment`, project
     `prj_hTBLnz4IyamCkmoFpUfficp74MSG`, team `team_e0dr5cnjRESXstDRPJ5Pfyoa`).
     Builds are fast (~10-45s); poll, don't assume.
   - Probe what changed via the Vercel MCP `web_fetch_vercel_url` tool —
     direct egress to `*.vercel.app` is blocked from the sandbox:
     - `/api/health` — storage + AI wiring (names only)
     - `/api/slots` — slot assignments (add `?track=1` for the scorecard)
     - `/api/suggest?run=1` — real AI pass (30s cooldown; consumes a model call)
     - `/api/cron/morning?run=1`, `/api/cron/daily?run=1` — scheduled passes
     - `/api/experiment?run=1&n=1` — model comparison (consumes model calls)
     - static pages: `/`, `/deck.html`, `/mind.html`
   - A 503 with setup guidance is a healthy response for unconfigured
     dependencies; a 500 or empty body is not.
7. **Report**: state what merged (PR link), what was probed, and what the
   probes returned. If a probe fails, fix forward on a new branch — do not
   leave the default branch broken, it IS production.

## Env-var gotcha

Env vars bind at deploy time. If the change depends on a variable added in the
Vercel dashboard after the last deploy, the merge itself supplies the redeploy —
but verify the variable is visible via `/api/health` before debugging anything else.
