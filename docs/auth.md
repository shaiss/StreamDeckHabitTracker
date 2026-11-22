# Clerk authentication

HabitDeck requires a credential for any write, and scopes Redis data per
Clerk `userId` (owner maps to the legacy unprefixed `habits:*` keys).

## Credential contract (OR — one shared helper)

Every mutating route (and every user-scoped read that needs identity) goes
through `resolveAuth` / `withUser` / `optionalAuth` in `lib/auth.js`. **One**
of the following authorizes the request; with none, the handler fails closed
(**401**):

| # | Credential | Transport | Tenant scope |
|---|------------|-----------|--------------|
| 1 | Per-user plugin token `ht_…` | `x-habit-key` (Stream Deck), `?key=`, `Authorization: Bearer ht_…`, or JSON `body.key` | That token’s `userId` only |
| 2 | Deployment `HABIT_KEY` (when set) | Prefer `x-habit-key`; also `?key=` / `body.key` during transition | Owner (`HABIT_OWNER_USER_ID`) |
| 3 | Clerk session | `Authorization: Bearer <session JWT>` or `__session` cookie (reads + POST/DELETE; **not** cookie-only GET mutations) | That session’s `userId` only |

Invariants:

- A per-user credential (**1** / **3**) never reaches owner/unscoped data —
  handlers always `runAsUser` that id.
- A non-`ht_` `?key=` is **never** accepted as a Clerk credential (no cookie
  fallthrough). It may still match `HABIT_KEY` via path **2**.
- When `HABIT_KEY` is unset, path **2** does not grant (no fail-open). Paths
  **1** and **3** still work. Compatible with #116’s future fail-closed
  `keyOk` without importing that change.
- If Clerk env vars are missing, path **3** cannot succeed; `ht_` / `HABIT_KEY`
  still can.

Cron / owner-admin routes additionally use `resolveOwnerAuth` (CRON_SECRET
bearer or owner Clerk/`ht_`).

## Vercel env vars

| Name | Required | Notes |
|------|----------|-------|
| `CLERK_PUBLISHABLE_KEY` | yes | Browser + `authenticateRequest` |
| `CLERK_SECRET_KEY` | yes | Server verification |
| `CLERK_AUTHORIZED_PARTIES` | recommended | Comma-separated origins allowed as the session `azp` (e.g. `https://habitdeck.fyi,https://www.habitdeck.fyi,https://stream-deck-habit-tracker.vercel.app`). Trimmed; empty entries dropped. When unset/blank, falls back to `https://` origins from `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_URL`, plus `http://localhost:3000` / `http://127.0.0.1:3000` only outside production. Custom domains (habitdeck.fyi) are **not** in Vercel system vars — set this explicitly in production. |
| `HABIT_OWNER_USER_ID` | yes (for prod data + cron + HABIT_KEY path) | Clerk user id of the existing single-tenant owner |
| `HABIT_KEY` | optional | Deployment-wide owner write key (CI experiment, cron fallback). Prefer `x-habit-key`. |
| `HABIT_TOKEN_PEPPER` | yes (for plugin tokens) | Server-side pepper mixed into SHA-256 of `ht_` tokens before storage |
| `CRON_SECRET` | **required** for cron | Vercel cron `Authorization: Bearer …`. If unset, the bearer path is refused (fail closed). |

Fail closed: if Clerk keys are missing, mutating endpoints return **401** unless a valid `ht_…` plugin token or matching `HABIT_KEY` is presented. Session verification always passes `authorizedParties` into Clerk `authenticateRequest` so a token minted for another origin is rejected.

## Owner-only routes

These always act on the owner tenant (legacy `habits:*` keys). Callers must be
either `Authorization: Bearer $CRON_SECRET` or the owner’s Clerk session / `ht_` token
(`userId === HABIT_OWNER_USER_ID`). Non-owners get **403**; anonymous get **401**.
If `HABIT_OWNER_USER_ID` is unset, no Clerk user or token passes.

| Route | Why |
|-------|-----|
| `GET/POST /api/cron/morning` | Morning slot/roster/coach-page pass |
| `GET/POST /api/cron/daily` | Daily digest |

Per-user coaching routes (`/api/suggest`, `/api/mind`, `/api/coachpage`, …) scope
to the **caller’s** Redis prefix — a non-owner cannot read the owner’s legacy keys.
`HABIT_KEY` on those routes scopes to the owner tenant (path **2** above).

## Clerk Dashboard setup

1. Create an application (or use the existing one).
2. **API Keys** → copy Publishable + Secret into Vercel as above.
3. **Configure → Domains / Allowed origins** (or Paths):
   - `https://habitdeck.fyi`
   - `https://www.habitdeck.fyi`
   - `https://stream-deck-habit-tracker.vercel.app`
   - Preview: `https://*-shaiss-projects.vercel.app` (or the team’s preview pattern)
4. Enable the sign-in methods you want (email, Google, etc.).

## Order of operations (no baked cutover date)

1. Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `HABIT_OWNER_USER_ID`, and `HABIT_TOKEN_PEPPER` on the Vercel project. Keep `HABIT_KEY` if CI/cron still use it.
2. Deploy this change (merge / promote when the admiral chooses).
3. Owner signs in on the web → Settings → **Generate token** → paste into the Stream Deck plugin Property Inspector (`habitKey` / global settings). The plugin sends it as **`x-habit-key`** only (never in the URL).
4. Confirm `/api/health` shows `authReady: true`, `ownerMapped: true`, and the owner’s dashboard still shows pre-auth taps.

## Data scoping (product risk — owner data)

- **No destructive migration.** Legacy unprefixed Redis keys (`habits:log`, `habits:slots`, …) are never deleted, renamed, or copied.
- When `userId === HABIT_OWNER_USER_ID`, `redisKey('habits:log')` returns `habits:log` (read/write in place). That mapping is pure and idempotent.
- Every other user gets `u:{userId}:habits:…` only.
- **No anonymous→user merge.** Anonymous visitors cannot write; there is no path that copies anonymous data into a signed-in account.

## Plugin auth

The plugin stores the minted `ht_…` value in on-device global settings and sends
it as the **`x-habit-key` header** on every request (Cipher M1/M2 — never in the
URL). Server-side, `extractApiKey` accepts an `ht_`-shaped `x-habit-key` as a
per-user token; a non-`ht_` value on that header is evaluated only as
`HABIT_KEY` (owner path). Tokens are stored as peppered SHA-256 only
(`HABIT_TOKEN_PEPPER`); plaintext is shown once at creation. Preview deployments
prefix token Redis keys with `REDIS_KEY_PREFIX` like every other store path.

## GET mutations (cookie-blind)

A Clerk `__session` cookie **alone** never authorizes a state change on `GET`/`HEAD`. Third-party pages can trigger cookie-bearing GET (top-level links; SameSite=Lax). Mutations on GET need one of:

1. An `ht_…` plugin token (`x-habit-key`, `?key=`, `Authorization: Bearer ht_…`, or JSON `body.key`) — what the Stream Deck plugin sends
2. A matching `HABIT_KEY` (same transports)
3. An explicit `Authorization: Bearer <Clerk session JWT>` header — what `public/auth.js` `authFetch` sends on every dashboard/deck request

Cookie-only sessions remain valid for **reads** (`optionalAuth`) and for **POST/DELETE** (those methods do not send cookies on cross-site form GET, and browsers will not attach `Authorization`).

`defaultVerifySession` does not swallow Clerk/network failures: a missing or invalid session is **401**; an infrastructure error is **5xx**.
