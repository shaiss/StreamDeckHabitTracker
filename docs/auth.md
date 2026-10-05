# Clerk authentication

HabitDeck requires a signed-in Clerk user (or a per-user Stream Deck API token)
for any write, and scopes Redis data per Clerk `userId`.

## Vercel env vars

| Name | Required | Notes |
|------|----------|-------|
| `CLERK_PUBLISHABLE_KEY` | yes | Browser + `authenticateRequest` |
| `CLERK_SECRET_KEY` | yes | Server verification |
| `HABIT_OWNER_USER_ID` | yes (for prod data + cron) | Clerk user id of the existing single-tenant owner |
| `CRON_SECRET` | recommended | Vercel cron `Authorization: Bearer …` |

Fail closed: if Clerk keys are missing, mutating endpoints return **401** (unless a valid `ht_…` plugin token is presented).

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

1. Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `HABIT_OWNER_USER_ID` (the owner’s Clerk `user_…` id) on the Vercel project.
2. Deploy this change (merge / promote when the admiral chooses).
3. Owner signs in on the web → Settings → **Generate token** → paste into the Stream Deck plugin `settings.key` (or regenerate the profile with `--key=…`).
4. Confirm `/api/health` shows `authReady: true`, `ownerMapped: true`, and the owner’s dashboard still shows pre-auth taps.

## Data scoping (product risk — owner data)

- **No destructive migration.** Legacy unprefixed Redis keys (`habits:log`, `habits:slots`, …) are never deleted, renamed, or copied.
- When `userId === HABIT_OWNER_USER_ID`, `redisKey('habits:log')` returns `habits:log` (read/write in place). That mapping is pure and idempotent.
- Every other user gets `u:{userId}:habits:…` only.
- **No anonymous→user merge.** Anonymous visitors cannot write; there is no path that copies anonymous data into a signed-in account.

## Plugin auth

The plugin already sends `settings.key` as `?key=`. That value is now a **per-user** token (`ht_…`) minted on the dashboard, stored as SHA-256 server-side, and bound to the Clerk user. The old deployment-wide `HABIT_KEY` is no longer accepted as a write credential.
