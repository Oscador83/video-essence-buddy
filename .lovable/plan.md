# Plan — next iteration

## 1. Full session persistence (fixes resize-resets-everything)
Persist the entire app state to `localStorage` and rehydrate on mount, so resizing the Lovable preview (or refreshing the tab) never loses work.

Persisted keys (single namespaced object `osvidsum:session:v1`):
- Current input value, length, custom instructions, toggles.
- All summary cards in multi-mode (text, metadata, transcript, generated image as base64, chat history per card).
- Global summary card (text + image + chat) when present.
- Theme, auto-summarize toggle, multi-summary toggle.

Recent-history list stays on its existing key. Storage budget: warn (non-blocking) if total >4MB; offer "Reset all" to clear.

## 2. Auto-summarize on paste/drop + Stop button + Custom instructions
- **Auto-summarize toggle** (default ON, persisted), shown in the controls card.
- When ON: pasting a valid YouTube URL into the input, or dropping one, triggers `summarizeVideo` immediately — no button click needed.
- **Summarize button becomes Stop** while a generation is in-flight (uses `AbortController` passed into the fetch). Clicking Stop cancels the request and clears the loading state; partial results discarded.
- Clicking Summarize after a summary is shown = retry/regenerate (replaces current in single mode; replaces *that card* in multi mode).
- **Custom instructions textarea** under the length selector. Small, single-line-feel, expands as you type. Appended to the system prompt as `USER CUSTOM INSTRUCTIONS (apply if compatible): "<text>"`. Persisted per session. Empty = current behavior.
- Chatbox remains separate — for post-hoc Q&A, not for steering generation.

## 3. Decouple visual summary from text-summary lifecycle
- Visual generation snapshots the text summary at click time and runs independently.
- Changing the length selector, regenerating the text summary, or editing custom instructions while an image is generating no longer cancels the image.
- Each card tracks `visualStatus: idle | generating | done | error` independently of `textStatus`.
- Still derived from the text summary (cleaner input than raw transcript) — but lifecycle is fully decoupled.

## 4. Fix Download PNG (no more "opens Google Calendar")
- Replace the `<a href="data:..." download>` pattern with a programmatic Blob download:
  - Convert base64 → Blob → `URL.createObjectURL` → click a synthesized `<a>` → `URL.revokeObjectURL`.
- Stop propagation on the click handler so no parent listener can hijack it.
- Filename: `osvidsum-<videoId>-<detail>.png`.

## 5. "Open image in new window" button
- Adds a button next to Download in the image viewer toolbar.
- Opens the image as a Blob URL in a new tab (`window.open(blobUrl, "_blank")`), not a `data:` URL (some browsers block large data URLs).

## 6. Image 504 mitigation
- Cap the summary text sent to the image route at ~2000 chars (was 4000) — denser prompts time out more often.
- One automatic retry on 504/timeout (with a 2s backoff) before surfacing an error.
- Friendlier message on failure: *"The image service timed out. Try again, or use a lighter detail level."*
- Not a daily quota — confirm to the user in the error copy.

## 7. Save button — self-contained HTML document
- "Save" button appears once a summary exists.
- Generates a single `.html` file containing:
  - Video title, author, link back to YouTube.
  - Text summary rendered from Markdown (server-side via `marked` already in deps, or a tiny inline renderer).
  - Generated image inlined as `<img src="data:image/png;base64,...">` if present.
  - Inline `<style>` for clean print → PDF.
  - Footer with `OSVidSum` mark + generation date + model labels.
- Filename: `osvidsum-<videoId>.html`. Triggered via Blob download (same helper as point 4).
- In multi-mode the per-card Save button saves that card; the Global Save button saves a combined document.

## 8. Multi-summary mode (full build)
**Toggle** "Multi-summary" — default OFF, persisted. Visible on both the top controls card and the bottom input. Toggling either updates both.

### Behavior when ON
- Each new summary appends as a new card below previous cards (newest at bottom, with a smooth scroll to it).
- Each card has its own header (title, length, generated-at), text summary, optional visual, chat, Save, and a **Clear** (✕) button to remove just that card.
- Pasting/dropping a URL into an existing card's input replaces *that card* only (confirm if it was non-trivial work — small dialog).
- A persistent "Add another video" input stays at the bottom (always empty placeholder, drag-and-drop enabled).
- **Reset all** button in the top controls clears every card after a confirm.

