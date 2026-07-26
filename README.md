# Stream Deck → Habit Tracker (with an AI coach)

Tap a physical Stream Deck key → a timestamped tap is logged in the cloud and
shows up on a live dashboard. No always-on PC needed — the endpoint runs on
Vercel, so it works even when your machine is asleep.

**Live app:** https://stream-deck-habit-tracker.vercel.app
**Virtual deck:** https://stream-deck-habit-tracker.vercel.app/deck.html — a browser
twin of the 15-key deck (same faces, live AI slot keys, real logging) for when
you're away from the hardware or don't own one. Add `?key=...` if `HABIT_KEY` is set.
**Log endpoint:** `https://stream-deck-habit-tracker.vercel.app/api/log?habit=NAME`

Each Stream Deck key sends a tiny web request to `/api/log`, which appends a row
to a Redis store. The dashboard at `/` reads it back and shows counts, a 7-day
chart, and recent taps.

**AI slot keys:** beyond the 5 fixed habits, spare keys are *AI slots*. An LLM
(z.ai GLM) looks at your actual tap history and decides what it wants you to
start logging — to fill gaps in the data or test a hypothesis about your day —
then assigns those habits to the slot keys. With the bundled **Habit Tracker AI**
Stream Deck plugin, the slot key faces repaint themselves when assignments
change. Slot taps resolve server-side at tap time, so history stays truthful
across swaps.

## Fastest setup (Windows, one line)

```powershell
irm https://stream-deck-habit-tracker.vercel.app/setup.ps1 | iex
```

That installs the Stream Deck app if needed (winget), then does a **clean
install**: any previous copy of the plugin (including the legacy
`com.kalmansforge` build) and any imported `Habit Tracker*` profiles are
removed first, the plugin is placed directly into the Stream Deck plugins
folder (no prompt), and the fresh profile import is the one prompt you confirm.
**Re-running the one-liner is the upgrade path** — it never stacks duplicate
profiles or leaves a stale plugin behind. No repo clone, no Node, nothing else
on your machine.

Hosted artifacts (also linked from the dashboard):

