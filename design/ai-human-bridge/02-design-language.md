# 2 · The OLED key design language

This is the core of the study: the visual grammar that makes a *common* key
language possible. The goal is a system where the human learns a small set of
signals once and can then read any key, from any AI, at a glance.

The organizing principle:

> **One signal, one meaning, everywhere.** A color means exactly one thing. A motion
> means exactly one thing. A zone of the key holds exactly one kind of information.
> Consistency is the entire value; a "clever" exception destroys glanceability.

## 2.1 Key anatomy — the five zones

Every key divides its ~72–120px face into the same five zones. A given key uses
only the zones it needs, but a zone *always means the same thing*.

```
 ┌─────────────────────────┐   ← FRAME  (state channel: whose turn + urgency)
 │ •                    ³  │      · STATUS DOT (top-left)  — secondary/agent identity
 │                         │      · BADGE     (top-right)  — count / index / hotkey
 │           ◆             │
 │         GLYPH           │   ← GLYPH (center) — identity + the verb of the action
 │                         │
 │        APPROVE          │   ← LABEL (bottom) — 1–2 words, high contrast
 └─────────────────────────┘
```

| Zone | Position | Carries | Rule |
|---|---|---|---|
| **Frame** | outer 6–10px ring | turn-state & urgency (color + motion) | the loudest channel; readable from across the room |
| **Glyph** | center | the action's verb — and, at rest, the object's own hue (its identity) | from a fixed icon set; one glyph = one verb |
| **Label** | bottom strip | human-readable name | ≤ 2 words, uppercase mono, never wraps past 2 lines |
| **Badge** | top-right | count, option index, or hotkey number | numbers live here, never inline in the label |
| **Status dot** | top-left | secondary state, or *which agent* owns this | carries the **agent**-identity hue (multi-agent only); the object's own identity lives on the glyph, not here |

Why a separate frame for state: it keeps the **state channel** (color/motion) from
fighting the **content channel** (glyph/label). You can recolor the frame to amber
"waiting" without touching the glyph that says *what* is waiting. The two never
collide because they never share pixels.

## 2.2 The state color system

Color is reserved almost entirely for **turn-state** — the single most important
thing a supervisor needs to know. The palette is small, fixed, and each hue has
exactly one job.

| Token | Hex | Meaning | Where |
|---|---|---|---|
| `state.idle` | `#3A3F47` | nothing pending; passive affordance | dim frame, or key off |
| `state.working` | `#2EA3FF` | the AI is busy on this; you needn't act | frame, calm motion |
| `state.wait` | `#FFB000` | **your move** — the AI has yielded and needs a press | frame, breathing pulse |
| `state.success` | `#22C55E` | resolved / done (transient) | frame, brief |
| `state.blocked` | `#FF4D4D` | failed or hard-stopped; needs attention | frame, urgent |
| `action.danger` | `#FF4D4D` outline | this *press* is destructive/irreversible | glyph + label tint, not frame |

Two deliberate choices:

- **Amber is the signature color of the whole system.** `state.wait` — "your move" —
  is the one signal the human is trained to react to. It's the emotional center of
  the deck: a dark deck with one amber key breathing is the canonical "you're
  needed" picture. Reserve amber for *exactly* this and nothing else.
- **`blocked` and `danger` share a red but not a channel.** `blocked` is a *state* of
  a key (something broke) and lives in the frame. `danger` is a property of an
  *action* (pressing this deletes things) and lives on the glyph/label. Same hue,
  different zone, so they never read as the same thing.

**Two identity axes, two zones — don't conflate them.** "Identity" means two different
things here, and each has exactly one home:

- **Object identity** — *which* ritual object this key is (this habit, this task). This
  is *Nocturne Ritual*'s "one hue, derived from its name, kept for life," and it lives
  on the **glyph and its halo** (the reconciliation below makes this explicit).
- **Agent identity** — in *multi-agent* supervision, *which* AI owns this key. It gets
  its own hue set (violet / teal / pink / lime …) and lives **only in the status dot**.

Neither ever touches the frame — that's the firewall. **State owns the frame, object
identity owns the glyph, agent identity owns the dot.** Three zones, three jobs, no
collision.

### Color is never the only signal

Roughly 1 in 12 people has a color-vision deficiency, so every color-coded state is
**redundantly encoded**:

- `wait` = amber **+ breathing pulse + brighter**.
- `working` = blue **+ sweep/shimmer motion**.
- `blocked` = red **+ fast blink + a `!` glyph treatment**.
- `success` = green **+ a check + settle-and-fade**.

Motion and glyph carry the state even with the color removed. (The companion
artifact includes a "desaturate" view to check this.)

### Reconciling with *Nocturne Ritual*

This is the study's sharpest disagreement with the aesthetic already in this repo, and
it's worth naming head-on. [`design/PHILOSOPHY.md`](../PHILOSOPHY.md) states:
*"Color belongs to identity, never to decoration. Each ritual object carries one hue,
derived from its name and kept for life — hue is memory."* This study instead spends
color on **state**. Both cannot own the frame.

The tension is real, and the resolution is a **division of the key's real estate**,
not a winner:

- **State owns the frame; object identity owns the interior.** *Nocturne Ritual*'s "one
  hue, kept for life" moves inward — it colors the **glyph and its halo** (the object's
  identity, its memory) — while the **frame ring** is reserved for turn-state. A habit
  key at rest is exactly the Ritual key you already ship: its own hue, glowing. Only
  when the AI needs a decision *about* it does the frame light amber. Identity is what
  the key *is*; state is what the key *wants* — different zones, no collision.
