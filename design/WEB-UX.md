# Nocturne Ritual on the Web

*The same ritual objects, at a different scale.*

The Stream Deck key is a 72-pixel niche: a rounded square cut from the night,
framed by hairline light, holding one glowing glyph. The web pages are its
siblings — the card, the tile, the row, the panel, the page itself are the same
object enlarged. Nothing on these pages floats; everything sits *in* something.
A page is not a document about the ritual, it is more of the ritual: the same
darkness, the same hairlines, the same single blue for data, the same violet
reserved for the machine mind, the same count sitting large and proud in pure
ink. Where the key face is rasterized and the page is not, the difference should
be in the resolution, never in the taste.

[design/PHILOSOPHY.md](PHILOSOPHY.md) is the *why*, and it contains no numbers.
This document is the *how*, and it is nothing but numbers. Where the two
disagree, the renderers win: `streamdeck-plugin/src/faces.mjs`,
`tools/make-icons.mjs`, `tools/make-animations.mjs` and `tools/lib-hue.mjs` are
the real specification, and every value below was measured out of them.

**The web surface is exactly six files.** `public/theme.css` (tokens + shared
classes), `public/nav.js` (the bar on every page), and the four pages:
`index.html` (Dashboard), `habits.html` (Habits manager), `mind.html` (Inside
the Coach), `deck.html` (Virtual Stream Deck). Nothing else. There is no build
step, no framework, and no dependency — the only modern CSS feature in use is
`color-mix(in oklab, …)`.

---

## 1. The theme model

Tokens are declared on `body`, not `:root`. This is load-bearing:

```css
body { --card: #121521; /* … */ }

@media (prefers-color-scheme: light) {
  body:not([data-nav="dark"]) { --card: #ffffff; /* … */ }
}
```

**Every page follows the OS theme. There are no exceptions, and a page that
opts out is a bug.** This is the whole point of the issue this document came
from: a Mind page pinned to night while its siblings went light does not read as
the same product, however good it looks on its own.

A page may re-bind a token on its own `body` — `mind.html` does, to make its
niches glassy (§7.4) — which only works because the tokens live on `body`. Do
not move them to `:root`. **A re-bind owes a value to each theme**; binding only
the night value is how a page silently pins itself to night.

The `body[data-nav="dark"]` escape hatch still exists in `theme.css` and nothing
uses it. Leave it there for a page that one day genuinely must be dark in both
themes, but understand that reaching for it is a design decision to argue for
here first — not a shortcut past writing the light values.

Every page loads, in this order:

```html
<link rel="stylesheet" href="/theme.css" />
<style>/* page-local rules only */</style>
…
<body>
  <script src="/nav.js" defer></script>   <!-- must be the first thing in body -->
```

`nav.js` injects itself as `body`'s first child, so a page's own layout element
is the *second* child. Plan for that.

Because the page's `<style>` loads after `theme.css`, **a page-local rule always
beats a shared one at equal specificity.** That is the escape hatch. It is not
the default: if you are re-typing a shared rule to change one property, override
that one property.

---

## 2. Tokens

The complete set. **A raw hex, rgba, px radius or px gap in a page is a bug when
a token exists for it.** Light values marked *same* are not overridden and
inherit the night value.

### Surfaces and ink

| Token | Night | Light | For |
|---|---|---|---|
| `--bg` | `#0b0d14` | `#f4f5f8` | The page field. The floor everything is carved out of. |
| `--bg2` | `#090b10` | `#eceef3` | A recess *below* the field (inset wells). |
| `--card` | `#121521` | `#ffffff` | The niche floor. Every card, tile, row, panel. |
| `--card2` | `#171b2a` | `#f7f8fb` | A niche on a niche: tooltips, code pills, nested surfaces. |
| `--line` | `#232838` | `#e3e6ec` | The hairline at the threshold of visibility. Always `1px`. |
| `--fg` | `#eceef2` | `#191c22` | Primary ink. Titles, numbers, values. |
| `--ink2` | `#b9c0cc` | `#3c4250` | Secondary ink. The coach's own prose, memory text. |
| `--muted` | `#8f97a6` | `#6a7280` | Whisper. Labels, timestamps, hints, placards. |

Three inks, not four. A fourth grey is a bug — including "just slightly dimmer"
values like `#9aa0a6` or `#cfd3d8`.

### Color with a job

