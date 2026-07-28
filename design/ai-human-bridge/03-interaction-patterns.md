# 3 · Interaction patterns

A pattern library of reusable AI⇄human exchanges. Each is built entirely from the
tokens in [document 2](02-design-language.md) — no new visual primitives, only
arrangements. Think of these as the "components" of the design language: named,
consistent, learn-once shapes for the recurring moments of supervision.

Each pattern below lists: **when the AI uses it**, its **key layout**, and the
**design rationale**.

> **Already in this repo.** [`docs/DECK-UX.md`](../../docs/DECK-UX.md) designs the
> coach's **"Ask" page** — "one question, two to four answer keys, one dismiss" — as a
> deliberate full-page takeover whose *emptiness is the signal*. In this study's terms
> that page is a **Choice Picker** (3.2) or **Handoff** (3.9) rendered at page scale,
> and its guardrails (budget ≤1/day, human-priority lock, auto-restore, a hardware
> kill switch) are exactly the "calm by default, reversible and forgiving" principles
> made concrete. Where a pattern below maps onto something DECK-UX already specifies,
> it's noted — the study generalizes those decisions, it doesn't relitigate them.

---

## 3.1 Approval Gate — the workhorse

**When:** the agent wants to do something with consequences — run a command, send a
message, push a commit, spend money, call a tool. The single most common exchange in
supervision.

```
┌────────┐ ┌────────┐ ┌────────┐
│  ✓     │ │  …     │ │  ✕     │     Frame: amber-breathing (your move)
│APPROVE │ │DETAILS │ │ DENY   │     ✓ tinted success, ✕ neutral (red only if destructive)
└────────┘ └────────┘ └────────┘
```

**Rationale:** always the same three-key shape, always the same order
(affirmative left, escape hatch center, negative right), so it's answerable by
position without reading. `DETAILS` routes the diff/command to your screen — the key
labels the decision, the screen holds the evidence. When the gated action is
destructive, the `APPROVE` key adopts the two-stage Confirm treatment (3.8).

## 3.2 Choice Picker — one of N

**When:** the AI has several valid paths and wants the human to pick — "which fix?",
"which branch?", "which tone?".

```
┌────────┐ ┌────────┐ ┌────────┐
│ ¹      │ │ ²      │ │ ³      │     Each option = one key; badge = its index
│ REBASE │ │ MERGE  │ │ SQUASH │     Frame: amber-breathing until one is pressed
└────────┘ └────────┘ └────────┘
```

**Rationale:** options are spatial and parallel, not a serial list — you compare them
at a glance instead of scrolling. Indices in the badge let the AI refer to them
("I recommend ②") and support a keyboard/voice fallback. Pressing one flashes it,
settles the others to idle, and returns the choice.

## 3.3 Attention Beacon — the minimal bridge

**When:** the smallest possible integration — a *single* key that represents "the AI
needs you." Idle/dark when all is well; amber-breathing when a decision is pending;
red-blink when something is blocked.

```
┌────────┐
│  ◆  ²  │     Dark when idle · amber-breathing when 1+ pending (badge = how many)
│ AGENT  │     Press → jumps you to the full context (drill-in page or screen)
└────────┘
```

**Rationale:** the entire thesis compressed into one key. Even if you adopt nothing
else, one beacon converts "go check whether the AI needs me" into an ambient signal
you never have to poll. Everything richer is an elaboration of this.

## 3.4 Status Board — ambient, non-interactive

**When:** you want continuous visibility of running work with no decision attached.

```
┌────────┐ ┌────────┐ ┌────────┐
│ ● BUILD│ │ ● TESTS│ │ ● DEPLOY    ● = agent identity dot; frame = that task's state
│  ▓▓▓░  │ │ shimmer│ │  idle       working(blue) / wait(amber) / done(green)
└────────┘ └────────┘ └────────┘
```

**Rationale:** these keys are *displays*, not buttons (a press just drills in). The
board is the deck earning its keep between decisions — a live dashboard of who's
doing what. When any tile flips to amber, the board has quietly become an Approval
Gate for that task.

## 3.5 Toggle / Mode — sticky state

**When:** a persistent setting the human owns — most importantly the **autonomy
level** of an agent.

