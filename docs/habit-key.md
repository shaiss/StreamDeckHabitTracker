# HABIT_KEY: setting the write key on every caller

`HABIT_KEY` is the shared secret that gates every write (`/api/log`, habits,
roster, profile, suggest, nudge, question, the deck heartbeat, forced coach
runs). **This repo is public, so the key never goes in git or in any built
artifact**: not the web pages, not the committed `.streamDeckProfile`, not
`manifest.json`, and not the `.streamDeckPlugin` zip. A CI test
(`tests/unit/no-committed-keys.test.mjs`) fails the build if anything key-like
is committed, and `tools/build-plugin.mjs` refuses to package one.

Callers send the key in the **`x-habit-key` request header**. The server still
accepts `?key=` (and `body.key` where it always did) during the #112
transition, so older plugin builds and bookmarks keep working until #112
removes it.

## Where the key lives

| Caller | Where you enter it | Where it is stored |
|---|---|---|
| Web UIs (`/deck.html`, `/habits.html`, `/`) | An in-page prompt, shown the first time a write gets `401` | `sessionStorage` for this tab (in memory if storage is blocked). **Never** `localStorage`, **never** the URL. |
| Stream Deck plugin | The Property Inspector of any Habit Tracker key | Stream Deck's **global settings** for the plugin, on this computer only |
| Vercel | Project → Settings → Environment Variables | `HABIT_KEY`, **Production only** |

**Do not share or bookmark links that carry the key in the URL.** A URL key
leaks through browser history, the `Referer` header, and request logs on its
first load. Use the in-page prompt instead. As a safety net only, if such a
link is ever opened, the page moves the key into `sessionStorage` and strips it
from the address bar with `history.replaceState`.

## Plugin install + key (Shai)

1. Install the plugin: double-click
   `com.shaiss.habit-tracker.streamDeckPlugin` (from `/downloads/`). The
   bundled profile installs with it and carries **no key**.
2. In the Stream Deck app, click any Habit Tracker key (Habit, AI Slot, or
   Coach). The Property Inspector shows **HabitDeck key (HABIT_KEY)**.
3. Paste the key and press **Save**. It is shared by every key of the plugin
   and takes effect on the next poll — no restart, no re-import.
4. To rotate: paste the new key and **Save**. To remove: **Clear**.

The inspector never displays the stored key; it only says whether one is set.

## Optional: a keyed profile (local only)

You should not need this — the Property Inspector covers every key. If you do
need a profile with the key baked into each key's settings (for example, a
machine where you cannot open the inspector), generate it **locally** and
never commit it:

```bash
node tools/generate.mjs <prod>/api/log --plugin --key=<SECRET>
```

Replace `<prod>` with the deployment origin and `<SECRET>` with the key. The
output goes to the git-ignored `dist/`. The generator refuses to write a keyed
profile anywhere else inside the checkout (such as
`streamdeck-plugin/…/profiles/` or `public/downloads/`). Import
`dist/Habit Tracker.streamDeckProfile` by double-clicking it, then delete it.
The plugin still sends a profile key as the `x-habit-key` header; a key saved
in the Property Inspector takes precedence.

## Rollout order

1. Merge this change (callers send the header; the server accepts it).
2. Set `HABIT_KEY` in Vercel for **Production only**, redeploy, and enter the
   key in the plugin's Property Inspector and once per browser tab.
3. Merge #112 last (fail closed when `HABIT_KEY` is missing, timing-safe
   compare, drop `?key=`), and only after a prod probe shows an **unkeyed**
   `/api/log` returns `401`.
