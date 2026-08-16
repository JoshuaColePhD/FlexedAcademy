---
name: FlexEd Academy
description: Warm-paper, district-blue lesson planner; a verified seal on violet at the door.
colors:
  paper: "#f6f4ec"
  ink: "#14161a"
  ink-muted: "#666d78"
  edge-strong: "#c3bdac"
  accent-district-blue: "#2f5fbf"
  brand-violet-ground: "#241047"
  brand-ink-lavender: "#EDE6FB"
  brand-muted-lavender: "#B0A3D4"
  land-gold: "#D4A73C"
  land-gold-bright: "#E8C168"
  land-gold-ink: "#8A6215"
  land-paper: "#FAF7F2"
  mark-destructive: "#b3261e"
  flag-warning: "#a15c07"
  ok-success: "#1f6a45"
typography:
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontWeight: 400
  landing-display:
    fontFamily: "'Bricolage Grotesque', Inter, sans-serif"
    fontSize: "clamp(2.5rem, 7vw, 5.5rem)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  landing-heading:
    fontFamily: "'Bricolage Grotesque', Inter, sans-serif"
    fontSize: "clamp(1.5rem, 3vw, 2rem)"
    fontWeight: 700
  landing-quote:
    fontFamily: "'Source Serif 4', Georgia, serif"
    fontStyle: "italic"
    fontSize: "1.0625rem"
rounded:
  sm: "5px"
  md: "8px"
  lg: "12px"
spacing:
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-district-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
  land-cta:
    backgroundColor: "{colors.land-gold}"
    textColor: "{colors.brand-violet-ground}"
    rounded: "{rounded.sm}"
---

# Design System: FlexEd Academy

## Overview

**Creative North Star (marketing door only): "The Verified Seal"**

