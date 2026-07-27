# Deck UX: 15 keys, profile pages, and AI-driven navigation

Result of the #42 spike (2026-07-27). This is the design the follow-up issues
implement; it is a decision record, not a tutorial. Everything marked
**verified** was checked against the SDK source, the Elgato MCP bridge, or the
owner's real `ProfilesV3` on disk — not inferred from docs.

Context that shapes every decision below: the slot keys are the AI's only
interface to its human. Page design here is prompt/UX design, not layout.

---

## The one rule

**A page earns its existence when its keys share a *tap-latency class*.** Not a
topic — a latency class.

- **Habit keys are reflexive.** You pee, you tap. Any navigation cost between
  the act and the key means the log doesn't happen. Habits can never live
  behind a page flip.
- **Coach keys are considered.** You look, you read the label, you decide. A
  page flip is acceptable here and arguably *good*: it makes visiting the coach
  a deliberate act.
- **Insight is read, not tapped.** It doesn't want keys at all; it wants the
  dashboard.

Three pages fall out of that, and the rule also explains why the third is
nearly empty.

### Page 0 — "Now" (landing; the only page that must never move)

Habit keys fill row-major from the top-left · 2 AI slot keys · Stats · nav ·
Coach key. At the roster cap that is `10 + 2 + 1 + 1 + 1` = **15 exactly**.

### Page 1 — "Coach"

The AI owns the whole page: up to 12 slot keys plus prev/next.

### Page 2 — "Ask"

The takeover surface, and **deliberately almost empty**: one question, two to
four answer keys, one dismiss. A takeover has to be unmistakable, and the way
to make it unmistakable is that it looks nothing like the other two pages. Its
emptiness *is* the signal.

### Rejected: contextual pages

Morning / evening / deep-work pages were considered and rejected. The coach
already scopes keys in time via `ttlMinutes` on a slot def (15–720 min,
`lib/coach-shape.js`). Per-context pages would multiply the state the coach
reasons about while the human still has exactly one pair of eyes on one page.
**Time-scoping belongs on the key, not on the page.**

---

## AI-driven navigation

> **The coach may raise its voice inside the room it is already in. It may not
> walk into another room.**

The coach may switch **pages within our profile**, and may never switch **to**
our profile. If you are on your OBS profile mid-stream, the deck does not get
yanked out from under you; the escalation degrades to today's slot repaint,
which you see next time you look.

