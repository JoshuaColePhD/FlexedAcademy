# FlexEd Academy — frontend

React 19 + Vite. Chat-shaped UI over the RAG backend: describe a week, get a
lesson plan grounded in real standards documents plus the Florence City Schools
`.docx`.

## Running it

The backend must be up first — `./run.sh` in the project root (port 8010 — 8000 is taken by the local oMLX server).

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

`vite.config.js` proxies `/api` to `127.0.0.1:8010`, so the app is same-origin in
development and no API host is hardcoded anywhere. For a deployed build, set
`VITE_API_URL` to the backend's origin.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on 5173 with the `/api` proxy |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the built output |
| `npm run lint` | oxlint |
| `npm run check` | lint + tokens + classes + buttons inventory + build |
| `npm run check:buttons` | Every button in the source is accounted for in `buttons.json` |
| `npm run test:buttons` | Clicks every button in a real browser (needs `npm run dev` running) |

## Layout

```
src/
├── App.jsx              router + shell (sidebar, chats, settings, theme)
├── lib/
│   ├── api.js           the only place that talks to the backend
│   └── partialJson.js   completes JSON that is still streaming in
├── hooks/
│   ├── useLessonStream.js  SSE reader, AbortController, live preview
│   ├── useTheme.js         light | dark | system
│   └── useToast.jsx        toast region (replaces alert())
├── components/
│   ├── Citation.jsx        standard codes as verifiable citations
│   ├── LessonPlanTable.jsx mirrors template florence-docx-v2
│   ├── Marginalia.jsx      grounding warnings
│   ├── ArtifactPanel.jsx   resizable plan panel
│   ├── Composer.jsx        input, dictation, attachments
│   ├── Message.jsx         copy / edit / retry
│   ├── Sidebar.jsx         nav + chat list
│   ├── ThemeToggle.jsx
│   └── ErrorBoundary.jsx
├── pages/               ChatPage · PlansPage · StandardsPage · MyClassPage · NotFoundPage
└── styles/              tokens.css · base.css · components.css
```

## Design notes

Academic/editorial: warm unbleached paper, ink text, one claret accent. Newsreader
for display, Source Sans 3 for UI, IBM Plex Mono for standard codes — codes are
identifiers, so they read as identifiers.

The district's own blue (`#6D9EEB`, the literal value in
`build_lesson_plan.py`) is scoped to the artifact table only, so the preview reads
as the document it produces. That table stays a light document in dark mode on
purpose — it is a preview of a printed page.

The signature element is the grounding apparatus: every standard code is a
citation you can open to see the verbatim standard, its source document, and its
page. A code retrieval never supplied is marked in claret with a reference mark,
and grounding warnings sit in the margin. That traceability is what the app is
for, so it is what the design foregrounds.

All colours come from `tokens.css`. Both themes are defined there; `useTheme`
resolves `system` itself and writes a concrete `data-theme` onto `<html>`, so the
CSS needs only one dark selector.

## Looking at the UI without a backend

`preview.html` boots the real app against a canned API (`src/dev/mockApi.js`) —
one class, one chat, one week with a deliberately ungrounded code in it. Use it
to work on layout, theming and the in-cell tweak flow without pointing the app
at the live Supabase database or spending OpenAI credits on a revision.

```
npm run dev        # then open http://localhost:5174/preview.html
```

Dev-only: Vite builds `index.html`, so nothing under `src/dev/` reaches the
production bundle.

## Are the buttons working?

`preview.html` is also what the button suite drives, which is why `src/dev/` is
no longer disposable.

```
npm run dev &          # the harness has to be up
npm run test:buttons   # clicks every button on every route
```

Every button gets the same four checks — it has an accessible name; clicking it
throws nothing and doesn't reach the ErrorBoundary; it calls no endpoint
`mockApi.js` doesn't recognise; and *something happens* (a request, a
navigation, or a DOM change). A short list in `scripts/test-buttons.mjs` pins
the exact request a few load-bearing buttons must issue.

`npm run check:buttons` is the static half: it inventories every `<button>` in
the source into `buttons.json` and fails when that drifts, so adding a button
without covering it is a thing you have to do on purpose. After deliberately
adding one:

```
npm run check:buttons -- --update
```

Both run in CI — the inventory inside `npm run check`, the browser suite as its
own `buttons` job in `.github/workflows/quality.yml`.