The product itself is a plain, warm-neutral document tool: paper and ink, one district blue that means something because it is the exact color printed on the .docx a teacher hands in. (The app's paper was cool-neutral through an earlier iteration; it's warm now, closer to Claude's own palette, per direct product direction — see the header of tokens.css.) The landing page is the one deliberate exception: it commits to a violet-ground brand world — always, regardless of the visitor's OS light/dark setting — rather than a thin violet accent on white.

The original direction took its cue from a supplied logo mark (a violet gem glowing on near-black), but that file turned out to be a flat opaque PNG with no alpha channel — it rendered as a hard white-cornered square against the violet ground rather than blending in, and was removed at Josh's request. The header is text-only ("FlexEd Academy") until a transparent-background version of the mark exists; the violet-ground world itself stands on its own and doesn't require the mark to justify it.

Gold is the second color, and it has exactly one job: it is the "verified" mark. A hand-drawn seal (a circle and a checkmark, stroke-drawn on load) sits beside the headline's claim and again beside the cited standard in the proof section — gold never appears as generic decoration, only as evidence a claim was checked. The one warm, paper-toned section breaks from violet on purpose: it is showing an excerpt of an actual paper standards document, and it earns that warmth exactly there, not as the page's whole personality.

A first pass at this page (a steel-and-glass "glazier's wall" metaphor, bordered panes throughout) read as generic broadsheet-grid — the exact AI-generated-design default this system exists to avoid. This second pass replaced the layout metaphor with one authored signature (the seal) and let the real brand color carry the page instead of a thin accent on white.

**Key characteristics:**
- Two colors, two jobs: violet is the identity/ground, gold is reserved for "this was checked."
- The landing page ignores `data-theme` entirely — a deliberate, fixed brand world, unlike every other surface in the product.
- One display face (Bricolage Grotesque) for the landing headline only; one serif (Source Serif 4, italic) for quoted document text only; the app's own Inter/JetBrains Mono carry everything else, including the landing page's UI chrome.
- Motion is two scroll-triggered reveals (the citation connector draws, the pipeline thread draws with its nodes) plus one load-time moment (the hero seal stamps in) — never scattered hover effects.

## Colors

### Primary (product)
- **District Blue** (`#2f5fbf`, `--accent`): every citation, every filled control, every actionable state inside the actual product. Reserved for what is actionable inside the app.

### Secondary (landing page only)
- **Ink Violet** (`#241047`, `--brand`): the landing page's dominant ground — hero, pipeline, and footer all sit on it. Fixed regardless of theme.
- **Verified Gold** (`#D4A73C`, `--land-gold` / bright `#E8C168`, `--land-gold-bright`): the seal and the one filled CTA. Both measure under 3:1 against the warm paper section (2.1:1 and 1.6:1) — legal there only as a fill under dark text (the CTA), never as a stroke or text color on paper.
- **Gold Ink** (`#8A6215`, `--land-gold-ink`): the same hue, darkened until it clears 5.1:1 against the paper section — used for the citation number and the seal stroke wherever they sit on `--land-paper`.
- **Lavender Ink** (`#EDE6FB`, `--brand-ink`) / **Lavender Muted** (`#B0A3D4`, `--brand-muted`): body and secondary text on the violet ground.
- **Document Paper** (`#FAF7F2`, `--land-paper`): the one warm section, holding the real-document excerpt only.

### Neutral (product)
- **Paper** (`#f6f4ec` light / `#1f1d1b` dark, `--paper`), **Ink** (`#14161a` / `#eaedf2`, `--ink`), **Ink Muted** (`#666d78`, `--ink-muted`), **Edge Strong** (`#c3bdac`, `--edge-strong`).

### Status
- **Mark** (`#b3261e`), **Flag** (`#a15c07`), **Ok** (`#1f6a45`) — destructive / grounding-warning / confirmed, unchanged from the product.

### Named Rules
**The One Door Rule.** `--brand`, `--brand-ink`, `--brand-muted`, and every `--land-*` token are used only by `.land-*` classes on the landing page. `--accent` (district blue) is used everywhere else. A component needing both is a sign the landing page and the app have blurred.

**The Gold-Means-Checked Rule.** Gold never decorates. It appears only on the seal and the one primary CTA — anywhere else a landing element wants emphasis, it earns lavender-on-violet or ink-violet-on-paper instead.

## Typography

**Body/UI Font:** Inter — used everywhere, including the landing page's nav, sub-copy, labels, and buttons.
**Mono Font:** JetBrains Mono — standard codes, citation tags, small caps meta, everywhere.
**Landing Display Font (landing-only):** Bricolage Grotesque, 800 weight, `clamp(2.5rem, 7vw, 5.5rem)`, −0.02em tracking — the headline only.
**Landing Quote Font (landing-only):** Source Serif 4, italic — used only for text that is quoting an actual document excerpt (the plan line, the cited standard), never for UI chrome.

**Character:** The pairing is deliberately mixed-register on purpose: a confident modern grotesque carries the brand's voice, while the serif italic signals "this is a real document being quoted," and the interface underneath both stays on the product's own workhorse Inter. Two new families, each with exactly one job, rather than a wholesale new type system.

### Hierarchy (landing-specific; product hierarchy is unchanged)
- **Landing Display** (800, `clamp(2.5rem, 7vw, 5.5rem)`, 1.05 line-height): the hero headline only.
- **Landing Heading** (700, `clamp(1.5rem, 3vw, 2rem)`): the "Every line traces back" section heading.
- **Landing Quote** (400 italic, `1.0625rem`/`--fs-lg`, serif): the plan excerpt and the cited standard text.
- **Label/Mono** (500, `--fs-xs`, uppercase, `--tracking-caps`): section tags, stage names, footer meta — unchanged from the product.

## Layout

The product is a fixed-height single-screen shell (`--app-h`) with `overflow-hidden` on `body`; the landing page owns its own internal `overflow-y: auto` region (`.land`) rather than the whole app scrolling.

The landing page alternates value across its four sections — violet (hero) → warm paper (proof) → violet (pipeline) → violet, slightly quieter (footer) — a deliberate density/value rhythm rather than one flat background the whole way down. The proof section's excerpt uses a three-column grid (`1fr 64px 1fr`) with an SVG connector in the center column on desktop, collapsing to a single stacked column with a short static rule on mobile. The pipeline is a single connected thread (an SVG line with three gold node-dots) rather than a card grid.

## Elevation & Depth

Flat by default, same as the product — no shadows on the landing page at all. The hero's only atmosphere is `.land-glow`, a single soft radial gold bloom behind the headline — a soft-edged radial gradient only, with no `filter: blur()` (a large blurred element inside a scrolling `overflow: hidden` ancestor is a known WebKit compositing bug that renders as tiled/duplicated content in Safari and WKWebView-based in-app browsers).

### Named Rules
**The Floating-Only Rule** (inherited from the product): a shadow that isn't on a popover, toast, dialog, or drawer is a bug. The landing page has none of those, so it has no shadows.

## Shapes

Small, consistent radii (`--r-sm` 5px) on the landing page's one button and mark; everything else is unbordered flat color fields, no card containers, no boxed grid.

## Components

### Buttons (product)
- Unchanged: `--accent` fill, white text, `--r-sm`.

### Landing CTA (`land-cta`)
- **Shape:** `--r-sm` (5px), no border.
- **Fill:** `--land-gold`, text in `--brand` (dark violet) for contrast.
- **Hover:** brightens to `--land-gold-bright`, lifts 1px. Exponential ease-out, not spring/bounce easing.
- **Focus:** the product's standard `--focus-ring` as a box-shadow.

### Verification Seal (signature component)
- An authored SVG: a circle plus a checkmark, both stroke-drawn via `stroke-dashoffset` animation on load (ring first, then check — one continuous gesture).
- Gold (`--land-gold`) on the violet hero; the darker `--land-gold-ink` wherever it sits on the paper section, to clear text-level contrast.
- Appears exactly twice: beside the hero headline's claim, and beside the cited standard in the proof section. Never used as generic decoration elsewhere.

### Pipeline Thread
- Three nodes (`--land-gold` dots) on a single horizontal line (vertical on mobile), each labeled in mono caps (`Retrieve` / `Generate` / `Audit` — named stages, not numbered markers, because the sequence is a real pipeline order).
- The line and dots draw in once, on scroll into view.

### Navigation (landing page)
- A quiet text "Sign in" link (underline-on-hover), not a second filled button — the page has exactly one filled action, the CTA.

## Do's and Don'ts

### Do:
- **Do** keep `--brand`/`--land-*` scoped to `.land-*` classes only; the app never uses them.
- **Do** use `--land-gold-ink`, not `--land-gold` or `--land-gold-bright`, for any gold text or stroke on the `--land-paper` section — the brighter golds fail contrast there.
- **Do** use exponential easing (`--ease-out`) for landing-page motion; reserve `--ease-spring` for the product's own tactile press feedback elsewhere.
- **Do** let the seal appear only where a claim is actually being verified.

### Don't:
- **Don't** let `--accent` (district blue) appear on the landing page, or `--brand`/gold appear inside the authenticated app.
- **Don't** add a card grid, bordered panes, or a second filled button to the landing page — one seal, one CTA, one thread.
- **Don't** add an eyebrow/kicker label above a heading.
- **Don't** stand in a Unicode arrow or emoji for an icon — draw it as inline SVG.
- **Don't** let the landing page follow `data-theme` — it is a fixed brand world by design.