| Token | Night | Light | For |
|---|---|---|---|
| `--accent` | `#7fa9ff` | `#2563eb` | Links and focus rings. Never a fill, never data. |
| `--violet` | `#8b5cf6` | *same* | The coach speaking — **fills and gradients only** (4.29:1; too weak for text). |
| `--violet-deep` | `#5b21b6` | *same* | The far stop of the coach gradient. Never used alone. |
| `--violet-ink` | `#a78bfa` | `#6d28d9` | The coach speaking **as text**. 6.68:1 night, 7.10:1 light. |
| `--on-violet` | `#ffffff` | *same* | The only ink permitted on `--grad-coach`. |
| `--amber` | `#f59e0b` | `#b45309` | The coach speaking **louder**: a nudge, a hardware warning. Hue 38. |
| `--series` | `#3987e5` | `#2a78d6` | The one disciplined data blue. One series, one color, no palette. |
| `--good` | `#37c978` | `#0f7a46` | State: yes, live, done. |
| `--bad` | `#e05252` | `#b91c1c` | State: no, error, destructive. |

`--violet-ink` inverts direction between themes (lighter on night, darker on
light) because it must clear 4.5:1 against both `--card` values. So does
`--amber`. Never use the night value of either on a light surface.

### Composed values

| Token | Night | Light | For |
|---|---|---|---|
| `--grad-coach` | `linear-gradient(135deg, var(--violet), var(--violet-deep))` | *same* | Every filled coach surface: primary button, COACH chip, ADD badge. |
| `--chrome` | `rgba(11,13,20,.72)` | `rgba(244,245,248,.82)` | The sticky nav bar, behind `backdrop-filter: blur(12px)`. Needs alpha, so it cannot be `--bg`. |
| `--shadow-pop` | `0 6px 18px rgba(0,0,0,.45)` | `0 6px 18px rgba(16,20,32,.14)` | **The only** elevation step in the system. Tooltips, popovers, menus. |

There is one shadow because there is one floating surface. Depth otherwise comes
from inset light (§4), never from a drop shadow.

### Geometry