- **Violet stays sacred.** The philosophy reserves violet for "*the coach is
  speaking*." This study honors that completely by putting agent identity in the
  **status dot** — so the coach's violet lives in the dot, and never competes with the
  amber "your move" frame. One says *who*, the other says *whose turn*.
- **The Ritual palette is the ground; the state palette is the signal.** Everything
  calm and identity-colored is the resting deck. The six state colors only appear when
  the turn-taking protocol (document 4) fires — brief, purposeful, then gone. The desk
  spends most of its life looking like *Nocturne Ritual*; the state system is what it
  does in the moments a human is actually needed.

So the study doesn't overturn the aesthetic — it says *where the existing hue rule
applies (identity, in the interior) and where a supervision bridge needs a second,
louder channel (state, in the frame)*, and keeps them in separate pixels so both hold.

## 2.3 The motion vocabulary

These are screens, not static keycaps, so **motion is a first-class token** — often
more glanceable than color. The vocabulary is intentionally tiny, and each motion
maps to one meaning. The governing rule:

> **Calm by default; loud only when earned.** The desk must never feel like a slot
> machine. At most **one** "loud" (fast) key at a time; everything else is still.

| Motion | Meaning | Feel |
|---|---|---|
| **Solid / still** | a settled state (idle, done) | the default; silence is information |
| **Breathing pulse** (~0.5 Hz) | `wait` — your move | gentle, persistent, ignorable-but-nagging |
| **Sweep / progress fill** | `working`, known progress | a bar or arc filling |
| **Indeterminate shimmer** | `working`, unknown duration | a slow travelling highlight |
| **Fast blink** (~2 Hz) | `blocked` / urgent / time-boxed | the only "loud" motion; rationed hard |
| **Flash-to-white → settle** | **press acknowledged** | the tactile confirmation of *your* input |

The press-acknowledgment flash matters more than it looks: it closes the loop.
Physical buttons on plain keycaps give you a *click* but no *confirmation that the
system heard you*. The flash is the deck saying "got it" — and then the frame
changes state to show what your press did.

Motion also respects the human: it should honor a global "reduced motion" preference
by falling back to brightness steps (dim ↔ bright) instead of movement, and it
should rate-limit so a burst of updates can't strobe.

## 2.4 Typography

A key is 72–120px and read from 2–3 feet away. Type is ruthless:

- **One word if possible, two at most.** `APPROVE`, `RUN TESTS`, `HANDOFF`.
- **Uppercase monospace for labels.** Mono is the authentic voice of a control
  surface, and its even width makes tiny text legible and predictable. Uppercase
  buys legibility at small sizes.
- **Numbers are badges, not words.** "3 pending" becomes a `3` badge on an alert
  glyph. Digits never fight the label for the same row.
- **Minimum legible size, then truncate.** Better to ellipsize a long name than to
  shrink below readability. If it can't be said in two words, it belongs on screen,
  not on the key.
- **Contrast is non-negotiable.** Label text sits at the top of the contrast range
  against the key's fill in every state.

A second, quieter type role — a clean sans — carries any *prose* in companion UIs
(setup screens, the on-screen detail the deck routes to). The mono/ sans split is
the type system: **mono is the device's voice, sans is the app's voice.**

## 2.5 The glyph grammar

Glyphs map to **verbs**, and a verb always gets the same glyph and (where it implies
state) the same color — everywhere, across every agent. This shared verb set is what
makes the language *common* rather than per-app.

| Verb | Glyph | Notes |
|---|---|---|
| Approve / confirm | check `✓` | always paired with `success` green when it's the affirmative |
| Reject / deny | cross `✕` | neutral by default; not red unless it's also destructive |
| Defer / snooze | arrow-right / `→` | "not now" — pushes the decision back to the AI to re-raise |
| Details / expand | ellipsis `…` | routes to the full context (on screen or a drill-in page) |
| Drill in / more | plus-in-square `⊕` | opens a sub-page of keys (progressive disclosure) |
| Back | chevron-left `‹` | the universal return; always the same anchor key |
| Run / start | play `▶` | begin a task |
| Stop / interrupt | square `■` | human-initiated halt; pairs with the Nudge pattern |
| Options / menu | rows `▤` | a list-style choice |
| Toggle / mode | switch | sticky state; shows on/off in the glyph itself |
| Danger | glyph tinted `danger` red | property of the action, layered onto any verb |

Design rules for the set:

- **Verbs, not nouns.** Glyphs name *what pressing does*, so the affordance is legible
  before the label is even read.
- **Filled vs. outline encodes active vs. available.** An outline play means "you can
  run"; a filled/animated play means "running."
- **Keep the set small and teachable.** Expressiveness is the enemy of glanceability;
  a dozen well-known verbs beat fifty precise ones.

---

## The language on one card

- **Frame** = state (color) + urgency (motion). Amber-breathing = *your move*.
- **Glyph** = the verb of the action. Same verb, same glyph, always.
- **Label** = ≤2 words, uppercase mono.
- **Badge** (top-right) = the number. **Dot** (top-left) = which agent.
- **One meaning per signal. Calm by default. Off is a valid, meaningful state.**

Everything in [document 3](03-interaction-patterns.md) is built by composing
these tokens; nothing new is invented, only arranged.

---

### Assumptions this document makes

- A 72–120px key can reliably carry frame + glyph + a two-word label at desk
  distance. This is the single most important thing to test on real hardware
  (document 5).
- Six state colors and six motions are *enough* expressiveness and *few* enough to
  learn. Either bound could be wrong; both are deliberately conservative.
- Users will invest the small up-front learning to get muscle-memory payoff. True for
  daily supervision; false for occasional use.
