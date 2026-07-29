# 1 · The thesis

## The shift that creates the need

For the first wave of AI tools, the interface question was settled: a text box.
You typed, the model answered, you typed again. The human was the **author** and
the model was the instrument.

Agentic AI breaks that model. An agent now runs a long task, spawns sub-agents,
edits files, calls tools, and loops — mostly without you. Your role changes from
author to **supervisor**. You are no longer producing a stream of prompts; you are
waiting to be *called* for the small number of moments that need a human:

- *"Can I run this command / send this email / push this commit?"* — an approval.
- *"Which of these three approaches do you want?"* — a choice.
- *"I'm stuck / I found something surprising."* — an escalation.
- *"You're heading the wrong way."* — an interrupt, initiated by you.

These are short, high-value, latency-sensitive exchanges. And the chat box is a
bad instrument for all of them.

## Why the chat box is the wrong tool for supervision

- **It demands foreground focus.** To answer, you context-switch your whole screen
  and attention back into the conversation.
- **It's serial and modal.** A terminal permission prompt blocks. You can't glance
  at "three agents are waiting" — you deal with them one blocking dialog at a time.
- **It has no ambient state.** Between messages, the AI's status is invisible. Is it
  working? Stuck? Done? You have to go look.
- **Every decision costs a sentence.** "Yes, approved" is a lot of ceremony for a
  binary that your thumb could have answered.

The result is *approval fatigue* and *supervision blindness*: either you babysit the
chat window (defeating the point of autonomy) or you walk away and miss the moments
you were needed.

## Why a grid of keys fits

A Stream Deck-like device has an unusual set of properties for this job:

- **Peripheral & ambient.** It lives on the desk, in the corner of your eye. The
  AI's state can be *continuously visible* without occupying your main screen. A
  mostly-dark deck with one amber key pulsing is a complete status report you read
  without turning your head.
- **Colocated I/O.** The screen (AI → human) and the button (human → AI) are the
  *same physical object*. Unlike screen-plus-keyboard, there's no indirection: you
  press the thing that's asking.
- **Physical = committal.** A button press is a deliberate, embodied act. That's
  exactly right for a *decision*. It also lets us make dangerous actions feel
  dangerous (arm-then-fire) in a way a click never quite does.
- **Spatially addressable → muscle memory.** "Approve" is always in the same place.
  Over days, your thumb learns the deck and you answer without reading. No text UI
  earns muscle memory like a fixed physical layout does.
- **Glanceable.** A key is a purpose-built status light with a label. It's designed
  to be read at a distance and at a glance — the opposite of a line of chat.
- **Bounded — and that's the point.** Fifteen keys can't hold a conversation, so the
  AI *can't* dump everything on you. The constraint forces it to surface only what
  truly needs a human. Scarcity of keys is scarcity of interruptions.

Add the **Stream Deck +**'s dials and touchstrip and you also get an *analog*
channel — set a number, scrub a threshold, dial a budget — that buttons alone lack.

## What the device is, precisely

Not a remote control, not a macro pad for shortcuts. In this study the deck is:

> **A decision surface** — a physical console where the AI renders the moments it
> needs a human, and the human answers with a glance and a thumb.

Three verbs define it:

- **Surface** — the AI raises a small number of pending decisions into physical,
  glanceable form.
- **Decide** — the human resolves them with a press (or a dial), committing.
- **Ambient** — between decisions, the deck quietly shows state, so supervision
  costs no attention until it needs to.

## Where the deck is the *wrong* tool

A design study that only lists strengths is marketing. The deck is a poor fit for:

- **Long-form or nuanced input.** Anything that needs a sentence stays in chat. The
  deck answers *bounded* questions, not open ones.
- **Reading detail.** A 72-pixel key can label a decision; it can't show you the
  diff. The deck should *route* to detail (on screen), not try to contain it.
- **High-volume streams.** If the AI needs a human 200 times an hour, the deck won't
  save you — the autonomy is broken, and no interface fixes that.
- **Rare, one-off tasks.** Muscle memory and ambient value accrue over *repeated*
  supervision. For a thing you do once, the chat box is fine.

The honest framing: the deck is the **fast path for the common, bounded decisions of
ongoing supervision**, sitting *beside* the screen that holds the detail and the
chat that holds the nuance. It doesn't replace them; it removes their busywork.

---

### Assumptions this document makes

- The dominant future interaction mode for capable agents is *supervision*, not
  authoring. If agents mostly stay in tight human-authored loops, the case weakens.
- Human decisions can usefully be compressed to *bounded* forms (approve / pick /
  toggle / dial). Document 3 stress-tests how far that compression goes.
- Ambient peripheral display has real attention value over on-screen notifications.
  Document 5 lists this as a thing to measure, not assume.