| Token | Value | For |
|---|---|---|
| `--r-lg` | `16px` | Niches: cards, tiles, panels, rows. |
| `--r-md` | `10px` | Controls: buttons, nav links. |
| `--r-sm` | `8px` | Chips, badges, inputs, code pills. |
| `--s1 … --s6` | `4 8 12 16 24 32` | The whole spacing scale (§5). |
| `--font` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` | The one family. No webfont, ever. |

Three radii, and that is the ladder. `14px` is not a radius in this system, and
neither is `6px`.

---

## 3. Color roles

Color is identity, never decoration (PHILOSOPHY.md:23). Each rule below has a
renderer behind it.

**Violet is reserved and sacred — it means *the coach is speaking*.** Never a
habit, never a brand accent, never a generic "primary". The reservation is
enforced in arithmetic, not by convention: the habit-hue hash skips the band
`[245, 285)` outright (`tools/lib-hue.mjs:12-13` — `let hue = h % 320; if (hue
>= 245) hue += 40;`). Every violet in the product measures inside that band:
`--violet` 258, `--violet-deep` 263, `--violet-ink` 255, the icon generator's
`VIOLET` 262.

Two violets, two jobs, and they are not interchangeable:

* `--violet` / `--violet-deep` are **surface**. They appear as `--grad-coach`,
  or as a `3px` left rail on a coach-owned row (`habits.html` `.crow`, `.prow`),
  or as a low-alpha wash. Never as flat fill, never as text.
* `--violet-ink` is **type**. Any coach status rendered as words — `ON A SLOT
  KEY NOW`, a confidence label, a `SLOT 3` tag — wears it.

**Amber is the coach's second voice: the nudge.** An unsolicited, expiring poke.
It is the only color in the system whose *intensity is a function of time*: as a
nudge's TTL runs down, halo lightness climbs `+12%`, halo opacity `+.33`, and the
border firms up `+2px` (`faces.mjs:42-47`, mirrored at `deck.html:100-105` via
`--urg`). On the web, `--amber` is hue 38 to match `NUDGE_HUE`. It also carries
"your physical deck has gone quiet", which is the same idea: attention, now.

For an amber or violet *fill* derive it, do not add a token:

```css
background: color-mix(in oklab, var(--amber), transparent 82%);
border-color: color-mix(in oklab, var(--amber), transparent 45%);
```

**Magenta (hue 300) is the coach's third voice: asking.** A linked yes/no pair,
chosen so it reads as neither suggestion nor nudge (`deck.html:107-110`). It
exists today only on key faces. If the web ever surfaces a coach question, it
takes hue 300 and gets a token at that point — not before.

**`--series` is the one color data is allowed to wear.** One series, one color,
no palette (PHILOSOPHY.md:29-30). It is the only token with a recorded contrast
validation in *both* themes, and that is the standard for any future data color.
Note that `--series` (213), `--accent` (220) and the "no identity" silver (222)
all cluster in the same narrow blue band — which is correct and deliberate:
links and data are exactly the things that have no identity to remember.

**Hue is memory, and it is derived, never chosen.** A habit's hue is FNV-1a of
its *name*, modulo 320, violet band skipped (`tools/lib-hue.mjs:1-14`) — so the
baked PNG, the animated GIF, the live SVG key face and the virtual deck all
arrive at the same color without ever exchanging one. Saturation 72% is the
default, 85% is the lit/active variant, and saturation is multiplied by `0.55`
when the habit is done for the day.

> **The web's largest open debt.** `index.html`, `habits.html` and `mind.html`
> compute no hue at all, so a habit loses its lifelong color the moment it leaves
> the deck. Any web element that represents a *named habit* should carry
> `style="--hue: <hueFor(name)>"` and use it for its halo, ring or rail. A
> surface that shows a habit and throws away its hue has thrown away the memory.

**`--good` / `--bad` are state, never data.** A success line, an error line, a
destructive hover. They never appear as a second series alongside `--series`.

**Everything else is achromatic.** Three inks and a hairline. If a new element
wants a color, the question is which of the roles above it is — and if the answer
is "none", it is `--muted`.

---

## 4. Form

**One form: the rounded square, at every scale.** There is no circle in the
system except two ornaments — the nav brand dot and a memory orb in mind.html —
and neither is ever a container.

**The corner ratio is ~0.13 of the side**, and it holds across a 24× size range:
key face `rx 17 / 132` = .129 (`faces.mjs:102`), rasterized icon `34 / 264` =
.129 (`make-icons.mjs:39`), virtual key `16 / 118` = .136 (`deck.html:60`). That
ratio is what makes a chip and a full page read as the same object.

**A niche is always the full triple** — background **and** hairline **and**
radius. A background with no border, or a border with no background, is not a
niche:

```css
.card, .niche {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: var(--s4);
}
```

**The radius ladder:**

| Radius | Token | Applies to |
|---|---|---|
| 16px | `--r-lg` | Cards, tiles, rows, panels, notes, empty slots |
| 10px | `--r-md` | Buttons, nav links, tooltips |
| 8px | `--r-sm` | Inputs, chips, badges, code pills, chart hit-areas |

Two exceptions, both geometry rather than surface: the chart bar's cap
(`4px 4px 0 0` — a data mark, not a container) and everything inside deck.html's
device render (§7).

**The hairline is defined by its opacity, not its width.** On the web it is
always `1px solid var(--line)`. On a key face the equivalent is a `1.5px` stroke
at 30% opacity (`faces.mjs:102`); in a rasterized icon, `2px` at 30% alpha
(`make-icons.mjs:39`). Same line, different medium.

**The frame is inset, not flush** — on the key faces the hairline sits ~4.2% of
the side inside the edge, which is what makes a key look recessed rather than
printed. The web equivalent is the padding inside a niche: content never touches
the hairline.

**The grid is always `repeat(auto-fill, minmax(N, 1fr))` with a `--s3` gutter**,
and only `N` changes with content weight: `150px` for a bare stat, `200px` for a
card carrying prose. Layout decisions in this system are about the grid, not
about bespoke shapes.

**Page measure is capped and centered:** `760px` for a form, `860px` for the
dashboard, `900px` for the coach's prose. Nothing goes full-bleed.

**An empty niche is dashed, centered, muted** — the established way to say "a
slot exists here and nothing is in it". Never blank, never hidden.

**Depth is inset light, not drop shadows.** The one permitted outer shadow is
`--shadow-pop`, on the one floating surface.

---

## 5. Spacing

The scale is `--s1: 4px`, `--s2: 8px`, `--s3: 12px`, `--s4: 16px`, `--s5: 24px`,
`--s6: 32px`. It is the entire vocabulary of gaps. PHILOSOPHY.md:41-42 —
*"spacing follows a strict scale so that every gap looks deliberate."*

| Use | Token |
|---|---|
| Icon-to-label, chip padding (vertical) | `--s1` |
| Inside a control, tight pairs, button padding (vertical) | `--s2` |
| **Every grid and flex gutter**, section-header margin | `--s3` |
| Niche padding, button padding (horizontal) | `--s4` |
| Page gutter, block separation, header margin | `--s5` |
| Section rhythm, page top padding | `--s6` |

**The scale does not grow.** The recurring off-scale values in the pages today —
`6, 9, 10, 11, 13, 14, 18, 20, 22, 30, 34` — each round to a neighbour; they do
not justify new steps. In particular the ubiquitous `gap: 10px` becomes
`var(--s3)`, everywhere, so that every gutter in the product is the same gutter.
The page container's bottom breathing room is the one composed value:
`calc(var(--s6) * 2)`.

Optical values that are *not* spacing are exempt: type sizes, line heights, the
`3px` coach rail, the `1px` hairline, and device geometry in deck.html.

---

## 6. Components

`theme.css` ships these. **Adopt the class; do not re-implement it.** Each
subsection lists the markup and the tokens it consumes.

### Page frame — `.wrap`

```html
<div class="wrap">…</div>              <!-- 860px: the dashboard -->
<div class="wrap narrow">…</div>       <!-- 760px: a form -->
<div class="wrap wide">…</div>         <!-- 900px: the coach's prose -->
```

`max-width` · `margin: 0 auto` · `padding: var(--s6) var(--s5) calc(var(--s6) * 2)`.
Tokens: `--s5`, `--s6`.

### Page header — `header` / `.page-head`

```html
<header>
  <div>
    <h1>Habits</h1>
    <div class="sub">The fixed keys — what you're deliberately tracking.</div>
  </div>
  <div class="sub" id="updated">Updated 9:41 PM</div>
