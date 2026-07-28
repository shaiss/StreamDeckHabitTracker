# 4 · Layout & protocol

Documents 2 and 3 defined single keys and small clusters. This document scales up:
how the whole **grid** is organized so muscle memory forms, and the **turn-taking
protocol** that drives the keys and carries presses back to the AI.

## 4.1 The grid grammar

A 5×3 deck (15 keys) is the reference; the conventions scale to 2×3, 4×8, etc. The
core idea mirrors a phone's UI chrome: **stable zones, so where a thing lives tells
you what kind of thing it is.**

```
┌─────┬─────┬─────┬─────┬─────┐
│  STATUS ROW — ambient, non-interactive / drill-in   │   top row
├─────┼─────┼─────┼─────┼─────┤
│  ACTION ZONE — the current decision(s) live here    │   middle rows
├─────┼─────┼─────┼─────┼─────┤
│ ‹BACK│     │     │     │MENU▤│   nav row (anchors fixed at the corners)
└─────┴─────┴─────┴─────┴─────┘
```

- **Status row (top):** ambient state — the Status Board (3.4), running agents,
  global health. Rarely a decision; a press drills in.
- **Action zone (middle):** where the AI stages the decision that needs you. Approval
  Gates, Choice Pickers, and Handoffs claim this region. It's the deck's "focus."
- **Nav row (bottom):** fixed anchors. **`BACK` bottom-left** and **`MENU` /
  `HOME` bottom-right**, *never* moving. These are the two keys your thumb can hit
  blind, which makes deep navigation safe.

### The focus convention

When a decision needs you, the AI stages it in the **same region every time** (the
center of the action zone) rather than wherever there's a free key. Consistent
placement means an Approval Gate is answerable by position — your thumb goes to
"approve" before your eyes finish reading. Predictable location is worth more than
optimal packing.

### Paging & progressive disclosure

Breadth stays shallow; depth comes from **pages**. A `⊕` drill-in key swaps the whole
grid to a sub-context (one agent's detail, a longer option list), always with `BACK`
in its fixed corner. This keeps any single screen readable while allowing arbitrary
depth — the deck is a small window onto a larger space, navigated like a phone, not a
wall of every possible action at once.

> **The consent boundary this repo already drew.** [`docs/DECK-UX.md`](../../docs/DECK-UX.md)
> settles the hardest version of AI-driven paging: *"The coach may raise its voice
> inside the room it is already in. It may not walk into another room"* — the agent may
> switch pages within its own profile but can never yank you out of an unrelated one,
> and even that is consent-gated (`off` / `nudge-only` / `may-navigate`) and
> auto-restores. This study adopts that rule wholesale: **the AI drives state and pages
> within its surface; it never seizes the human's context.** Paging is an invitation
> the deck extends, not a place it drags you.

### Off is part of the layout

Unused keys stay **dark** (OLED truly off). Negative space is a design element: a
mostly-dark deck with one amber key breathing is the clearest possible "one thing
needs you." Filling every key "because it's there" destroys that signal. Darkness is
how the deck says *nothing here* — and that's information.

## 4.2 The turn-taking protocol

Under the visuals, each key is a small state machine. The value of the whole system
is that **these states look identical on every key** (document 2's frame colors and
motions *are* the visual rendering of these states).

```
        ┌──────────────────────────── AI updates ────────────────────────────┐
        ▼                                                                      │
     ┌──────┐  AI starts work   ┌─────────┐  AI needs human   ┌──────────┐    │
     │ IDLE │ ────────────────► │ WORKING │ ────────────────► │   WAIT   │    │
     └──────┘                   └─────────┘                   └──────────┘    │
        ▲                            │                          │    │        │
        │                            │ fails                    │    │ press  │
        │                            ▼                          │    ▼        │
        │                       ┌─────────┐                     │ ┌──────────┐│
        │◄──── fade (timeout) ──│ BLOCKED │◄── press: retry ────┘ │CONFIRMING││
        │                       └─────────┘                       └──────────┘│
        │                                                              │       │
     ┌──────┐                                                          │ result│
     │ DONE │◄─────────────────────────────────────────────────────────┘◄─────┘
     └──────┘  (transient — settles, then fades to IDLE)
```

| State | Frame (from doc 2) | Who acts next |
|---|---|---|
| `IDLE` | dim / off | nobody — passive |
| `WORKING` | blue + sweep/shimmer | the AI; human waits |
| `WAIT` | **amber + breathing** | **the human** — this is the whole point |
| `CONFIRMING` | flash-to-white → settle | the system (your press registered) |
| `DONE` | green, transient | nobody — fades to `IDLE` |
| `BLOCKED` | red + fast blink | the human (or the AI retries) |

The critical transition is **`WORKING → WAIT`**: the AI *yields the turn*. That's the
moment the deck lights amber and the human is called. `WAIT → CONFIRMING` is the human
taking the turn back (the acknowledgment flash), and `CONFIRMING → …` is the system
showing what the press did. Turn-taking made physical and visible.

## 4.3 The bridge, concretely (how it's driven)

The study is about the *language*, not an implementation, but it should be buildable.
The data model per key is deliberately tiny:

```jsonc
{
  "id": "deploy-gate",
  "glyph": "check",          // verb → glyph (doc 2.5)
  "label": "APPROVE",        // ≤ 2 words
  "state": "wait",           // idle | working | wait | confirming | done | blocked
  "badge": null,             // number, or null
  "agent": "builder",        // → identity dot hue
  "danger": true,            // arms two-stage confirm (3.8)
  "action": "approve:deploy" // token returned to the AI on the committing press
}
```

`state` is what the *AI emits*. The two-stage `armed` window (below) is a **deck-local**
substate the bridge tracks for `danger` keys — it isn't an AI-emitted `state` value, so
the emitted enum stays `idle | working | wait | confirming | done | blocked`.

The loop:

1. **AI → deck.** The agent runtime emits key states; a small bridge daemon renders
   each key's frame/glyph/label/badge via the device SDK (e.g. `elgato`
   Stream Deck SDK, `python-elgato-streamdeck`, `node-elgato-stream-deck`), which
   exposes a per-key image buffer plus button-press events over USB HID.
