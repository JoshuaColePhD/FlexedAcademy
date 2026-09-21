# Voice teaching consultation

The lesson workspace now has a **Plan with voice** entry point. It opens a
compact audio strip directly above the existing composer. The teacher can talk through
learning goals, pacing, scaffolds and assessment, request a draft, and ask for
changes to a saved day, field or week without leaving the conversation.

## Behavior

- Voice uses the same grounded planning and revision services as text chat.
  Class, week, saved lesson, source evidence and prior answers inform the reply.
- The consultation prompt asks for specific professional judgment, short spoken
  turns and at most one useful question. It distinguishes advice from permission
  to edit and does not claim personal teaching experience.
- Conversation can continue while a lesson is being generated. A separate,
  bounded backend admission queue keeps a short voice reply from waiting behind
  the artifact job.
- Completed tool arguments identify edits. Partial function names cannot start
  a plan. Requested changes made during a build are collected in order, then
  reconsidered against the newly saved draft in a single follow-up turn. Advice
  alone does not enqueue a document edit.
- The composer keeps a single text input and its original shape and position.
  A compact strip above it shows measured microphone or playback audio, plus
  Mute, End and collapse controls. Silence is still; reduced motion disables
  waveform movement. Voice settings, including push-to-talk, live on the left.
- The left panel shows the current exchange and decisions. Earlier conversation
  is collapsed; routine saved-plan information and repeated suggestions are hidden
  while the document is visible. Pending work, questions and failures remain visible.
- A completed voice revision briefly highlights the changed fields and adds a
  small document receipt naming the affected days, with Undo. Undo compares the
  visible change with adjacent saved versions, then restores with an expected
  revision checked under a server row lock. Concurrent edits are not overwritten.
  The restore queues its replacement Word document in the same transaction.
- End releases the microphone, analysis context and connection. Navigation ends
  the session; creating the first chat preserves it. Ending voice during an Undo
  does not abandon the document save or leave editing locked.
- Saved transcripts remain ordinary chat history. Pending requests also appear
  there as the teacher's original words. The in-memory pending queue does not
  survive a reload; the teacher can ask to apply those requests from the transcript.

## Audio architecture

The browser connects to OpenAI Realtime over WebRTC using a short-lived credential
issued by the authenticated backend. Realtime handles input transcription and
spoken playback; the grounded chat endpoint remains the planning authority.
Automatic Realtime responses are disabled to avoid two competing assistants.
Speech replies are queued, and interruption cancels queued and buffered playback.
Long-lived API credentials never go to the browser.

The server and browser both configure an 800 ms hands-free silence window,
allowing a thinking pause while preserving immediate speech-start interruption.
The audio meter analyses the existing input and remote streams locally. It never
connects microphone audio to speakers, owns no media tracks, and closes its nodes
and AudioContext on teardown. The visible strip samples directly at about 25 Hz
without updating React state or rerendering the lesson. Unsupported analysis
leaves a quiet strip while voice remains usable.

The integration uses the existing `OPENAI_API_KEY`, `REALTIME_MODEL` and
`REALTIME_VOICE` configuration. Authentication, entitlement checks and the
20-minute client session limit remain in place. Audio usage reporting is still
client-reported, so it is operational telemetry rather than a tamper-proof billing
ledger. Capacity controls are per process; multi-process deployment needs shared
admission/accounting.

Provider references checked during implementation:
[Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
and [Realtime calls](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/create).
The pause setting follows [Realtime voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad).

## Local preview

With the Vite development server on port 5174, open:

`http://127.0.0.1:5174/preview.html?fresh=0&persist=1&voice=1&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1`

Click **Plan with voice**, then use the composer's labelled practice input to send
a sample spoken idea. The opt-in preview transport runs only in the separate
development preview entry on localhost. It makes no microphone request, provider
connection or paid model call. The waveform samples in preview are explicitly simulated, and the lesson and replies are fixtures, so this
demonstrates interaction and lifecycle rather than model quality or real latency.
The preview flag persists within that tab across reloads; `voice=0` turns it off.

## Validation and remaining live acceptance

Run `npm run test:voice:runtime` for audio sampling, resource cleanup, provider
lifecycle, consultation queuing, field-level change descriptions and Undo guards.
Browser coverage lives in `voice-consultation.spec.js`, `voice-composer-motion.spec.js`,
`voice-plan-feedback.spec.js`, and `chat-composer-clearance.spec.js`. It covers
first-chat continuity, ordered pending edits, draft preservation, reduced motion,
responsive controls, saved-version Undo, a conflicting write and End during Undo.
Backend checks use mocked providers and disable external network access in
`backend/conftest.py`.

A live acceptance pass still needs a disposable local/staging account and database,
configured provider access, and a teacher deliberately enabling the microphone.
Check actual transcription of course terminology, interruption while audio plays,
school-network WebRTC connectivity, response latency, pacing of the expert dialogue,
and whether the generated revisions preserve instructional constraints. Repeat on
the target mobile browser. Production data and paid API calls were not used for
the localhost preview.