</header>
```

Flex, `align-items: baseline`, `justify-content: space-between`, wraps, `--s3`
gap, `--s5` bottom margin. `h1` is `22px / 650 / -.01em` — the page title is not
the loudest thing on the page, the count is, and nothing at reading size is ever
weight 700. `.sub` is `13px` in `--muted`.

### Section header — `.section-h` (+ `.hint`)

```html
<h2 class="section-h">Core memories</h2>
<div class="hint">They form as the coach works.</div>
```

`13px / 600 / uppercase / .07em / --muted / margin 0 0 var(--s3)`. The museum
placard: it names the artifact, it never competes with it. `.hint` is the
optional second line at `12.5px`.

### Card / niche — `.card`, `.niche`

```html
<div class="card">
  <div class="emoji">💧</div>
  <div class="big">128</div>
  <div class="name">Drink</div>
</div>

<div class="card flush">          <!-- a niche that holds rows: no padding, clipped -->
  <div class="row">…</div>
</div>
```

Background + hairline + `--r-lg` + `--s4` padding. Tokens: `--card`, `--line`,
`--r-lg`, `--s4`.

The number inside is the one permitted loudness: `28-30px / 650 / -.02em`, **no
color declaration at all** — it inherits `--fg`. A number is proud, not shouting.
Numbers that sit in a column or change in place also take
`font-variant-numeric: tabular-nums`.

### Grid — `.grid`

```html
<div class="grid">…</div>          <!-- minmax(150px, 1fr): bare stats -->
<div class="grid prose">…</div>    <!-- minmax(200px, 1fr): cards with prose -->
```

`repeat(auto-fill, minmax(N, 1fr))`, `gap: var(--s3)`.

### Buttons — `.btn`, `.btn.ghost`, `.linklike`

```html
<button class="btn">Save</button>                    <!-- affirmative: the coach's fill -->
<button class="btn ghost">+ Add habit</button>       <!-- secondary: hairline + accent -->
<button class="linklike" id="tblBtn">table</button>  <!-- a control that reads as a link -->
```

`.btn` — `--grad-coach` fill, `--on-violet` ink, `--r-md`, `var(--s2) var(--s4)`
padding, `600 13px/1`. `.btn:disabled` is `opacity: .55` and must stay visually
distinct. `.btn.ghost` is transparent + `--line` border + `--accent` text.

> **Contrast note.** `--on-violet` on the *lightest* stop of `--grad-coach` is
> 4.23:1, and on `--violet-deep` it is 8.98:1; because the gradient runs 135°,
> its lightest point is the top-left corner, outside the text box, so the
> measured value under the label is ≈5.6:1. The rule that keeps this true:
> **nothing smaller than 13px/600 ever sits on `--grad-coach`.**

Interaction feedback is `60–150ms` and nothing between the regimes (§ Motion).
There is no `300ms` anywhere in this product.

### Form field — `.field`, `.field-label`

```html
<label class="field-label" for="setName">Your name (the coach uses it)</label>
<input class="field" id="setName" maxlength="60" placeholder="e.g. Shai" />
```

`.field` — full width, `--bg` fill (a control is a recess in the niche, not
another niche), `--line` hairline, `--r-sm`, `var(--s2) var(--s3)` padding,
`14px`. `.field[readonly]` is `opacity: .6`. `.field-label` is `12px --muted`.

It is **not** called `.label` — `habits.html` already uses `.label` for the
key-label input, and a shared `display: block` would corrupt that grid.

### Chip and tag — `.chip`, `.tag`

```html
<span class="chip coach">COACH</span>   <!-- the coach's fill -->
<span class="chip quiet">HUMAN</span>   <!-- hairline, muted -->
<span class="tag">SLOT 1 · logs as Drink</span>
<span class="tag nudge">❗ NUDGE · logs as Drink</span>
```

`.chip` carries a surface: `10px / 700 / .07em / uppercase`, `var(--s1)
var(--s2)` padding, `--r-sm`. `.tag` is type only: `11px / 700 / .05em` in
`--violet-ink`, or `--amber` with `.nudge`. Weight 700 is reserved for these
and for corner badges — nothing at reading size is ever 700.

### Status line — `.status`, `.status.err`

```html
<span class="status" id="status">Saved — dashboard, coach, and virtual deck are updated.</span>
<span class="status err" id="status">Couldn't reach the server.</span>
```

One element, one sentence, `13px`, `--muted`, or `--bad` when it failed. There
are no toasts on the web surface; the deck's confirmation is a held overlay and
the page's is a line of text that stays put.

### Empty state — `.empty`

```html
<div class="empty">No taps yet. Tap a habit key on your Stream Deck.</div>
<div class="card empty">Slot 3 — empty</div>   <!-- dashed niche: something belongs here -->
```

`.empty` alone is muted text. `.card.empty` / `.niche.empty` is the dashed,
centered, `96px`-tall niche — the established "a slot exists here and nothing is
in it". Three implementations already agreed on this before it was a class.

### Note / callout — `.note`

```html
<div class="note">
  <b>Where changes land:</b> everywhere, live — the dashboard, AI coach, …