**Verified:** this is only buildable once the profile ships *inside* the
plugin. `@elgato/streamdeck@2.1.0` `dist/plugin/profiles.d.ts`:
`switchToProfile(deviceId, profile?, page?)` — *"Plugins may only switch to
profiles distributed with the plugin, as defined within the manifest, and
cannot access user-defined profiles."* Ours is user-imported today. That makes
bundling (#50) a hard prerequisite, not a nicety.

`page` is a **positional index** into `Pages.Pages`, so it drifts if the user
reorders pages. `Readonly: true` on the bundled profile prevents that.

### Enforcement point

The plugin already receives the signal and doesn't use it: `onWillAppear` /
`onWillDisappear` fire as pages change, and `plugin.mjs` maintains its `keys`
map from exactly those events. Tag each key's settings with `{page: N}` and the
plugin can derive which page is visible — and whether *any* of our keys are
visible at all. No new API needed (#53).

### Guardrails

A takeover is strictly louder than a nudge, so it must pass the existing
`nudgeDue()` gate **plus** all of:

1. **Budget ≤1/day** (`takeoverAt` / `takeoverDay` in `habits:nudge`)
2. **Our profile must be visible**
3. **Human-priority lock** — nothing within N minutes of a keypress or a manual
   page change
4. **Auto-restore** to page 0 after ~90s or on any tap. Never strand someone on
   a page they did not choose.
5. **Consent, default off** — tri-state in `habits:profile` (`off` /
   `nudge-only` / `may-navigate`) so it rides `getProfile()` into every pass
6. **A kill switch on the hardware** — a dismiss key setting 24h suppression.
   Saying "not now" must not require opening a web page; the deck is in your
   hand, the browser is not.

---

## Slot budget: stays at 4

`habits:slots` keeps its `[def|null x4]` shape as the **front-page** keys. A
separate `habits:coach:page` array (N ≤ 12) backs the Coach page (#52).

Migration cost is the small reason — length-4 reaches into `store.js`,
`sanitize()`, `commitSlots()`, `pickNudgeSlot()`, `api/log.js`, and ~200
length-4 records in `habits:slots:hist` that `lib/scorer.js` and
`lib/quality.js` read.

The real reason is design: **4 is a UX number, not a storage number.** The
front page answers "what does the coach want *right now*", and a coach asking
for twelve things is asking for nothing.

Taps stay in one integer namespace: `/api/log?slot=N`, where `1..4` resolves
the front page and `5..16` resolves coach-page index `N-5`.

---

## Roster cap: stays at 10, and now has a derivation

`MAX_ROSTER = 10` was picked arbitrarily. Page 0's budget is
`15 − 1 nav − 1 Coach key − 1 Stats − 2 front slots` = **10**. The cap turns out
to be exactly the single-page habit budget.

Raising it would push habit keys onto page 2 — and habits are the
reflex-latency class that must never require navigation. That derivation
belongs in a comment next to the constant so nobody bumps it casually.

---

## `ai_ready`: not something we can opt into

**Verified, and this corrects the premise of #42's question 5.** `ai_ready` is
not a manifest flag. It is per-action-type *runtime* state meaning "the plugin
answered `get_context` with a settings schema".

Probed read-only against the running app via the official bridge
(`npx @elgato/mcp-server`):

- `list_actions` returned **57 actions, zero with `ai_ready: true`** — including
  all ~45 of Elgato's own
- `get_context` against `com.shaiss.habit-tracker.habit` timed out
  (`Request processing was canceled`) — nothing answers, because nothing can
- `@elgato/streamdeck@2.1.0` `dist/` contains no `ai_ready` / `getContext` /
  `invokePluginMethod` / `settingsSchema` symbol; manifest schema `0.4.15` has
  no AI field at any level

**A public-SDK plugin cannot become `ai_ready` today.** The deliverable is
closed as not-actionable.

### The zero-code path instead

Elgato's documented consent model is the **"MCP Actions" profile**: enabling
MCP Deck creates it, and any action the human drags there becomes available to
connected AI tools. Consent, the description, and revocation all live in
Elgato's own UI. We ship a paragraph of docs, not code.

⚠️ **It has a prerequisite bug.** Hand-placed keys carry `Settings: {}`, render
the ⚙️ setup face, and `showAlert()` on tap — so a key dragged onto the MCP
Actions profile today would be inert. That is #55, and it is a standalone bug
regardless.

### If Elgato ships method registration

- `invoke_plugin_method` is addressed by **action UUID with no user gesture
  anywhere in the path** — any local process that can reach
  `\\.\pipe\elgato-mcp-streamdeck` can call it. Read-only methods only
  (`get_deck_state`, `get_slots`).
- Anything that **writes** (`log_habit`, `repaint_slot`) stays on the
  placement-gated `execute_action` channel, where a human drag is the gate. Our
  keys write real health data; "local-only" is not the same as "consented".
- `switch_page` should **never** be exposed to third-party AI. It is the
  takeover primitive, and every guardrail above lives in our coach server-side,
  not in the plugin. Handing it to an arbitrary local client hands out the
  takeover with none of the gate.
- The bridge supports **elicitation** end-to-end (app → bridge → MCP client
  prompt), so per-call human confirmation is available if we ever do expose a
  write.

---

## Navigation affordances

Use the built-ins — zero plugin code, and they match the muscle memory already
in the owner's Default Profile:

- **bottom-right `4,2`** = `page.next` on every page
- **bottom-left `0,2`** = `page.previous` on pages 1–2

The MK.2 has no touch strip, so a nav key is the only on-hardware way to change
pages. These are not optional.

**Verified on-disk shape** (read from a real `ProfilesV3` profile, not guessed):

```json
{
  "ActionID": "<uuid>",
  "LinkedTitle": true,
  "Name": "Next Page",
  "Plugin": { "Name": "Pages", "UUID": "com.elgato.streamdeck.page", "Version": "1.0" },
  "Resources": null,
  "Settings": {},
  "State": 0,
  "States": [{}],
  "UUID": "com.elgato.streamdeck.page.next"
}
```

Note `States: [{}]` — a single **empty** state object. The app supplies the
chevron art itself; this is not the `liveStates()` shape our own keys use.

Child folders (`profile.openchild`) are a third structure: they use
`Settings: {ProfileUUID: "<lowercase-uuid>"}` and their page folders exist on
disk but are deliberately **not** listed in `Pages.Pages`.

### The two unused keys

One becomes a nav key. The other becomes the **Coach key** (#53), and that is
the one worth caring about: a third plugin action with a live face showing the
coach's attention state, which jumps to page 1 on tap. Today the coach only
exists when it takes a slot key hostage. This gives it a place to simply *be*.

---

## Try it before committing

`tools/spike-multipage.mjs` builds a real 3-page profile implementing the
taxonomy above. It is a **throwaway** — deliberately standalone rather than a
fork of `generate.mjs`, so the production generator stays honest about
emitting one page.

```bash
node tools/spike-multipage.mjs
# -> dist/HabitTracker-3page-SPIKE.streamDeckProfile
```

Import it and flip with the bottom-corner keys. Nothing in the plugin knows
pages exist — navigation is entirely built-in actions.

Two things worth checking on the glass, because they are the parts a document
cannot settle: whether page 0 at the full 10-habit roster actually feels
navigable, and whether `page.next` wraps from the last page back to the first
(unverified — it decides whether the final page needs a `page.goto`).

---

## Follow-up issues

| | Issue | Size | |
|---|---|---|---|
| **A** | [#50 Bundle the profile with the plugin](https://github.com/shaiss/StreamDeckHabitTracker/issues/50) | M | Unblocks everything; also kills the last `setup.ps1` prompt |
| **B** | [#51 Multi-page `generate.mjs`](https://github.com/shaiss/StreamDeckHabitTracker/issues/51) | S | Format verified; spike script is the reference |
| **C** | [#52 Coach page + wider slot array](https://github.com/shaiss/StreamDeckHabitTracker/issues/52) | M | `habits:coach:page`, `?slot=5..16` |
| **D** | [#53 Coach key + page-visibility inference](https://github.com/shaiss/StreamDeckHabitTracker/issues/53) | S/M | Enabler for E |
| **E** | [#54 Coach-driven navigation + guardrails](https://github.com/shaiss/StreamDeckHabitTracker/issues/54) | M/L | The takeover, fully gated |
| **G** | [#55 Hand-placed keys are inert](https://github.com/shaiss/StreamDeckHabitTracker/issues/55) | S | Standalone bug; prerequisite for the MCP path |
| **H** | [#56 Roster outgrew the profile](https://github.com/shaiss/StreamDeckHabitTracker/issues/56) | S | Found during #5; two habits have no key |
| **F** | ~~`ai_ready` opt-in~~ | — | Closed as not-actionable (see above) |

**Order:** A → B → (C ∥ D) → E. G and H any time; both are independent and
small.
