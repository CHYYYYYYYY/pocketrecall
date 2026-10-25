# PocketRecall — current handoff

Updated 2026-10-24 (Pacific). Continue this repository, currently `/Users/edisonliu/Documents/ChatGPT/ucsdhackathon`. The earlier local project was `/Users/edisonliu/Documents/Codex/2026-10-24/new-chat/pocketrecall`; both Git histories were preserved by merge `e59440d` on `codex/product-completion`. Do not overwrite either history or force-push.

The user authorized implementation and GitHub synchronization. Priority: **real video → persistent 3D memory → real-time voice with video streaming**. The webpage simulates glasses. English UI and spoken replies; warm paper, charcoal and restrained orange. Keep the README short.

## Run and inspect

Node 22+, `npm ci`, `npm start`, then `/run`. `ws` is the single runtime dependency. The ignored `.env.local` has a Gemini key; do not expose or commit it. `FAL_KEY` has not been supplied. The app is intentionally bound to loopback.

[HACKATHON.md](HACKATHON.md) contains the current walkthrough, architecture, adapter contracts and limits. [VALIDATION.md](VALIDATION.md) records real checks separately from mocks. [RELATED_WORK.md](RELATED_WORK.md) covers EgoRecall and related tasks without claiming SOTA.

## Main files

- `server.mjs`: local HTTP/static service, Live WebSocket attachment.
- `lib/run-session.mjs`: real/synthetic/imported sources, archive/restore, observation lifecycle, maps and wearer pose.
- `lib/live-voice.mjs`: server-only Gemini Live setup, audio/video bridge, memory tools, session cancellation and transcript-gated possession confirmation.
- `lib/memory-agent.mjs`: command routing / constrained Gemini plan → memory tools → evidence-backed response.
- `lib/spatial/{store,pipeline,geometry,alignment,capture-geometry}.mjs`: immutable memory, atomic map publication, coordinate transforms and localization guards.
- `public/run{,-live,-feedback,-map}.js`: actual application, AudioWorklet voice, feedback and Canvas map.
- `public/assets/review/`: attributed real TUM RGB-D video/images/depth/poses and recorded Gemini predictions. No future sightings are seeded into runtime memory.
- `public/assets/ledger/`, `scripts/prepare-ledger.py`, `lib/ledger-source.mjs`: real HD-EPIC kitchen, replayed LEDGER object positions, progressive reference cloud, generated user questions. Read its attribution; units are relative and poses approximate zero roll. **Watch kitchen + conversation** runs four actual Live turns without a microphone; the no-key mode is labeled tools + browser speech.
- `scripts/judge-ledger.mjs`: all 41 samples, absence/return/past-only history, map persistence and optional four actual spoken Live turns.
- `scripts/judge-demo.mjs`: real HTTP replay and optional live vision/voice rehearsal with generated speech. It does not activate a physical microphone.

## Verification and boundaries

Run `npm test`, `npm run check`, `npm run demo`, `npm run smoke`, `npm run judge`, `npm run judge:kitchen`, and rebuild `npm run preview:build` after frontend changes. CI must reproduce the preview byte-for-byte. `npm run judge:live` and `npm run judge:kitchen:live` consume Gemini quota and write ignored reports/audio.

Preserve image hashes, capture-time pose binding, units and map identity. Language models cannot supply coordinates. Independent recordings are not automatically relocalized into a shared room. Live fal, physical tracking, human barge-in/acoustic echo and wearable haptics still need validation. The existing successful Live test streams generated PCM and real sample JPEGs through the real provider, not a physical microphone.

Do not treat old documentation about `EPERM`, DNS failure, key billing failures or an incomplete remote baseline as current evidence; these were superseded by this environment's successful tests. Inspect live Git/CI state before further publication.