</div>
```

A niche at `13.5px / 1.6` in `--ink2`, with `<b>` stepping up to `--fg`. This is
the product explaining itself, so it stays quiet. Prose that is the *coach's own
voice* steps up instead: `14.5px / 1.55–1.6` in `--ink2`. The coach is easier to
read than the app is.

### Tooltip — `.tip`

```html
<div class="tip"><b>7</b> taps · Mon, Jul 27</div>
```

`position: fixed`, `--card2` on `--line`, `--r-md`, `--shadow-pop`, `12.5px`,
`pointer-events: none`, `display: none` until the page positions and shows it.
`.tip b` is `14px` tabular. The only floating surface in the system.

### Data table — `.data-table`

```html
<table class="data-table" id="tapTable" hidden>
  <tr><th>Day</th><th>Taps</th></tr>
  <tr><td>Monday, Jul 27</td><td>7</td></tr>
</table>
```

Collapsed borders, `13.5px`, `var(--s2) var(--s3)` cells, `--line` rules,
uppercase `11.5px --muted` headers with no top rule, and the last column right
aligned and tabular. This is the accessible fallback behind every chart — the
dashboard's `table` toggle is not an extra, it is the table view of the same
data.

### Focus

`theme.css` gives every interactive element a `2px var(--accent)` ring at
`:focus-visible`, declared inside `:where(…)` so it has **zero specificity** —
any page rule wins, and no page needs to opt in. Removing a focus ring is not a
design decision available here.

---

## 7. Sanctioned exceptions

Four places may leave the token system. Each is an *illustration of a physical
or imaginary object*, not a UI surface. The rule that bounds all four:

> An exception may add **background, texture, gradient, glow and illustration**.
> It may not supply its own **text color, hairline, link color, focus ring or
> button** — those still come from tokens.

**1. deck.html's photoreal device render** (`.device`, `.face`, `.stand`, `.k`,
the LCD glass sheen, the flash scrim, and the `--key / --gap / --pad` geometry
on `:root`). This is a picture of a physical object: enclosure plastic, bezel,
key wells, cast shadows. Tokenizing it would let a palette edit deform the
hardware. Its custom properties belong on `:root` precisely because they are
device geometry rather than page tokens — that scope difference is the signal.

**The device stays black in light mode**, and this is the one place in the
system where something legitimately does not flip. A Stream Deck is black
plastic; a white one in light mode would be a lie about the hardware, and this
page exists to be an honest preview of it. The test is whether the thing depicts
a real object — not whether it looks better dark.

*Not* covered by the exception, and all of which do follow the theme: the studio
vignette staging the shot, which is built from `--card2 → --bg → --bg2` so the
device sits on a light desk by day and a dark one at night;
`.k:focus-visible`, which is accessibility chrome and takes `--accent`; and the
page's own captions and links, which take `--muted`, `--ink2` and `--accent`
like anywhere else.

**2. The virtual deck's coach faces** (`.slotface`, `.nudgeface`, `.qface`,
`.habitface`, `.emptyface`). These are **byte-parity mirrors** of
`streamdeck-plugin/src/faces.mjs` and must stay that way: `VIOLET_HUE 262`,
`NUDGE_HUE 38`, `QUESTION_HUE 300`, `sat 72`, the `#141827 → #0a0c13` base
gradient, the halo formula, and the urgency math
(`haloHi = 58 + 12·urg`, `haloOpacity = .62 + .33·urg`, `ringOpacity = .3 + .5·urg`,
`ringWidth = 1.5 + 1.5·urg`). Replacing any of those with a token would let a
web-side theme edit silently desync the virtual deck from the hardware, which is
the one thing the virtual deck exists not to do. The halo in particular is a
fixed formula, not a look — reproduce it exactly, never re-center it, never
widen the stops:

