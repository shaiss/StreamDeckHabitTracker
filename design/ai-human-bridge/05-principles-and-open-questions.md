# 5 · Principles & open questions

## 5.1 The ten principles

The north stars the rest of the study derives from. When two design choices conflict,
these break the tie.

1. **Glanceability over completeness.** A key must be read in under a second from
   across the desk. If a choice adds information at the cost of legibility, it loses.
2. **State before content.** *Whose turn it is* dominates the key. What the key is
   *about* is secondary to whether it's waiting on you.
3. **One signal, one meaning.** A color, a motion, a zone each mean exactly one thing,
   everywhere. Consistency is the entire value; clever exceptions are bugs.
4. **Calm by default, loud only when earned.** The deck is ambient, not a casino. At
   most one loud (fast-blinking) key at a time; everything else is still.
5. **Physical means committal.** Reserve presses for decisions that deserve a
   deliberate act, and make irreversible ones *feel* irreversible (arm-then-fire).
6. **Spatial consistency.** The same action lives in the same place, forever. Muscle
   memory is the deck's superpower; never spend it on packing efficiency.
7. **Constraint is a feature.** Few keys force the AI to surface only what truly needs
   a human. Don't fight the bound — it's what protects the human's attention.
8. **Legible when dark.** An off key is a valid, meaningful state. Silence and
   negative space are part of the language, not empty slots to fill.
9. **Reversible and forgiving.** `BACK` is always in its corner; defer is always an
   option; destructive actions are always two-stage. Supervision must feel safe.
10. **Progressive disclosure.** Depth via paging; breadth stays shallow. The deck is a
    small window onto a large space, never a wall of every possible action.

## 5.2 Open questions — what a prototype must answer

This is a study, so the honest deliverable is not just a design but a list of the
things the design *doesn't yet know*. Each is a hypothesis to test on real hardware
with real agent traces.

### Legibility & the physical limit
- **How much can a 72px key actually carry?** Frame + glyph + two-word label is the
  bet. At what distance and size does it break? Newer 120px keys change the answer.
- **Glyph learnability.** Is the verb set (2.5) recognizable without a legend after a
  day? A week? Which glyphs get confused?

### Attention economics
- **How loud is too loud?** The right pulse rate for "your move" that nags without
  annoying, and the true ceiling on concurrent alerts before the deck becomes noise.
- **Habituation.** Does an always-present amber pulse stop being noticed over weeks?
  Does the signal need to escalate if ignored, and how, without crying wolf?
- **Does ambient peripheral display beat on-screen notifications?** The core claim of
  document 1 — it needs an actual attention/latency measurement, not an assertion.

### Expressiveness vs. simplicity
- **Pattern coverage.** Do the nine patterns in document 3 cover real agent
  supervision, or does every domain sprout bespoke layouts (which would erode the
  learn-once payoff)? Validate against logged human-in-the-loop moments.
- **Six states, six colors, six motions — right-sized?** All three bounds are
  deliberately conservative. Which one runs out first under real load?

### Scale
- **Multi-agent ceiling.** The identity-dot scheme handles a handful of agents. What
  happens at 20? Does the Status Board need rollups, and does paging keep up when many
  things want attention at once?
- **Small decks.** On a 2×3 (6-key) deck, the fixed-zone layout spends a third of the
  deck on nav. Does the grammar degrade gracefully, or does it need a compact variant?

### The physical loop
- **Latency.** How fast is press → agent-response → visible result, and where's the
  threshold at which the physical loop stops feeling better than a click?
- **Acknowledgment under slow results.** The local `CONFIRMING` flash hides round-trip
  latency, but a *slow result* leaves a key mid-animation. What's the right fallback?

### Accessibility (must, not nice-to-have)
- **Colorblindness.** Redundant motion/glyph encoding (2.2) is designed in; verify it
  actually carries every state with color removed. The artifact's desaturate view is
  a first check, not a substitute for testing with affected users.
- **Motion sensitivity.** The reduced-motion fallback (brightness steps instead of
  movement) needs to preserve every distinction the motions carry.

### The boundary
- **When to leave the deck.** Document 1 argues the deck is the *fast path*, beside the
  screen and chat. Where exactly is the line — which decisions belong on keys, which
  must route to a screen, and how seamless is the handoff between them?

## 5.3 The prototype is already half-built

The cheapest experiment that would teach the most doesn't need new hardware or a new
codebase — **this repo is the vehicle.** Habit Tracker already drives live key faces,
already runs a reactive coach, already has an "Ask" takeover and a nudge/consent
model. The study's claims can be tested by layering the *language* onto what's here:

> Adopt the **frame-vs-interior split** (§2.2): keep each habit's Ritual hue on the
> glyph, and let the **frame** ring go amber-breathing only when the coach's "Ask" is
> pending on that key. Add a single **Attention Beacon** (3.3) — one key that's dark
> when the coach is quiet and amber when it wants you — as the front-page distillation
> of "the coach needs you." Render one coach question as a proper **Approval Gate /
> Choice Picker** with the shared glyph grammar. Then live with it for a week.

That small change exercises the frame states, the motion vocabulary, the press
acknowledgment, and the core claim that a glanceable physical decision surface beats a
repainted slot you might notice later — while reusing the store, the plugin poll loop,
and the takeover guardrails already in `docs/DECK-UX.md`. If the amber frame + Beacon
earns its place over a week, the rest of the language is worth building out. If it
doesn't, no amount of additional patterns would have saved it.

The broader claims (multi-agent scale, the coding-agent approval hook, dials) are the
*next* prototypes — but this one is a diff away from the code that already exists.

---

*End of the design study. Start with the [README](README.md), argue with the
[thesis](01-thesis.md), and see the language rendered live in the companion artifact.*
