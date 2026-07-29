# The Stream Deck as an AI ⇄ Human Bridge

*A design study on using a grid of physical OLED keys as the interaction surface
between autonomous AI and the person supervising it — and the common visual
language those keys need in order to work.*

> **Where this sits.** Habit Tracker already ships a working instance of this idea:
> the coach takes over spare keys and asks its questions through them. This study
> zooms out from that one product to the general design problem — *if a deck is the
> bridge between an AI and a human, what is the shared visual language of the keys?*
> It builds directly on two documents already in this repo:
> [`design/PHILOSOPHY.md`](../PHILOSOPHY.md) (the *Nocturne Ritual* aesthetic) and
> [`docs/DECK-UX.md`](../../docs/DECK-UX.md) (the page/takeover decision record). It
> extends their vocabulary rather than replacing it; §2 is explicit about where it
> agrees and where it deliberately diverges.

---

## The theory

AI is moving from **chat** to **supervision**. When an agent runs work in the
background — a coding task, a research sweep, a coach reasoning about your habits —
the human's job stops being "author every prompt" and becomes "make the few
decisions the AI can't make alone." A text box is a poor instrument for that job: it
demands foreground focus, it's serial, and every approval is a modal interruption.

A Stream Deck-like device — a small grid of **glowing, labelled, physically
pressable keys** — is a surprisingly good one. Each key is an output (a live OLED
screen) and an input (a button) in the *same* physical unit. It sits in your
peripheral vision, ambient and glanceable. A press is a deliberate, embodied act.
And the small, fixed number of keys is a *feature*: it forces the AI to distill
everything down to the handful of things that genuinely need a human. (This repo's
coach already lives inside that constraint — "a coach asking for twelve things is
asking for nothing," as DECK-UX puts it.)

So the bet of this study is:

> **The Stream Deck turns the human into a bank of fast, physical I/O ports the AI
> can call — a decision surface for supervising agents, without pulling the person
> back into a chat window.**

The device isn't the hard part. This project already drives real key faces. **The
hard part is the language.** If every key looks different, the human has to *read*
the deck like a paragraph every time. If the keys share a common grammar, the human
*glances* and knows. This study defines that grammar.

## The core idea in one picture

A key is a **semantic tile**. From across a desk, in under a second, it must answer
four questions — and it answers them the same way on every key:

| Question | Channel that answers it |
|---|---|
| **Whose turn is it?** (AI working / waiting on me / idle) | the **frame** — color + motion |
| **What is this?** | the **glyph** (icon) + **label** |
| **What happens if I press?** | the glyph's verb + affordance |
| **How urgent?** | motion rate + brightness |

Learn those channels once, read any key forever. That is the whole design
language in miniature; the rest of this study makes it precise.

## How to read this study

Five short documents in this folder:

1. **[The thesis](01-thesis.md)** — why a grid of keys is the right shape for the
   AI⇄human bridge, and where it is the *wrong* one.
2. **[The OLED key design language](02-design-language.md)** — the core "how": key
   anatomy, the state color system, the motion vocabulary, typography, and the glyph
   grammar. Includes the reconciliation with *Nocturne Ritual*. This is the heart.
3. **[Interaction patterns](03-interaction-patterns.md)** — a component library of
   reusable AI⇄human exchanges built from the grammar (Approval Gate, Choice Picker,
   Attention Beacon, two-stage Confirm, dial actions, and more — the *Ask*-page
   takeover in DECK-UX is one of them).
4. **[Layout & protocol](04-layout-and-protocol.md)** — the grid grammar (spatial
   conventions, paging, anchor keys) and the turn-taking state machine that drives
   the keys and carries presses back to the AI.
5. **[Principles & open questions](05-principles-and-open-questions.md)** — the ten
   north-star principles, and the honest list of things this study does not yet know
   and proposes to test — with this project named as the prototype that can answer
   them.

## The companion artifact

The written language is only half of a study about a *visual* language. A live,
interactive companion **renders** the OLED keys — the states, the motion, the
patterns — so you can see and feel the grammar instead of imagining it. Treat it as
the "figures" for these documents:

**▶ [The OLED Key Language — interactive artifact](https://claude.ai/code/artifact/5108026f-5528-4749-a482-d16d1056cb0b)**

(Try the *Desaturate* toggle to confirm the states survive without color, press an
Approval Gate, and arm the two-stage delete. The dark, glow-on-black world is drawn
straight from *Nocturne Ritual*.)

## Status

This is a **design study**, not a product spec or an implementation. It is meant to
be argued with. Every document ends with the assumptions it's making so they can be
challenged, and document 5 collects the open questions worth a real prototype — many
of which this very repo is positioned to answer.