| File | What |
|---|---|
| [`setup.ps1`](https://stream-deck-habit-tracker.vercel.app/setup.ps1) | the bootstrap above |
| [`com.shaiss.habit-tracker.streamDeckPlugin`](https://stream-deck-habit-tracker.vercel.app/downloads/com.shaiss.habit-tracker.streamDeckPlugin) | the plugin (live habit keys + live AI slot keys) |
| [`HabitTracker-MK2.streamDeckProfile`](https://stream-deck-habit-tracker.vercel.app/downloads/HabitTracker-MK2.streamDeckProfile) | 15-key layout: 5 habit keys + Stats + 4 AI slots |

Single-user build: one deck (15-key), one plugin, no fallback flavors. Other
layouts can be regenerated any time with `tools/generate.mjs --model=…`.

---

## What's deployed for you

This repo **is** the app, and it's connected to Vercel — every push deploys it.
You don't write or run any code.

| Piece | Where | Status |
|-------|-------|--------|
| Log endpoint | [`api/log.js`](api/log.js) | ✅ deployed |
| Dashboard data API | [`api/data.js`](api/data.js) | ✅ deployed |
| Live dashboard | [`public/index.html`](public/index.html) | ✅ deployed |
| Storage layer (KV/Upstash) | [`lib/store.js`](lib/store.js) | ✅ deployed |
| Button generator | [`tools/generate.mjs`](tools/generate.mjs) | ✅ one command |
| Custom key icons | [`icons/`](icons/) + [`tools/make-icons.mjs`](tools/make-icons.mjs) | ✅ pre-rendered |
| Habit list you can edit | [`config/habits.json`](config/habits.json) | ✅ 5 defaults |

## The two things only you can do

Everything else is done. These two need *your* account and take ~3 minutes:

1. **Connect storage** (~1 min, one time). Writing to a datastore needs a
   credential only your Vercel account can issue — I can't create it for you.
   In Vercel → this project → **Storage** → create **Upstash for Redis** (or
   **KV**), free tier → **Connect** to `stream-deck-habit-tracker`. Vercel
   injects the credentials and redeploys automatically. That's it — the code
   already reads them.
2. **Install the Stream Deck plugin** (~20 sec). One click from the Marketplace.

Until step 1 is done, the dashboard shows a "connect storage" note and
`/api/log` replies `503 Storage not connected yet` — that's expected.

---

## Setup

### Step 1 — Connect storage (Vercel dashboard)
1. Open the [project](https://vercel.com/shaiss-projects/stream-deck-habit-tracker) → **Storage** tab.
2. **Create Database → Upstash for Redis** (or **KV**), free plan.
3. **Connect** it to this project. Vercel adds the env vars and redeploys.
4. Verify: open https://stream-deck-habit-tracker.vercel.app/api/log?habit=Test
   in a browser — you should see `Logged: Test`, and it appears on the
   [dashboard](https://stream-deck-habit-tracker.vercel.app).

### Step 2 — Install plugin + profile
Run the one-liner above (recommended — it cleans out any previous install
first), or double-click the two hosted files (plugin first, then profile;
note the manual path does *not* remove old copies, so upgrades and re-imports
can leave a stale plugin or duplicate profiles behind). Habit keys and AI slot
keys all render from live server state —
edits on the [Habits page](https://stream-deck-habit-tracker.vercel.app/habits.html)
repaint physical keys within ~15 s.

**Icons:** two sets, both committed:
- [`icons/animated/`](icons/animated/) — looping GIFs (24 frames, 1.92 s), embedded
  in the profile by default.
- [`icons/`](icons/) — still PNGs (576×576). Used with `--static`, or drag one
  onto a key manually.

Format choice, for the record: the Stream Deck app accepts SVG/PNG/JPEG stills
and GIF/WEBP animation. We use **PNG for stills** (our art is color-emoji glyphs,
which render inconsistently as SVG text and gain nothing from vectors on a
72–96 px key) and **GIF for animation** (the most widely supported animated
format on keys). If an imported profile ever shows only the first frame, drag
the `.gif` from `icons/animated/` onto the key — the app plays dragged GIFs.

To re-render after editing habits:
`npm i playwright-core pngjs gifenc --no-save`, then `node tools/make-icons.mjs`
(stills) and `node tools/make-animations.mjs` (GIFs).

### Step 3 — Plug in the Stream Deck and tap
Each tap logs instantly and shows on the
[dashboard](https://stream-deck-habit-tracker.vercel.app).

---

## Customizing your habits
Use the [Habits page](https://stream-deck-habit-tracker.vercel.app/habits.html)
— changes go live everywhere, including physical keys, within ~15 s.
(`config/habits.json` only seeds icons/profile generation.)

## Optional: require a secret
To stop anyone who guesses your URL from writing rows:
1. In Vercel → project → **Settings → Environment Variables**, add
   `HABIT_KEY` = a random word, then redeploy.
2. Re-run the generator with `--key=thatword`. Every URL now carries `&key=...`.

For a personal tracker it's fine to skip this.

## The AI coach (z.ai)

One env var enables it: in Vercel → project → **Settings → Environment
Variables** add `ZAI_API_KEY` (from [z.ai](https://z.ai)), then redeploy.
Optional: `ZAI_MODEL` (default `glm-5.2`, auto-falling back to the free
`glm-4.7-flash` if the preferred model rejects a call) and `ZAI_BASE_URL`.

**The coach is reactive, not periodic.** Every tap triggers a background pass
(45 s cooldown) where the model sees what you just tapped, today's taps, and
its current keys — and decides whether to repaint its slots *right now*. Tap
🍽 Eat and it may swap in 👍/👎 food-feedback keys; the plugin re-polls ~9 s
after each tap so the physical faces catch the change almost immediately. The
✨ Suggest button remains as the manual "re-think everything" trigger.

- **✨ Suggest** on the dashboard → `POST /api/suggest` → GLM sees the fixed
  habits plus a 14-day summary of your taps (counts, active days, top hours)
  and returns up to 4 habits *it* wants tracked, each with an emoji, short
  label, and its reason. They're stored as slots 1–4.
- Slot keys call `/api/log?slot=N`; the server resolves the slot to whatever
  habit is assigned *right now* and logs that name + emoji, so swaps never
  corrupt history.
- The Habit Tracker AI plugin polls `/api/slots` every 15 s and repaints slot
  key faces when assignments change. The poll clock runs in a Web Worker, not a
  page timer: the plugin page is a hidden browser page and Chromium throttles
  timers on those, which used to leave *physical* faces stale while the virtual
  deck stayed current. Taps also queue a short chain of rechecks so the coach's
  reactive swap shows up within seconds.
- Wondering whether the hardware is actually talking to the backend? The
  dashboard's AI Coach section shows **Physical deck: live / stale / never
  seen** with the plugin version and key count, and `GET /api/health` returns
  the same under `deck`.
- **Runs on Mastra**: the coach is a Mastra agent (`lib/agent.js`) with an
  `update_hypotheses` tool — it keeps persistent notes about what it's
  learning; a plain z.ai call is the automatic fallback.
- **Scheduled passes** (Vercel Cron, production only): a **morning pass**
  (10:00 UTC) sets the day's keys, and a **daily digest** (03:00 UTC) writes
  the coach's end-of-day note, shown on the dashboard. Trigger manually with
  `/api/cron/morning?run=1` / `/api/cron/daily?run=1`. Optionally set
  `CRON_SECRET` to lock the cron routes.
- **Settings & profile** (⚙️ on the dashboard): your name, timezone, and a
  free-text "about you" the coach reads on every pass. The profile timezone
  wins over the `HOME_TZ` env default (`America/New_York`).
- **The coach learns from behavior** (behavioral scorer): every slot
  assignment is kept in history, and each pass shows the coach its track
  record — which suggested keys you actually tapped vs ignored — so it drops
  asks that don't land. The dashboard shows the current hit rate.
- **Datasets & experiments**: every coach pass captures its exact context +
  output (rule-scored for quality) into a dataset. `GET
  /api/experiment?run=1&models=glm-5.2,glm-4.7-flash&n=3` replays those real
  contexts against each model and compares scores — run it (or the *Coach
  experiment* GitHub Action) before shipping prompt/model changes.
- Reactive feedback keys expire automatically (default 2 h; the model can set
  `ttlMinutes` 15–720 per key), so a "was that meal good?" key doesn't squat
  a slot all day.

## Endpoints
- `GET /api/log?habit=NAME[&note=...][&key=SECRET]` → logs a tap, returns text.
- `GET /api/log?slot=N` → logs whatever the AI assigned to slot N (1–4).
- `POST /api/suggest` → ask the AI to (re)fill the slots. 30 s cooldown.
- `GET /api/slots` → current slot assignments (read by plugin + dashboard).
- `GET /api/data` → JSON of all taps (feeds the dashboard).
- `GET /api/health` → storage/AI wiring status (env var names only).
- `GET /` → the dashboard.

---

## Troubleshooting
- **`503 Storage not connected yet`:** finish Step 1 (connect Upstash/KV).
- **Button does nothing:** open its URL in a browser. `Logged: …` = working;
  `Unauthorized` = URL missing `&key=…` while `HABIT_KEY` is set; `Missing
  habit` = the `?habit=` part got dropped.
- **Profile won't import:** Stream Deck's profile format varies by version — use
  the manual URLs in `dist/urls.txt` instead. Same result.
- **Wrong day boundaries:** the dashboard groups by *your browser's* local day,
  so days roll over at your local midnight automatically.

## Alternative: Google Sheets instead of Vercel
Prefer your data in a Google Sheet? [`apps-script/Code.gs`](apps-script/Code.gs)
is a drop-in Apps Script logger — paste it into **Extensions → Apps Script** on
your sheet, deploy as a Web app ("Execute as: Me", "Who has access: Anyone"),
and point the generator at the `/exec` URL instead. Trades the Vercel dashboard
for a spreadsheet you already know. See [`sheet/dashboard.md`](sheet/dashboard.md)
for sheet formulas.
