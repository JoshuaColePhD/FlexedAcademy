/** @type {import('tailwindcss').Config} */

/* Every colour here reads from src/styles/tokens.css rather than restating a
   palette. This file used to declare its own cream-and-amber set while
   tokens.css declared a different one, and since the components are written in
   Tailwind classes it was this file that won — which is why the app rendered in
   a palette no design document described, and why the dark theme wired up in
   index.html and tokens.css could never take effect.
   There is one palette now, in tokens.css, and both systems read it.

   Colours are composed from channel triplets so the alpha modifiers the
   components rely on (`bg-paper/50`, `border-accent/30`) keep working. */
const c = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`

import { screens } from './src/lib/breakpoints.js'

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    /* REPLACES Tailwind's defaults rather than extending them, so `sm:` means
       480 and not 640. Every existing sm: in this app is "hide a secondary
       label on a phone" — a tablet-sized 640 was never what any of them meant.
       Same file tailwind and useMediaQuery both read; see lib/breakpoints.js. */
    screens,
    extend: {
      colors: {
        /* surfaces */
        paper: c('paper'),
        'paper-raised': c('paper-raised'),
        'paper-sunken': c('paper-sunken'),
        'paper-inset': c('paper-inset'),

        /* hairlines */
        edge: c('edge'),
        'edge-strong': c('edge-strong'),

        /* ink */
        ink: c('ink'),
        'ink-soft': c('ink-soft'),
        'ink-muted': c('ink-muted'),
        'ink-faint': c('ink-faint'),
        'ink-inverse': c('ink-inverse'),

        /* signals — tokens.css defines what each is allowed to mean.
           Note `accent` is a FILL only; use `accent-text` for words. */
        accent: c('accent'),
        'accent-hover': c('accent-hover'),
        'accent-tint': c('accent-tint'),
        'accent-text': c('accent-text'),
        'doc-blue': c('doc-blue'),
        mark: c('mark'),
        'mark-tint': c('mark-tint'),
        flag: c('flag'),
        'flag-tint': c('flag-tint'),
        ok: c('ok'),
        'ok-tint': c('ok-tint'),
      },

      fontFamily: {
        /* Inter runs the whole interface. There is no display face: the serif
           greeting it existed for went with the week board. */
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      /* The one column width the chat surface shares. Applying it to the
         greeting, the composer and the message list is what lets the composer
         move from the centre of an empty screen to the footer without changing
         width — which in turn keeps its ResizeObserver quiet. */
      maxWidth: {
        measure: 'var(--measure)',
        'measure-form': 'var(--measure-form)',
        'measure-wide': 'var(--measure-wide)',
      },

      /* h-app instead of h-screen. 100vh on iOS Safari is taller than the
         visible viewport, which is what puts a bottom-docked composer under the
         browser chrome; --app-h resolves to 100dvh where that exists. */
      height: { app: 'var(--app-h)' },
      minHeight: { app: 'var(--app-h)', touch: 'var(--touch-min)' },
      minWidth: { touch: 'var(--touch-min)' },

      spacing: {
        gutter: 'var(--gutter)',
        'safe-t': 'var(--safe-t)',
        'safe-b': 'var(--safe-b)',
        tabbar: 'var(--tabbar-h)',
      },

      backgroundImage: { 'hatch-closed': 'var(--hatch-closed)' },

      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        pop: 'var(--shadow-pop)',
        panel: 'var(--shadow-panel)',
      },

      borderRadius: {
        xs: 'var(--r-xs)',
        sm: 'var(--r-sm)',
        DEFAULT: 'var(--r-md)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
      },

      letterSpacing: {
        caps: 'var(--tracking-caps)',
        display: 'var(--tracking-display)',
      },

      transitionTimingFunction: {
        out: 'var(--ease-out)',
        spring: 'var(--ease-spring)',
      },

      keyframes: {
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
        /* Played once, on the render where the first message lands, so the
           composer reads as settling into the footer rather than teleporting
           there. See the dock comment in ChatPage. */
        'dock-settle': {
          '0%': { opacity: '0.6', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'rise-in': 'rise-in var(--t-slow) var(--ease-out) both',
        'dock-settle': 'dock-settle var(--t-base) var(--ease-out) both',
      },
    },
  },
  plugins: [],
}