```
┌────────┐        MANUAL   → every action gated
│  ⚙ AUTO│        ASSISTED → gates only risky actions
│ ASSIST │        AUTO     → runs free, reports after
└────────┘        (the glyph itself shows the current mode; press cycles)
```

**Rationale:** autonomy is the master dial of supervision — it sets how often every
*other* pattern fires. Making it a physical, always-visible sticky key means you can
dial the whole relationship up or down with a thumb, and you can *see* at a glance how
much leash the agent currently has.

## 3.6 Nudge / Interrupt — human-initiated

**When:** *you* need to act on the AI, not the reverse — pause it, stop it, or tell it
it's off track. The only patterns where the human opens the exchange.

```
┌────────┐ ┌────────┐
│  ⏸     │ │  ■     │     Always-present, quiet (idle frame) until pressed
│ PAUSE  │ │  STOP  │     STOP is armed (two-stage) if it kills in-flight work
└────────┘ └────────┘
```

**Rationale:** supervision is bidirectional. A supervisor who can only *respond* isn't
supervising. These keys are always available in a fixed spot so intervention is a
reflex, not a scramble to find the chat window and type "stop."

## 3.7 Dial Actions — the analog channel *(Stream Deck +)*

**When:** the decision isn't discrete — set a budget, a temperature, a count, a
threshold; scrub through many options.

```
   ╭───╮      Turn the dial → value changes live on the touchstrip / key above
   │ 4 │      Push the dial  → commit
   ╰───╯      LABEL: MAX $  ·  the touchstrip shows the scale + current point
```

**Rationale:** buttons quantize; some human inputs are continuous. A dial lets you
*feel* your way to a value and commit with a push — far better than pressing a `+` key
twelve times or typing a number. It extends the language's reach from *choices* to
*quantities* without breaking any of the visual grammar.

## 3.8 Two-Stage Confirm — for irreversible actions

**When:** a single press would do something you can't undo (delete, deploy to prod,
send-to-all, spend real money).

```
  press 1              press 2
┌────────┐          ┌────────┐
│  ⚠     │   →      │  ✓     │     Key turns danger-red + "CONFIRM?" on first press,
│ DELETE │          │CONFIRM?│     arms for ~3s, then reverts if not pressed again
└────────┘          └────────┘
```

**Rationale:** this is where *physicality* pays off. We deliberately raise the cost of
an irreversible action to two deliberate acts, and we make it *look* dangerous (red,
warning glyph). The arm-then-fire pattern is nearly impossible to trigger by accident,
yet still just two thumb taps. A mouse click can't convey "this is serious" the way a
key that turns red and asks again can.

## 3.9 Handoff / Escalation — the AI raising its hand

**When:** the agent hits something it shouldn't decide alone — low confidence, a
surprising finding, a policy boundary — and wants to *hand control back*.

```
┌────────┐
│  ✋  !  │     Frame: amber-breathing, badge: `!`  ·  glyph: raised hand
│ REVIEW │     Press → claims the handoff, opens full context, pauses the agent
└────────┘
```

**Rationale:** distinct from an Approval Gate because there's no pre-framed
yes/no — the AI is saying "I need a human here," not "approve X." Pressing *claims*
the escalation (useful when multiple people watch one deck) and shifts the agent to a
mode where it waits for direction rather than proposing an action.

---

## Composing patterns

Real supervision is these patterns layered over time on the same grid:

- A **Status Board** sits idle across the top. A build finishes → its tile flips to an
  **Approval Gate** ("deploy?"). You press `DETAILS`, it routes the plan to your
  screen, you press `APPROVE` (which is **two-stage** because it's prod). The tile
  flashes, settles to `working` blue, then `success` green, then fades to idle.
- Three agents run; one hits a wall and raises a **Handoff**. Its identity dot tells
  you *which* one without reading. You claim it, **Nudge** it back on track, and set
  its **Mode** toggle to `MANUAL` so it checks in more often.

The point of a shared grammar is that none of that required reading a manual — each
new pattern was recognizable the first time because it was built from signals you
already knew.

---

### Assumptions this document makes

- The common decisions of supervision really do collapse into this handful of
  shapes. If a domain needs constant *bespoke* layouts, the "learn once" payoff
  erodes — document 5 flags "pattern coverage" as a thing to validate against real
  agent traces.
- Position-based answering (approve-left / deny-right) is learnable and stable enough
  to trust without reading. Worth usability testing before it's load-bearing.
