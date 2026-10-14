# Preview isolation (issue #104)

Preview deployments must not share Production Redis data or write secrets.
This page is the ops checklist for the Vercel project
`stream-deck-habit-tracker` (team `shaiss-projects`).

**Interim rule (until this issue is closed and the checklist below is done):**
no keyed or write calls against any Preview URL.

Code in this repo enforces a fail-closed gate when `VERCEL_ENV=preview` and
Redis is configured: Preview must have either a non-empty `REDIS_KEY_PREFIX`
(or `PREVIEW_REDIS_PREFIX`) **or** `PREVIEW_REDIS_ISOLATED=1`. See
`lib/store.js`.

---

## Recommended layout

| Concern | Production | Preview |
|---|---|---|
| Upstash / KV REST URL + token | Production-only env vars | **Separate** Upstash database; Preview-only env vars |
| `REDIS_KEY_PREFIX` | unset (empty) | `preview:` (defense-in-depth even with a separate DB) |
| `PREVIEW_REDIS_ISOLATED` | unset | `1` after the Preview-only Upstash is wired |
| `HABIT_KEY` | Production only | **Do not** set on Preview |
| Coach AI keys (`ZAI_*` / aliases) | Production (and Preview only if you intentionally want a Preview coach) | Prefer a separate key or leave unset |

Primary isolation is a **second Upstash database** whose REST URL/token exist
only on the Preview environment. The key prefix keeps Preview writes off the
Production keyspace if the same URL is ever attached by mistake.

---

## Vercel console checklist (Shai / Keel)

You cannot complete these from git — do them in the Vercel dashboard (or CLI
as the project owner).

### 1. Create a Preview-only Upstash Redis database

1. In [Upstash](https://console.upstash.com/) (or the Vercel Storage UI), create
   a **new** Redis database dedicated to Preview. Do not reuse Production.
2. Copy its REST URL and token.

### 2. Scope Redis credentials per environment

In Vercel → Project → **Settings → Environment Variables**:

1. For each Production Redis var
   (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, and/or
   `KV_REST_API_*`, `REDIS_REST_*`, `STORAGE_REST_API_*`):
   - Ensure the environment checkboxes are **Production** only
     (uncheck Preview and Development if they were shared).
2. Add the **Preview** database credentials with the same variable **names**,
   scoped to **Preview** only (values = the new database).
3. Redeploy Preview (and Production after any Production env edit) — env vars
   bind at deploy time.

### 3. Set Preview isolation env vars

Still under Environment Variables, for **Preview** only:

| Variable | Value | Notes |
|---|---|---|
| `REDIS_KEY_PREFIX` | `preview:` | Applied to every `habits:*` key in `lib/store.js` / habits / dataset |
| `PREVIEW_REDIS_ISOLATED` | `1` | Attests the Preview Upstash DB is not Production |

Production must leave both unset (or empty).

Optional alias: `PREVIEW_REDIS_PREFIX` if you prefer that name;
`REDIS_KEY_PREFIX` wins when both are set.

### 4. Keep `HABIT_KEY` on Production only

1. Open `HABIT_KEY` in Environment Variables.
2. Confirm it is scoped to **Production** only.
3. Remove it from Preview / Development if present.
4. Do not put the value in git, PR descriptions, or screenshots.

Without `HABIT_KEY` on Preview, anonymous writes are open on that deployment —
that is acceptable only because Preview Redis is isolated. Do not point a
physical deck or installer at Preview.

### 5. Fork pull requests and Preview secrets

Vercel **does** create Preview deployments for PRs, including from forks, but
**Git Fork Protection** requires a repo owner / team member to authorize a
forked PR before it deploys when the project has environment variables (or the
PR changes `vercel.json`). That gate exists so fork code cannot silently
receive project secrets / OIDC.

Confirm and keep protection on:

1. Vercel → Project → **Settings → Security** (or Git).
2. Ensure **Git Fork Protection** remains **enabled**.
3. Do not disable it for this project — Preview Redis tokens and any Preview
   AI keys must not auto-inject into unauthorized fork deployments.

Authorized fork deploys (after a human clicks deploy) **will** receive Preview
env vars. Treat authorization as a trust decision; prefer same-repo branches
for work that needs Redis.

Docs:
[Vercel for GitHub — Deployment Authorizations for Forks](https://vercel.com/docs/git/vercel-for-github).

### 6. Redeploy and verify

1. Trigger a Preview deploy (push to a non-production branch or redeploy an
   existing Preview).
2. `GET /api/health` on the Preview URL — expect JSON including:

   ```json
   "previewIsolation": {
     "vercelEnv": "preview",
     "required": true,
     "ok": true,
     "keyPrefixSet": true,
     "separateDbFlag": true
   }
   ```

   `ok: false` with Redis configured means the fail-closed gate is active —
   finish steps 2–3 and redeploy.
3. On Production `/api/health`, `previewIsolation.required` should be `false`
   and `keyPrefixSet` / `separateDbFlag` should be `false`.
4. Optional smoke (Preview only, after isolation is green): a single
   `GET /api/log?habit=Test` against Preview, then confirm Production
   `habits:log` did not gain a row (separate DB and/or `preview:` prefix).

---

## Code behavior (reference)

- `redisKey('habits:…')` prepends `REDIS_KEY_PREFIX` / `PREVIEW_REDIS_PREFIX`.
- Every Redis command goes through `redisCmd` / `cmd` in `lib/store.js`, which
  calls `assertPreviewStorageSafe()` first.
- `lib/habits.js` and `lib/dataset.js` use the same helpers (no private Redis
  client that could bypass the gate).
- Unit coverage: `tests/unit/store-prefix.test.mjs`.

---

## Cipher HOLD

This work is hardening only. Do not merge Web Analytics (#93) or other
product work that writes against Preview until this checklist is done and
#104 is closed.