### Global section (appears once ≥2 cards exist)
Rendered above the "Add another video" input:
- **Global Summary** button → calls a new server fn `summarizeMany`.
- **Global Visual** button → reuses the visual route with the global summary as input.
- **Global Save** button → combined HTML doc (all cards + global summary + global image).
- **Global Chat** box → Q&A scoped to the combined material.
- Input choice for global generation: by default uses the **individual summaries** (faster, cheaper, already structured). An "Use full transcripts (deeper, slower)" checkbox switches to transcripts.

### Global staleness
- After Global is generated, adding/clearing a card does NOT auto-invalidate it, but shows a subtle banner above the global card: *"New summaries added — regenerate global?"* with a Regenerate button.

### Turning the toggle OFF
- If ≥2 cards exist, a confirm: *"This will clear N summaries and the global section. Continue?"*
- If confirmed, all but the topmost card is removed and the global section is cleared.

## 9. Transcript fallback improvements (point 10)
- Add 2 more CORS proxies to the rotation (`r.jina.ai`, `cors.lol`) → 4 total.
- Differentiate error messages:
  - All proxies returned 4xx with "no captions" signal → *"This video doesn't have captions available."*
  - All proxies blocked/timed out → *"YouTube and the public proxies are all blocking transcript requests right now. Try again in a few minutes."*
- **Manual transcript fallback** (last resort): a small "Paste transcript manually" link in the error block. Opens a textarea; user pastes from YouTube's own transcript panel; we send it to `summarizeWithTranscript` directly.
- Clarify in the in-browser fallback help text: *"This fetches the transcript via public proxies — it doesn't read the video from your browser tabs."* (Answering the "is it using my open video?" confusion.)

## 10. Bottom box pre-filled fix
Audit both input boxes: ensure `value=""` initial state and a real `placeholder`. Same fix already applied to the top box, now applied to the bottom "Add another video" box.

---

## Out of scope (parking lot, future)
- Browser extension + custom cursor + click-a-video-to-summarize flow.
- Desktop app packaging.
- Mermaid / SVG "diagram mode" as a second visual type (text-model-generated diagrams).
- Auto-updating model IDs (60-day dormant reminder already covers this manually).
- Accounts + cross-device sync for summaries.
- Real PDF export (current plan ships HTML; PDF is a future upgrade if needed).
- AI-driven custom instructions through the chatbox (current plan uses a textarea; chatbox→summary plumbing deferred).

---

## Technical notes
**Files touched**
- `src/routes/index.tsx` — biggest churn: persistence, multi-card state machine, auto-summarize, Stop/Abort, custom instructions field, global section, Save button, image viewer toolbar fixes.
- `src/lib/api/summarize.functions.ts` — accept `customInstructions` on `summarizeVideo` / `summarizeWithTranscript`; new `summarizeMany` server fn (accepts array of `{summary,title}` or `{transcript,title}` + length).
- `src/routes/api/generate-visual-summary.ts` — cap prompt at 2k chars, surface friendlier timeout error, allow one retry.
- New: `src/lib/session-store.ts` — typed `loadSession()` / `saveSession()` / `clearSession()` over `localStorage` with a schema version.
- New: `src/lib/download.ts` — `downloadBlob(filename, blob)` + `imageDataUrlToBlob(dataUrl)` helpers.
- New: `src/lib/save-html.ts` — builds the self-contained HTML document.
- `src/lib/proxies.ts` (or wherever the proxy list lives) — add `r.jina.ai`, `cors.lol`; better error classification.

**No new dependencies** required (Markdown renderer can be a tiny inline function; `marked` already pulled in if present — verify on implementation, else use a 20-line renderer).

**No backend / DB / schema changes.**

**State shape** (rough):
```ts
type Card = {
  id: string;
  videoId: string | null;
  url: string;
  length: "short" | "standard" | "detailed";
  customInstructions: string;
  title: string | null;
  author: string | null;
  transcript: string | null;
  detectedLang: string | null;
  textStatus: "idle" | "loading" | "done" | "error";
  text: string | null;
  textError: string | null;
  visualStatus: "idle" | "loading" | "done" | "error";
  visualDataUrl: string | null;
  visualDetail: "simple" | "medium" | "detailed";
  visualError: string | null;
  chat: Array<{ role: "user" | "assistant"; content: string }>;
};

type Session = {
  v: 1;
  autoSummarize: boolean;
  multiMode: boolean;
  theme: "light" | "dark";
  cards: Card[];
  global: {
    status: "idle" | "loading" | "done" | "error" | "stale";
    summary: string | null;
    visual: string | null;
    chat: Array<{ role: "user" | "assistant"; content: string }>;
    useTranscripts: boolean;
  } | null;
};
```

---

Ready when you approve. If anything in the multi-summary spec doesn't match what you had in mind, flag the specific item and I'll adjust before building.