2. **Human → deck.** What a press does depends on `danger`. The *committing* press
   triggers the local `CONFIRMING` flash immediately (no round-trip needed for the
   acknowledgment — the deck confirms *receipt* locally, then the AI's response drives
   the next state):
   - **`danger: false`** — the press is the committing press: it flashes and emits the
     key's `action` token straight away.
   - **`danger: true`** — the first press is an *arming* press, not a committing one.
     It must **not** emit anything and does **not** flash-acknowledge; instead it flips
     the key to a local **`armed`** state with a short expiry (~3s), rendering the
     two-stage Confirm face (3.8). Only a *second* press within the arm window is the
     committing press — it flashes and emits the `action` token. If the window lapses,
     the key silently disarms and nothing reaches the AI. This keeps an irreversible
     token (`approve:deploy`) from ever crossing the bridge on a single, possibly
     accidental, tap.
3. **deck → AI.** The `action` token flows back to the agent as the human's decision —
   after the arm-then-confirm gate above, for `danger` keys.

This maps cleanly onto mechanisms agents already have: **tool-use permission
prompts**, **human-in-the-loop checkpoints**, and the **elicitation** step where an
agent asks a bounded question. The deck is, precisely, a *physical renderer for
human-in-the-loop requests* — anywhere an agent today pops a "can I do this?" dialog,
that request can render as a key instead. That's the shortest path from this study to
a working prototype: point an existing agent's approval hook at the bridge daemon.

---

### Assumptions this document makes

- Fixed spatial zones and anchor keys pay off enough to justify "wasting" keys on
  consistency rather than packing them. True for daily use; test the tradeoff on
  smaller (2×3) decks where keys are scarce.
- Local acknowledgment (flash on press before the AI responds) feels better than
  waiting for a round-trip. Almost certainly true, but it means the deck must
  gracefully show if a press's *result* is slow (e.g. a lingering `CONFIRMING`).
- A per-key state model this small is expressive enough for the patterns in
  document 3. It covers all nine today; a tenth pattern might add one field.