```css
radial-gradient(circle at 50% 36%,
  hsla(H, S, 58%, .62) 0%, hsla(H, S, 45%, .18) 42%, transparent 68%)
```

It is off-center (36%, not 50%) on purpose: the light comes from above the
glyph, like a votive lamp.

**3. The per-object identity hue.** `hsla(var(--hue), …)` anywhere is correct
and must not become a token — the value is *derived* from the object's name by
`tools/lib-hue.mjs`, and the whole point is that four independent renderers
arrive at it without agreeing on anything. Hue 222 (silver) is the same
machinery with the color drained: the hue an object wears when it has no
identity to remember.

**4. mind.html's dreamscape.** The page-scale aurora gradient behind the coach's
mind, and its page-local re-bind of `--card` / `--line` to glass values:

```css
body { --card: rgba(255,255,255,.045); --line: rgba(255,255,255,.09); }

@media (prefers-color-scheme: light) {
  body:not([data-nav="dark"]) { --card: rgba(255,255,255,.72); --line: rgba(16,20,32,.10); }
}
```

This is a *re-bind of existing tokens*, not an escape from them — every `.card`
on the page still says `var(--card)`, so the glass look is one edit and not
forty literals. **The re-bind carries both themes**, because the page follows
the OS like every other (§1): frosted white on a pale field by day, light lifted
off a dark floor at night. The aurora's own floor is `--bg → --bg2`, so the
dreamscape flips with the theme and only the coloured washes are painted on top.
That is the sanctioned shape of a page-local look. What is
*not* sanctioned on that page: hard-coded accents (`#8fb4ff` is a drifted
`--accent`), hard-coded coach text (`#a78bfa` is `--violet-ink`), aurora stops
typed as literals when `--violet` and `--accent` are the actual intent, and the
decorative `ORB_COLORS` ramp — which spends the reserved coach violet on an
arbitrary memory index. If memories need color, it is `hueFor(the memory's own
text)`, not a rotating palette.

