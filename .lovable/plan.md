## Preview status
I checked dev server logs and runtime errors — both are clean. No syntax/build error from your edits. The preview likely just needs a reload; if it still fails after a hard refresh, share the exact console error and I'll dig in.

## Fixes

### 1. Multi-summary OFF by default
- `defaultSession()` already sets `multiMode: false`; you're seeing it ON because it was persisted in `localStorage`. Fix by always coercing `multiMode` to `false` on load when there are 0 or 1 cards (i.e. no reason to be in multi mode yet). User can still toggle it on manually.

### 2. Bottom box gets the same controls as the top box
- Remove the `!compact` gate around the options row in `InputCard` so the bottom card also shows Length / Auto (⚡) / Multi / Recent / Theme.
- Keep `compact` only for its current useful purpose: local `url` state so the bottom box isn't tied to `session.input.url`.
- Result: bottom box always starts empty (already true in compact mode via `localUrl`), and after auto-summarize on paste we also clear `localUrl` so it's immediately ready for the next paste.

### 3. Scroll to the beginning of the NEW summary
- Today, after a successful summarize we scroll to `topRef` (the top of the whole app).
- Change: for a newly created card, scroll to that card's own top (attach a ref keyed by card id). For a regenerated card, keep scroll on that card.
- The global synthesis keeps its own scroll target.

### 4. Stop the global summary while it's generating
- Add an `AbortController` + cancel flag for the global run (mirrors per-card `cancelFlags`).
- While `global.status === "loading"`, the "Generate global synthesis" button becomes a **Stop** button (spinner + Stop label, same style as the per-card Stop). Click aborts and returns status to `idle`/`stale`.

### 5. Dedup transcript-block errors in multi mode
- When several cards fail with the same YouTube-blocking error message, show it only **once** as a single banner above the card list ("YouTube blocked N transcript requests — try again in a few minutes or use the in-browser fallback"), and hide the identical per-card red boxes. Non-blocking errors (no captions, parse errors, etc.) still show per-card as today.
- Detection: same normalized error string on ≥ 2 cards → collapse.

### 6. Chat answers from full transcript + general knowledge (not the summary)
- Chat already receives the full transcript (not the summary), so that part is correct.
- Loosen the system prompt in `chatAboutVideo` (`src/lib/api/summarize.functions.ts`) so the model:
  - primarily uses the transcript,
  - may add relevant general knowledge to go deeper than the summary,
  - clearly labels anything that goes beyond the transcript (e.g. "Beyond the video: …") so the user knows what's sourced vs inferred,
  - still says so briefly when the transcript doesn't cover a question.
- No live web search yet (would need a search API + cost). Called out here so we don't silently pretend to browse. Happy to wire real web search in a later round (Tavily / Brave / Exa via the Gateway) if you want.

### 7. Small consistency tweaks that fall out of the above
- After a paste-triggered auto-submit in the bottom (compact) box, clear `localUrl` so the field is empty for the next paste.
- Top box: keep the pasted URL (already done in the last round) — unchanged.

## Files touched
- `src/routes/index.tsx` — session load coercion (multiMode), remove `!compact` gate, per-card scroll ref, global Stop button + abort flag, dedup error banner, clear bottom `localUrl` after auto-submit.
- `src/lib/api/summarize.functions.ts` — updated `chatAboutVideo` system prompt (transcript-first + general knowledge with labelling).
- `src/lib/session-store.ts` — small coercion in `loadSession` for `multiMode` when cards.length < 2.

No new deps, no backend/schema changes.

## Parked (unchanged from last round)
- Real web search inside chat (needs an external API).
- Mermaid/SVG diagram mode for tutorials.
- Client-side transcript fetching as the default path (currently only a manual fallback).
- Browser extension + Windows desktop wrapper.
- Auto-refresh model IDs every 2 months (dormant reminder).