**Known collisions this document does not resolve.** The habit-hue hash reserves
only `[245, 285)` for violet. Amber 38 and magenta 300 are both reachable, so a
habit can be born wearing the nudge color or the question color. Either
`lib-hue.mjs` grows two more skipped bands or this stays a documented, accepted
risk — but it is a real gap, not an oversight. Likewise `tools/make-animations.mjs`
paints the Stats key with three data colors where the philosophy allows one; the
web chart gets this right, and must not later be "corrected" toward the key.

---

## 8. Motion

The web's motion budget today is three transitions. If it grows, it inherits the
whole specification:

* **The devotional loop is 1.92 seconds, exactly** — 24 frames at 12.5fps
  (`make-animations.mjs:28-30`). That is this product's answer to PHILOSOPHY.md's
  "under two seconds".
* **Every loop starts and ends on the same pose** (`0%,100%{…}`), so it is
  seamless. Stated as law in the source.
* **The verbs are organic and there are six of them**: rock (±7°), boing
  (squash-and-stretch off `50% 100%`), munch, bob, run, pulse (scale 1.08). No
  slides, no spins, no fade-in-from-below. Amplitude ceiling ≈6%.
* **Easing**: `ease-in-out` for anything that returns, `ease-out` for anything
  that dissipates.
* **A second moving element is in counterpoint, never in sync.**
* **Interaction feedback is 60–150ms.** Key press `.06s`; nav hover `.12s`;
  confirmation flash `.15s`. Nothing in between the two regimes.
* **A press is physical**: down 2px, scale `.965`, brightness `.82`, outer shadow
  collapsing so the key sits into its socket. Reuse it for any web control that
  stands in for a key.
* **Escalation is a ramp, not a blink** — an ignored nudge gets harder to keep
  ignoring, continuously, as a function of urgency.
* **`prefers-reduced-motion` is honored nowhere in this repo yet.** The first
  ambient loop added to the web must ship with it.

Two more live constraints: the README screenshots are captured after
`networkidle + 2500ms` with no interaction, and every e2e suite navigates with
`waitUntil: 'networkidle'`. **Entrance animations, skeleton loaders and intro
transitions are therefore forbidden** — they would be photographed mid-flight and
would destabilize the suites.

---

## 9. How this is enforced

Prose does not hold a line; a test does. `tests/unit/hue.test.mjs` is the model —
it reads `public/deck.html` and `tools/lib-hue.mjs` as **text** and asserts the
FNV-1a markers appear in both, so the habit hue cannot fork between renderers
without a red test.

`tests/unit/design-tokens.test.mjs` does the same for this document. It reads
`public/theme.css`, `public/nav.js` and the four pages as text and asserts, at
minimum:

1. **Every token named in §2 is declared in `theme.css`** — with both a night
   value and, where §2 lists one, a light-mode value. Renaming or dropping a
   token silently degrades a page to a browser default (usually black on black),
   so the declaration itself is the assertion.
2. **No raw color outside the sanctioned files** — hex *and* the functional
   notations (`rgb`/`hsl`/`oklch`/…) *and* CSS named colours, since any of the
   three can smuggle a colour past a guard that only knows the others. The
   allow-list is **exact literals in exact files, never a whole-file exemption**:
   `mind.html` is now down to its glass re-bind and two aurora washes and holds
   no hex at all, and `deck.html` lists only its enclosure, key wells and
   key-face gradients — its studio vignette follows the theme and is not
   allow-listed. Anything reading `var(--…)` or `hueFor(…)` is derived, not raw,
   and always passes.
   *Pruning that list when a literal becomes a token is part of the job:* a
   stale entry silently re-permits a colour the system already replaced.
3. **No off-ladder radius.** No `border-radius: 14px` or `6px` in any page; the
   only literal radii permitted are inside deck.html's device block.
4. **No duplicate recipes.** The string `linear-gradient(135deg` appears exactly
   once in the whole web surface (the `--grad-coach` declaration), and the
   `--font` stack literal appears exactly once (the `--font` declaration).
5. **Key-face parity holds.** The halo formula, `NUDGE_HUE 38`,
   `QUESTION_HUE 300`, `VIOLET_HUE 262` and the `#141827 → #0a0c13` base still
   match `streamdeck-plugin/src/faces.mjs` — the existing drift-guard pattern,
   extended to the values this document names.

When the test and this document disagree, fix both in the same commit. When this
document and a renderer disagree, the renderer is right and this document is
stale — PHILOSOPHY.md is the taste, the renderers are the spec, and this file is
the bridge.
