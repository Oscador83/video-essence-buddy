import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createParser } from "eventsource-parser";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  summarizeVideo,
  summarizeWithTranscript,
  translateSummary,
  chatAboutVideo,
  summarizeMany,
} from "@/lib/api/summarize.functions";
import { TEXT_MODEL_LABEL, IMAGE_MODEL_LABEL } from "@/lib/models";
import {
  type Card,
  type ChatMsg,
  type Detail,
  type GlobalSection,
  type Length,
  type Session,
  defaultSession,
  loadSession,
  makeEmptyGlobal,
  makeFilledCard,
  saveSession,
} from "@/lib/session-store";
import { downloadBlob, openImageInNewTab, dataUrlToBlob } from "@/lib/download";
import { buildHtmlDoc } from "@/lib/save-html";
import { fetchTranscriptViaProxy } from "@/lib/proxies";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OSVidSum — AI YouTube video summaries" },
      {
        name: "description",
        content:
          "Paste a YouTube URL, get an AI summary in the video's language. Translate, visualize, chat, save.",
      },
    ],
  }),
  component: Index,
});

const POPULAR_LANGS = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Japanese",
  "Chinese (Simplified)",
  "Hindi",
  "Arabic",
];
const LENGTH_OPTIONS = [
  { value: "short", label: "Short" },
  { value: "standard", label: "Standard" },
  { value: "detailed", label: "Detailed" },
] as const;
const DETAIL_OPTIONS = [
  { value: "simple", label: "Simple" },
  { value: "medium", label: "Medium" },
  { value: "detailed", label: "Detailed" },
] as const;

const HISTORY_KEY = "yt-summarizer-history";
const MODEL_CHECK_KEY = "yt-summarizer-last-model-check";
const MODEL_REMINDER_DISMISSED_KEY = "yt-summarizer-model-reminder-dismissed";
const MAX_HISTORY = 10;
const MODEL_CHECK_INTERVAL_MS = 60 * 24 * 60 * 60 * 1000;

type HistoryItem = {
  url: string;
  videoId: string;
  title?: string | null;
  ts: number;
};

function extractVideoIdClient(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      const idx = parts.findIndex((p) => ["shorts", "embed", "live"].includes(p));
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function Index() {
  // ============ State (persisted) ============
  const [session, setSession] = useState<Session>(() => defaultSession());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setSession(loadSession());
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) saveSession(session);
  }, [session, hydrated]);

  const updateSession = useCallback(
    (fn: (s: Session) => Session) => setSession((s) => fn(s)),
    [],
  );
  const updateCard = useCallback(
    (id: string, patch: Partial<Card> | ((c: Card) => Partial<Card>)) =>
      setSession((s) => ({
        ...s,
        cards: s.cards.map((c) =>
          c.id === id ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c,
        ),
      })),
    [],
  );
  const updateGlobal = useCallback(
    (patch: Partial<GlobalSection>) =>
      setSession((s) => ({
        ...s,
        global: s.global ? { ...s.global, ...patch } : { ...makeEmptyGlobal(), ...patch },
      })),
    [],
  );

  // Theme
  useEffect(() => {
    document.documentElement.classList.toggle("dark", session.theme === "dark");
  }, [session.theme]);

  // ============ Non-session state ============
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showModelReminder, setShowModelReminder] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Per-card cancellation flags + abort controllers
  const cancelFlags = useRef<Map<string, boolean>>(new Map());
  const visualAborts = useRef<Map<string, AbortController>>(new Map());
  const globalCancelRef = useRef<{ text: boolean; visual: AbortController | null }>({
    text: false,
    visual: null,
  });

  useEffect(() => {
    try {
      const h = localStorage.getItem(HISTORY_KEY);
      if (h) setHistory(JSON.parse(h));
    } catch {
      /* ignore */
    }
    try {
      const last = Number(localStorage.getItem(MODEL_CHECK_KEY) ?? 0);
      const dismissed = Number(localStorage.getItem(MODEL_REMINDER_DISMISSED_KEY) ?? 0);
      const now = Date.now();
      if (!last) {
        localStorage.setItem(MODEL_CHECK_KEY, String(now));
      } else if (
        now - last > MODEL_CHECK_INTERVAL_MS &&
        now - dismissed > MODEL_CHECK_INTERVAL_MS
      ) {
        setShowModelReminder(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Server fns
  const summarize = useServerFn(summarizeVideo);
  const summarizeFromTranscript = useServerFn(summarizeWithTranscript);
  const translate = useServerFn(translateSummary);
  const chat = useServerFn(chatAboutVideo);
  const summarizeManyFn = useServerFn(summarizeMany);

  // ============ History helpers ============
  const pushHistory = useCallback((item: { url: string; videoId: string; title?: string | null }) => {
    setHistory((prev) => {
      const next = [
        { ...item, ts: Date.now() },
        ...prev.filter((p) => p.videoId !== item.videoId),
      ].slice(0, MAX_HISTORY);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  };

  // ============ Core: run summarize for a card (existing or new) ============
  // mode: "new" creates/replaces; "regenerate" reuses cardId.
  const runSummarize = useCallback(
    async (opts: {
      url: string;
      length: Length;
      customInstructions: string;
      cardId?: string; // if provided → regenerate that card
    }) => {
      const url = opts.url.trim();
      if (!url) return;
      const vid = extractVideoIdClient(url);

      let targetId = opts.cardId;
      if (!targetId) {
        // Create a new card or replace cards[0] depending on mode
        const newCard = makeFilledCard({
          url,
          length: opts.length,
          customInstructions: opts.customInstructions,
          videoId: vid,
          textStatus: "loading",
        });
        targetId = newCard.id;
        setSession((s) => {
          if (s.multiMode) {
            return { ...s, cards: [...s.cards, newCard], global: s.global ? { ...s.global, status: "stale" } : null };
          }
          return { ...s, cards: [newCard] };
        });
      } else {
        // Regenerate existing card
        updateCard(targetId, {
          url,
          length: opts.length,
          customInstructions: opts.customInstructions,
          videoId: vid,
          textStatus: "loading",
          textError: null,
          text: null,
          translated: null,
          transcript: null,
        });
      }

      cancelFlags.current.set(targetId, false);

      try {
        const result = await summarize({
          data: {
            url,
            length: opts.length,
            customInstructions: opts.customInstructions || undefined,
          },
        });
        if (cancelFlags.current.get(targetId)) return;
        updateCard(targetId, {
          textStatus: "done",
          text: result.summary,
          videoId: result.videoId,
          title: result.title,
          author: result.author,
          detectedLang: result.detectedLang,
          transcript: result.transcript,
          textError: null,
        });
        pushHistory({ url, videoId: result.videoId, title: result.title });
        setTimeout(
          () => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
          100,
        );
      } catch (err) {
        if (cancelFlags.current.get(targetId)) return;
        const msg = err instanceof Error ? err.message : String(err);
        updateCard(targetId, { textStatus: "error", textError: msg });
      }
    },
    [summarize, updateCard, pushHistory],
  );

  // ============ Stop summarization ============
  const stopSummarize = useCallback(
    (cardId: string) => {
      cancelFlags.current.set(cardId, true);
      updateCard(cardId, { textStatus: "idle" });
    },
    [updateCard],
  );

  // ============ Fallback (CORS-proxy transcript fetch) ============
  const [fallbackBusy, setFallbackBusy] = useState<string | null>(null);
  const runFallback = useCallback(
    async (card: Card) => {
      const vid = card.videoId ?? extractVideoIdClient(card.url);
      if (!vid) return;
      setFallbackBusy(card.id);
      updateCard(card.id, { textStatus: "loading", textError: null });
      try {
        const result = await fetchTranscriptViaProxy(vid);
        if (result.kind === "no-captions") {
          updateCard(card.id, {
            textStatus: "error",
            textError:
              "This video doesn't have captions available. The summarizer needs captions/subtitles to work.",
          });
          return;
        }
        if (result.kind === "all-blocked") {
          updateCard(card.id, {
            textStatus: "error",
            textError:
              "YouTube and the public proxies are all blocking transcript requests right now. Try again in a few minutes, or paste the transcript manually.",
          });
          return;
        }
        const meta = (await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)) as { title?: string; author_name?: string } | null;

        const data = await summarizeFromTranscript({
          data: {
            videoId: vid,
            transcript: result.transcript,
            length: card.length,
            title: meta?.title ?? null,
            author: meta?.author_name ?? null,
            detectedLang: result.lang,
            customInstructions: card.customInstructions || undefined,
          },
        });
        updateCard(card.id, {
          textStatus: "done",
          text: data.summary,
          videoId: data.videoId,
          title: data.title,
          author: data.author,
          detectedLang: data.detectedLang,
          transcript: data.transcript,
          textError: null,
        });
        pushHistory({ url: card.url, videoId: vid, title: data.title });
      } catch (err) {
        updateCard(card.id, {
          textStatus: "error",
          textError: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setFallbackBusy(null);
      }
    },
    [summarizeFromTranscript, updateCard, pushHistory],
  );

  // ============ Manual transcript paste ============
  const submitManualTranscript = useCallback(
    async (card: Card, manualText: string) => {
      const vid = card.videoId ?? extractVideoIdClient(card.url);
      if (!vid || manualText.trim().length < 20) return;
      updateCard(card.id, { textStatus: "loading", textError: null });
      try {
        const data = await summarizeFromTranscript({
          data: {
            videoId: vid,
            transcript: manualText.trim(),
            length: card.length,
            title: card.title,
            author: card.author,
            detectedLang: null,
            customInstructions: card.customInstructions || undefined,
          },
        });
        updateCard(card.id, {
          textStatus: "done",
          text: data.summary,
          transcript: data.transcript,
          textError: null,
        });
        pushHistory({ url: card.url, videoId: vid, title: data.title });
      } catch (err) {
        updateCard(card.id, {
          textStatus: "error",
          textError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [summarizeFromTranscript, updateCard, pushHistory],
  );

  // ============ Visual generation (per card) ============
  const generateVisual = useCallback(
    async (cardOrGlobal: { id: string } | "global", detail: Detail) => {
      const isGlobal = cardOrGlobal === "global";
      const summaryText = isGlobal
        ? session.global?.summary
        : session.cards.find((c) => c.id === (cardOrGlobal as { id: string }).id)?.text;
      const title = isGlobal
        ? "Global synthesis"
        : session.cards.find((c) => c.id === (cardOrGlobal as { id: string }).id)?.title;
      if (!summaryText) return;

      // Abort any in-flight for this target
      const key = isGlobal ? "__global__" : (cardOrGlobal as { id: string }).id;
      visualAborts.current.get(key)?.abort();
      const ac = new AbortController();
      visualAborts.current.set(key, ac);

      const patch = (p: Partial<Card>) =>
        isGlobal
          ? updateGlobal({
              visualStatus: p.visualStatus,
              visualSrc: p.visualSrc ?? undefined,
              visualFinal: p.visualFinal,
              visualDetail: p.visualDetail,
              visualError: p.visualError ?? null,
            } as Partial<GlobalSection>)
          : updateCard((cardOrGlobal as { id: string }).id, p);

      patch({
        visualOpen: true,
        visualStatus: "loading",
        visualSrc: null,
        visualFinal: false,
        visualError: null,
        visualDetail: detail,
      });

      try {
        const res = await fetch("/api/generate-visual-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary: summaryText, title, detail }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(
            `${await res.text().catch(() => "Image generation failed")} (${res.status})`,
          );
        }
        let sawCompleted = false;
        const parser = createParser({
          onEvent(event) {
            if (
              event.event !== "image_generation.partial_image" &&
              event.event !== "image_generation.completed"
            )
              return;
            let payload: { b64_json?: string };
            try {
              payload = JSON.parse(event.data);
            } catch {
              return;
            }
            if (!payload.b64_json) return;
            const isFinal = event.event === "image_generation.completed";
            flushSync(() => {
              patch({
                visualSrc: `data:image/png;base64,${payload.b64_json}`,
                visualFinal: isFinal,
              });
            });
            if (isFinal) sawCompleted = true;
          },
        });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.feed(value);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        if (!sawCompleted) throw new Error("Image stream ended without a completed event.");
        patch({ visualStatus: "done" });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        patch({
          visualStatus: "error",
          visualError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [session, updateCard, updateGlobal],
  );

  // ============ Chat (per card / global) ============
  const sendChat = useCallback(
    async (target: { id: string } | "global", text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const isGlobal = target === "global";
      if (isGlobal) {
        const transcripts = session.cards
          .map((c, i) => `--- VIDEO ${i + 1}${c.title ? `: ${c.title}` : ""} ---\n${c.text ?? ""}`)
          .join("\n\n");
        const next: ChatMsg[] = [...(session.global?.chat ?? []), { role: "user", content: trimmed }];
        updateGlobal({ chat: next });
        try {
          const res = await chat({
            data: { transcript: transcripts.slice(0, 80000), title: "Global synthesis", messages: next },
          });
          updateGlobal({ chat: [...next, { role: "assistant", content: res.reply }] });
        } catch (err) {
          updateGlobal({
            chat: [
              ...next,
              {
                role: "assistant",
                content: `*(error: ${err instanceof Error ? err.message : String(err)})*`,
              },
            ],
          });
        }
        return;
      }
      const card = session.cards.find((c) => c.id === (target as { id: string }).id);
      if (!card?.transcript) return;
      const next: ChatMsg[] = [...card.chat, { role: "user", content: trimmed }];
      updateCard(card.id, { chat: next });
      try {
        const res = await chat({
          data: { transcript: card.transcript, title: card.title, messages: next },
        });
        updateCard(card.id, { chat: [...next, { role: "assistant", content: res.reply }] });
      } catch (err) {
        updateCard(card.id, {
          chat: [
            ...next,
            {
              role: "assistant",
              content: `*(error: ${err instanceof Error ? err.message : String(err)})*`,
            },
          ],
        });
      }
    },
    [session, chat, updateCard, updateGlobal],
  );

  // ============ Translate ============
  const doTranslate = useCallback(
    async (cardId: string, target: string) => {
      const card = session.cards.find((c) => c.id === cardId);
      if (!card?.text) return;
      updateCard(cardId, { translated: { lang: target, content: "…translating…" } });
      try {
        const res = await translate({ data: { summary: card.text, targetLanguage: target } });
        updateCard(cardId, { translated: { lang: target, content: res.translated } });
      } catch (err) {
        updateCard(cardId, {
          translated: {
            lang: target,
            content: `*(translation failed: ${err instanceof Error ? err.message : String(err)})*`,
          },
        });
      }
    },
    [session, translate, updateCard],
  );

  // ============ Global summary ============
  const runGlobalSummary = useCallback(async () => {
    if (session.cards.length < 2) return;
    const items = session.cards
      .filter((c) => (session.global?.useTranscripts ? c.transcript : c.text))
      .map((c) => ({
        title: c.title,
        content: (session.global?.useTranscripts ? c.transcript : c.text) ?? "",
      }))
      .filter((it) => it.content.length > 0);
    if (items.length < 2) return;

    updateGlobal({ status: "loading", summary: null, error: null });
    globalCancelRef.current.text = false;
    try {
      const res = await summarizeManyFn({
        data: {
          items,
          mode: session.global?.useTranscripts ? "transcripts" : "summaries",
          length: "standard",
        },
      });
      if (globalCancelRef.current.text) return;
      updateGlobal({ status: "done", summary: res.summary, error: null });
    } catch (err) {
      updateGlobal({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [session, summarizeManyFn, updateGlobal]);

  // ============ Card actions ============
  const removeCard = useCallback(
    (id: string) => {
      cancelFlags.current.set(id, true);
      visualAborts.current.get(id)?.abort();
      setSession((s) => {
        const cards = s.cards.filter((c) => c.id !== id);
        return {
          ...s,
          cards,
          global: s.global && cards.length >= 2 ? { ...s.global, status: "stale" } : null,
        };
      });
    },
    [],
  );

  const resetAll = useCallback(() => {
    if (session.cards.length === 0) return;
    if (!confirm(`Clear all ${session.cards.length} summary card${session.cards.length === 1 ? "" : "s"}?`))
      return;
    cancelFlags.current = new Map();
    visualAborts.current.forEach((a) => a.abort());
    visualAborts.current = new Map();
    setSession((s) => ({ ...s, cards: [], global: null }));
  }, [session.cards.length]);

  const toggleMultiMode = useCallback(() => {
    setSession((s) => {
      if (s.multiMode && s.cards.length >= 2) {
        if (!confirm(`Switching off multi-summary will clear ${s.cards.length} cards and the global section. Continue?`))
          return s;
        return { ...s, multiMode: false, cards: s.cards.slice(0, 1), global: null };
      }
      return { ...s, multiMode: !s.multiMode };
    });
  }, []);

  // ============ Save HTML ============
  const saveCardHtml = useCallback((card: Card) => {
    const html = buildHtmlDoc({
      title: card.title ?? "OSVidSum summary",
      cards: [card],
      textModelLabel: TEXT_MODEL_LABEL,
      imageModelLabel: IMAGE_MODEL_LABEL,
    });
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    downloadBlob(`osvidsum-${card.videoId ?? "summary"}.html`, blob);
  }, []);

  const saveGlobalHtml = useCallback(() => {
    if (!session.global?.summary) return;
    const html = buildHtmlDoc({
      title: "OSVidSum — global synthesis",
      cards: session.cards,
      globalSummary: session.global.summary,
      globalImage: session.global.visualSrc,
      textModelLabel: TEXT_MODEL_LABEL,
      imageModelLabel: IMAGE_MODEL_LABEL,
    });
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    downloadBlob("osvidsum-global.html", blob);
  }, [session]);

  // ============ Close history dropdown on outside click ============
  useEffect(() => {
    if (!historyOpen) return;
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest("[data-history-menu]")) setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [historyOpen]);

  // ============ Ctrl/Cmd+Enter shortcut ============
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const target = e.target as HTMLElement;
        const closestInput = target.closest("[data-osvidsum-input]") as HTMLElement | null;
        if (closestInput) {
          e.preventDefault();
          const btn = closestInput.querySelector(
            "button[data-submit]",
          ) as HTMLButtonElement | null;
          btn?.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ============ Render ============
  const showGlobal = session.multiMode && session.cards.length >= 2;
  const anyCardLoading = session.cards.some((c) => c.textStatus === "loading");

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div ref={topRef} className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:py-8">
        {showModelReminder && (
          <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0 text-muted-foreground">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <div className="flex-1 text-muted-foreground">
              It's been 2+ months since we last checked for newer AI models. Ask the assistant:{" "}
              <em>"are there newer text/image models I should switch to?"</em>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowModelReminder(false);
                try {
                  localStorage.setItem(MODEL_REMINDER_DISMISSED_KEY, String(Date.now()));
                  localStorage.setItem(MODEL_CHECK_KEY, String(Date.now()));
                } catch {
                  /* ignore */
                }
              }}
              className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* ============ Top controls / input card ============ */}
        <InputCard
          session={session}
          updateSession={updateSession}
          history={history}
          historyOpen={historyOpen}
          setHistoryOpen={setHistoryOpen}
          clearHistory={clearHistory}
          onSubmit={(draft) => runSummarize(draft)}
          loading={anyCardLoading}
          onStop={() => {
            // Stop the most recent loading card
            const loadingCard = [...session.cards].reverse().find((c) => c.textStatus === "loading");
            if (loadingCard) stopSummarize(loadingCard.id);
          }}
          onPickHistory={(h) =>
            runSummarize({
              url: h.url,
              length: session.input.length,
              customInstructions: session.input.customInstructions,
            })
          }
          onToggleMulti={toggleMultiMode}
          onResetAll={resetAll}
          showResetAll={session.cards.length > 0}
        />

        {/* ============ Filled cards ============ */}
        {session.cards.map((card) => (
          <SummaryCardView
            key={card.id}
            card={card}
            targetLang={session.targetLang}
            setTargetLang={(l) => updateSession((s) => ({ ...s, targetLang: l }))}
            updateCard={(p) => updateCard(card.id, p)}
            removeCard={() => removeCard(card.id)}
            canRemove={session.multiMode}
            onRegenerate={() =>
              runSummarize({
                url: card.url,
                length: card.length,
                customInstructions: card.customInstructions,
                cardId: card.id,
              })
            }
            onStop={() => stopSummarize(card.id)}
            onFallback={() => runFallback(card)}
            fallbackBusy={fallbackBusy === card.id}
            onManualTranscript={(text) => submitManualTranscript(card, text)}
            onGenerateVisual={(d) => generateVisual({ id: card.id }, d)}
            onCancelVisual={() => visualAborts.current.get(card.id)?.abort()}
            onSendChat={(text) => sendChat({ id: card.id }, text)}
            onTranslate={() => doTranslate(card.id, session.targetLang)}
            onOpenViewer={(src) => setViewerSrc(src)}
            onSave={() => saveCardHtml(card)}
          />
        ))}

        {/* ============ Global section ============ */}
        {showGlobal && session.global !== null && (
          <GlobalSectionView
            global={session.global}
            updateGlobal={updateGlobal}
            onGenerate={runGlobalSummary}
            onGenerateVisual={(d) => generateVisual("global", d)}
            onSendChat={(t) => sendChat("global", t)}
            onSave={saveGlobalHtml}
            onOpenViewer={(src) => setViewerSrc(src)}
            cardCount={session.cards.length}
          />
        )}
        {showGlobal && session.global === null && (
          <div className="rounded-2xl border border-dashed border-border bg-card/50 p-6 text-center">
            <button
              type="button"
              onClick={() => {
                updateSession((s) => ({ ...s, global: makeEmptyGlobal() }));
                setTimeout(runGlobalSummary, 50);
              }}
              className="cursor-pointer rounded-xl bg-gradient-to-r from-primary to-fuchsia-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:brightness-110"
            >
              Generate global synthesis of {session.cards.length} videos
            </button>
          </div>
        )}

        {/* ============ Bottom input (always visible once a card exists) ============ */}
        {session.cards.length > 0 && (
          <div ref={bottomRef} className="pt-2">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {session.multiMode ? "Add another video" : "Summarize another video"}
            </p>
            <InputCard
              session={session}
              updateSession={updateSession}
              history={history}
              historyOpen={historyOpen}
              setHistoryOpen={setHistoryOpen}
              clearHistory={clearHistory}
              onSubmit={(draft) => runSummarize(draft)}
              loading={anyCardLoading}
              onStop={() => {
                const loadingCard = [...session.cards].reverse().find((c) => c.textStatus === "loading");
                if (loadingCard) stopSummarize(loadingCard.id);
              }}
              onPickHistory={(h) =>
                runSummarize({
                  url: h.url,
                  length: session.input.length,
                  customInstructions: session.input.customInstructions,
                })
              }
              onToggleMulti={toggleMultiMode}
              onResetAll={resetAll}
              showResetAll={session.cards.length > 0}
              compact
            />
          </div>
        )}


        <footer className="flex flex-col items-center gap-1 pt-4 text-center text-xs text-muted-foreground">
          <div>
            Note: YouTube sometimes blocks transcript requests from servers. If you get an error,
            try again in a few minutes, or use the in-browser fallback.
          </div>
          <div className="mt-3 inline-flex select-none items-center gap-1.5 opacity-70 transition-opacity hover:opacity-100">
            <OSVidSumMark />
            <span className="text-[10px] font-medium uppercase tracking-[0.2em]">
              <span style={{ color: "var(--brand-gold)" }}>OS</span>
              <span className="text-muted-foreground">VidSum</span>
            </span>
          </div>
        </footer>
      </div>

      {viewerSrc && <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </main>
  );
}

// ============ InputCard ============

function InputCard({
  session,
  updateSession,
  history,
  historyOpen,
  setHistoryOpen,
  clearHistory,
  onSubmit,
  loading,
  onStop,
  onPickHistory,
  onToggleMulti,
  onResetAll,
  showResetAll,
  compact,
}: {
  session: Session;
  updateSession: (fn: (s: Session) => Session) => void;
  history: HistoryItem[];
  historyOpen: boolean;
  setHistoryOpen: (b: boolean | ((o: boolean) => boolean)) => void;
  clearHistory: () => void;
  onSubmit: (draft: { url: string; length: Length; customInstructions: string }) => void;
  loading: boolean;
  onStop: () => void;
  onPickHistory: (h: HistoryItem) => void;
  onToggleMulti: () => void;
  onResetAll: () => void;
  showResetAll: boolean;
  compact?: boolean;
}) {
  const { length, customInstructions } = session.input;
  const [localUrl, setLocalUrl] = useState("");
  const url = compact ? localUrl : session.input.url;
  const [dragOver, setDragOver] = useState(false);
  const setUrl = (u: string) => {
    if (compact) setLocalUrl(u);
    else updateSession((s) => ({ ...s, input: { ...s.input, url: u } }));
  };
  const setLength = (l: Length) =>
    updateSession((s) => ({ ...s, input: { ...s.input, length: l } }));
  const setCustom = (c: string) =>
    updateSession((s) => ({ ...s, input: { ...s.input, customInstructions: c } }));


  const trySubmit = () => {
    const u = url.trim();
    if (!u) return;
    onSubmit({ url: u, length, customInstructions });
    // Keep the URL in the box so the user can see what was summarized.
  };

  // Auto-summarize on paste of a YouTube URL
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (!session.autoSummarize) return;
    const pasted = e.clipboardData.getData("text").trim();
    const vid = extractVideoIdClient(pasted);
    if (vid) {
      e.preventDefault();
      setUrl(pasted);
      setTimeout(() => onSubmit({ url: pasted, length, customInstructions }), 10);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    const candidates = [
      dt.getData("text/uri-list"),
      dt.getData("text/x-moz-url"),
      dt.getData("text/plain"),
    ]
      .filter(Boolean)
      .flatMap((s) => s.split(/\r?\n/))
      .filter((line) => !line.startsWith("#"));
    for (const c of candidates) {
      const clean = c.trim();
      const vid = extractVideoIdClient(clean);
      if (vid) {
        setUrl(clean);
        if (session.autoSummarize) {
          setTimeout(() => onSubmit({ url: clean, length, customInstructions }), 10);
        }
        return;
      }
    }
  };


  return (
    <form
      data-osvidsum-input
      onSubmit={(e) => {
        e.preventDefault();
        trySubmit();
      }}
      onDrop={handleDrop}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types ?? []).some((t) => t.startsWith("text"))) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      className={`relative rounded-2xl border bg-card p-5 shadow-xl shadow-slate-200/50 transition-all dark:shadow-black/30 md:p-6 ${
        dragOver ? "border-primary ring-2 ring-primary/30" : "border-border"
      }`}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/5 text-sm font-semibold text-primary">
          Drop YouTube link here
        </div>
      )}
      <div className="space-y-4">
        <div className="relative flex items-center">
          <input
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={onPaste}
            placeholder="Paste or drop a YouTube link…"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-border bg-muted py-3.5 pl-4 pr-32 text-base text-foreground outline-none transition-all placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {loading ? (
            <button
              type="button"
              onClick={onStop}
              data-submit
              className="absolute right-2 flex cursor-pointer items-center gap-1.5 rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-destructive/20 transition-all hover:brightness-110"
            >
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              data-submit
              disabled={!url.trim()}
              title="Summarize (⌘/Ctrl + Enter)"
              className="absolute right-2 cursor-pointer rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
            >
              Summarize
            </button>
          )}

        </div>

        {!compact && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-muted-foreground">Length:</span>
            <div className="flex rounded-lg bg-muted p-1">
              {LENGTH_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setLength(opt.value)}
                  className={`cursor-pointer rounded-md px-3.5 py-1.5 text-sm transition-colors ${
                    length === opt.value
                      ? "bg-card font-semibold text-primary shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  updateSession((s) => ({ ...s, autoSummarize: !s.autoSummarize }))
                }
                title={
                  session.autoSummarize
                    ? "Auto-summarize on paste/drop: ON"
                    : "Auto-summarize on paste/drop: OFF"
                }
                aria-pressed={session.autoSummarize}
                className={`flex cursor-pointer items-center justify-center rounded-lg border p-1.5 transition ${
                  session.autoSummarize
                    ? "border-transparent text-white shadow-sm"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground"
                }`}
                style={
                  session.autoSummarize
                    ? { backgroundColor: "var(--brand-gold)" }
                    : undefined
                }
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill={session.autoSummarize ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </button>
              <button
                type="button"
                onClick={onToggleMulti}
                title={
                  session.multiMode
                    ? "Multi-summary mode: ON"
                    : "Multi-summary mode: OFF"
                }
                aria-pressed={session.multiMode}
                className={`flex cursor-pointer items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                  session.multiMode
                    ? "border-primary bg-primary text-primary-foreground shadow-sm"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
                Multi
              </button>


              <div className="relative" data-history-menu>
                <button
                  type="button"
                  onClick={() => setHistoryOpen((o) => !o)}
                  title="Recent videos"
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  Recent
                  {history.length > 0 && (
                    <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                      {history.length}
                    </span>
                  )}
                </button>
                {historyOpen && (
                  <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                      <span className="text-xs font-semibold text-foreground">Recent videos</span>
                      {history.length > 0 && (
                        <button
                          type="button"
                          onClick={clearHistory}
                          className="cursor-pointer text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {history.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        No videos yet.
                      </div>
                    ) : (
                      <ul className="max-h-80 overflow-y-auto">
                        {history.map((h) => (
                          <li key={h.videoId}>
                            <button
                              type="button"
                              onClick={() => {
                                setHistoryOpen(false);
                                onPickHistory(h);
                              }}
                              className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition hover:bg-muted"
                            >
                              <img
                                src={`https://i.ytimg.com/vi/${h.videoId}/default.jpg`}
                                alt=""
                                className="h-10 w-16 flex-shrink-0 rounded object-cover"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium text-foreground">
                                  {h.title ?? h.url.replace(/^https?:\/\//, "")}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {new Date(h.ts).toLocaleString()}
                                </div>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() =>
                  updateSession((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }))
                }
                title={session.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                className="cursor-pointer rounded-lg border border-border bg-muted p-1.5 text-muted-foreground transition hover:text-foreground"
              >
                {session.theme === "dark" ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
              </button>

              {showResetAll && (
                <button
                  type="button"
                  onClick={onResetAll}
                  title="Clear all summaries"
                  className="cursor-pointer rounded-lg border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground transition hover:text-destructive"
                >
                  Reset all
                </button>
              )}
            </div>
          </div>
        )}

        {!compact && (
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
              Custom instructions (optional)
            </summary>
            <textarea
              value={customInstructions}
              onChange={(e) => setCustom(e.target.value)}
              maxLength={800}
              rows={2}
              placeholder='e.g. "as a table", "focus on the technical details", "in plain text, no bullets"'
              className="mt-2 w-full resize-y rounded-lg border border-border bg-muted p-2 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-1 text-right text-[10px] text-muted-foreground">
              {customInstructions.length}/800
            </div>
          </details>
        )}

        {!compact && (
          <div className="hidden text-[11px] text-muted-foreground md:block">
            Tip: ⌘/Ctrl + Enter to summarize. Drop a YouTube link directly onto this box.
          </div>
        )}
      </div>
    </form>
  );
}

// ============ SummaryCardView ============

function SummaryCardView({
  card,
  targetLang,
  setTargetLang,
  updateCard,
  removeCard,
  canRemove,
  onRegenerate,
  onStop,
  onFallback,
  fallbackBusy,
  onManualTranscript,
  onGenerateVisual,
  onCancelVisual,
  onSendChat,
  onTranslate,
  onOpenViewer,
  onSave,
}: {
  card: Card;
  targetLang: string;
  setTargetLang: (l: string) => void;
  updateCard: (p: Partial<Card>) => void;
  removeCard: () => void;
  canRemove: boolean;
  onRegenerate: () => void;
  onStop: () => void;
  onFallback: () => void;
  fallbackBusy: boolean;
  onManualTranscript: (text: string) => void;
  onGenerateVisual: (d: Detail) => void;
  onCancelVisual: () => void;
  onSendChat: (text: string) => void;
  onTranslate: () => void;
  onOpenViewer: (src: string) => void;
  onSave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");

  const displayContent = card.translated?.content ?? card.text ?? "";

  const isTranscriptBlocked = useMemo(() => {
    if (card.textStatus !== "error") return false;
    return /blocking|disabled|temporarily|captcha|too many/i.test(card.textError ?? "");
  }, [card.textStatus, card.textError]);

  const isNoCaptions = useMemo(() => {
    return /doesn't have captions|no captions/i.test(card.textError ?? "");
  }, [card.textError]);

  const copyAll = async () => {
    if (!displayContent) return;
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // Loading state
  if (card.textStatus === "loading") {
    return (
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
            Summarizing {card.url ? new URL(card.url.startsWith("http") ? card.url : `https://${card.url}`).hostname.replace("www.", "") : "video"}…
          </div>
          <button
            type="button"
            onClick={onStop}
            className="cursor-pointer rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-white"
          >
            Stop
          </button>
        </div>
      </section>
    );
  }

  // Error state
  if (card.textStatus === "error") {
    return (
      <section className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">{card.textError}</div>
          {canRemove && (
            <button
              type="button"
              onClick={removeCard}
              className="cursor-pointer rounded-md px-2 text-destructive/70 hover:text-destructive"
              title="Remove this card"
            >
              ✕
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {isTranscriptBlocked && !isNoCaptions && (
            <button
              type="button"
              disabled={fallbackBusy}
              onClick={onFallback}
              className="cursor-pointer rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {fallbackBusy ? "Trying in-browser fetch…" : "Try in-browser fallback (via CORS proxies)"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setManualOpen((o) => !o)}
            className="cursor-pointer rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/15"
          >
            Paste transcript manually
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            className="cursor-pointer rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/15"
          >
            Retry
          </button>
        </div>
        {isTranscriptBlocked && !isNoCaptions && (
          <p className="text-[11px] text-destructive/70">
            Note: the in-browser fallback fetches the transcript via public CORS proxies — it does
            NOT read videos open in your browser tabs.
          </p>
        )}
        {manualOpen && (
          <div className="space-y-2">
            <textarea
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              rows={6}
              placeholder="Open the video on YouTube → click the … menu → 'Show transcript' → copy and paste it here."
              className="w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              disabled={manualText.trim().length < 20}
              onClick={() => onManualTranscript(manualText)}
              className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Summarize from pasted transcript
            </button>
          </div>
        )}
      </section>
    );
  }

  // Done — render full card
  if (!card.text) return null;

  return (
    <section className="animate-fade-in space-y-4 pt-2">
      {/* Video header */}
      {card.videoId && (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex items-center gap-2 px-2">
            <button
              type="button"
              onClick={() => updateCard({ videoOpen: !card.videoOpen })}
              className="flex flex-1 cursor-pointer items-center gap-3 px-2 py-3 text-left transition hover:bg-muted"
            >
              <img
                src={`https://i.ytimg.com/vi/${card.videoId}/default.jpg`}
                alt=""
                className="h-10 w-16 flex-shrink-0 rounded object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground" title={card.title ?? ""}>
                  {card.title ?? "YouTube video"}
                </div>

                {card.author && (
                  <div className="truncate text-xs text-muted-foreground">{card.author}</div>
                )}
              </div>
              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
                <span className="hidden sm:inline">{card.videoOpen ? "Hide" : "Show"} video</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${card.videoOpen ? "rotate-180" : ""}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>

            </button>
            {canRemove && (
              <button
                type="button"
                onClick={() => {
                  const hasWork = card.chat.length > 0 || !!card.visualSrc;
                  if (hasWork && !confirm("Remove this summary (chat / image will be lost)?")) return;
                  removeCard();
                }}
                title="Remove this summary"
                className="cursor-pointer rounded-md p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}

          </div>
          {card.videoOpen && (
            <div className="border-t border-border bg-muted">
              <div className="aspect-video w-full">
                <iframe
                  className="h-full w-full"
                  src={`https://www.youtube.com/embed/${card.videoId}`}
                  title={card.title ?? "YouTube video"}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Summary body */}
      <div className="space-y-6 rounded-2xl border border-border bg-card p-6 shadow-sm md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div>
            <h3 className="text-xl font-bold text-foreground">Video Summary</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {card.detectedLang && (
                <>
                  Source: <span className="font-medium text-foreground">{card.detectedLang}</span>
                  {" · "}
                </>
              )}
              {card.translated && (
                <>
                  Translated to{" "}
                  <span className="font-medium text-foreground">{card.translated.lang}</span>
                  {" · "}
                </>
              )}
              <span title="AI model used for the summary">
                Model: <span className="font-medium text-foreground">{TEXT_MODEL_LABEL}</span>
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copyAll}
              title="Copy summary"
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onSave}
              title="Save as HTML"
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              Save
            </button>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="rounded-lg border border-border bg-muted px-2 py-1.5 text-xs font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/10"
            >
              {POPULAR_LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onTranslate}
              className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:brightness-110"
            >
              Translate
            </button>
            {card.translated && (
              <button
                type="button"
                onClick={() => updateCard({ translated: null })}
                className="cursor-pointer rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Original
              </button>
            )}
            <button
              type="button"
              onClick={onRegenerate}
              title="Regenerate this summary"
              className="cursor-pointer rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              ↻
            </button>
          </div>
        </div>

        <article className="text-[0.95rem] leading-relaxed text-foreground [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground [&_p]:my-3 [&_p]:text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-6 [&_li]:pl-1 [&_li]:text-muted-foreground [&_li::marker]:font-semibold [&_li::marker]:text-primary [&_a]:text-primary [&_a]:underline">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
        </article>

        {/* Visual summary */}
        <VisualBlock
          status={card.visualStatus}
          src={card.visualSrc}
          final={card.visualFinal}
          detail={card.visualDetail}
          error={card.visualError}
          open={card.visualOpen}
          onOpen={() => updateCard({ visualOpen: true })}
          onClose={() => updateCard({ visualOpen: false, visualStatus: "idle", visualSrc: null, visualError: null })}
          onGenerate={onGenerateVisual}
          onCancel={onCancelVisual}
          onOpenViewer={onOpenViewer}
          videoId={card.videoId}
        />

        {/* Chat */}
        {card.transcript && (
          <div className="border-t border-border pt-5">
            {!chatOpen && card.chat.length === 0 ? (
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition hover:bg-card"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Ask AI about this video
              </button>
            ) : (
              <ChatPanel
                title="Ask AI about this video"
                chat={card.chat}
                input={chatInput}
                setInput={setChatInput}
                onSend={() => {
                  if (!chatInput.trim()) return;
                  onSendChat(chatInput);
                  setChatInput("");
                }}
                onReset={() => updateCard({ chat: [] })}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ============ VisualBlock ============
function VisualBlock({
  status,
  src,
  final,
  detail,
  error,
  open,
  onOpen,
  onClose,
  onGenerate,
  onCancel,
  onOpenViewer,
  videoId,
}: {
  status: Card["visualStatus"];
  src: string | null;
  final: boolean;
  detail: Detail;
  error: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onGenerate: (d: Detail) => void;
  onCancel: () => void;
  onOpenViewer: (src: string) => void;
  videoId: string | null;
}) {
  return (
    <div className="border-t border-border pt-5">
      {!open ? (
        <button
          type="button"
          onClick={() => {
            onOpen();
            onGenerate(detail);
          }}
          className="group relative inline-flex cursor-pointer items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-primary/50 via-fuchsia-500/45 to-pink-500/45 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:shadow-md hover:brightness-105 active:translate-y-px"
        >
          <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l1.9 5.8L20 10l-4.5 3.3L17 19l-5-3-5 3 1.5-5.7L4 10l6.1-1.2z" />
          </svg>
          Generate visual summary
        </button>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 className="text-sm font-bold text-foreground">Visual summary</h4>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Detail:</span>
              <div className="flex rounded-lg bg-muted p-1">
                {DETAIL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={status === "loading"}
                    onClick={() => onGenerate(opt.value)}
                    className={`cursor-pointer rounded-md px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      detail === opt.value
                        ? "bg-card font-semibold text-primary shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {status === "loading" && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="cursor-pointer rounded-lg bg-destructive/90 px-2 py-1 text-xs font-semibold text-white"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="relative overflow-hidden rounded-xl border border-border bg-muted">
            {src ? (
              <button
                type="button"
                onClick={() => final && onOpenViewer(src)}
                className="block w-full cursor-zoom-in"
                title={final ? "Click to zoom & pan" : ""}
              >
                <img
                  src={src}
                  alt="Visual summary"
                  className={`block h-auto w-full transition-[filter] duration-500 ${
                    final ? "blur-0" : "blur-xl"
                  }`}
                />
              </button>
            ) : (
              <div className="flex aspect-square items-center justify-center text-sm text-muted-foreground">
                {status === "loading" ? "Generating image…" : "Preparing…"}
              </div>
            )}
            <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              {IMAGE_MODEL_LABEL}
            </div>
            {status === "loading" && (
              <div className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
                {final ? "Finalizing…" : "Rendering…"}
              </div>
            )}
          </div>

          {final && src && (
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenViewer(src);
                }}
                className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                  <path d="M8 11h6M11 8v6" />
                </svg>
                Zoom & pan
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openImageInNewTab(src);
                }}
                className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                Open in new tab
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  downloadBlob(`osvidsum-${videoId ?? "visual"}-${detail}.png`, dataUrlToBlob(src));
                }}
                className="cursor-pointer rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                Download PNG
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============ ChatPanel ============
function ChatPanel({
  title,
  chat,
  input,
  setInput,
  onSend,
  onReset,
}: {
  title: string;
  chat: ChatMsg[];
  input: string;
  setInput: (s: string) => void;
  onSend: () => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-foreground">{title}</h4>
        <span className="text-[11px] text-muted-foreground">
          Model: <span className="font-medium text-foreground">{TEXT_MODEL_LABEL}</span>
        </span>
      </div>
      {chat.length > 0 && (
        <ChatMessages chat={chat} />
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Ask anything about the video…"
          className="flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!input.trim()}
          className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
        {chat.length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="cursor-pointer rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

// ============ ChatMessages (collapsible history) ============
function ChatMessages({ chat }: { chat: ChatMsg[] }) {
  // Latest "exchange" = trailing assistant + the user msg right before it,
  // OR just the trailing user msg if still waiting for a reply.
  const latestStart = useMemo(() => {
    if (chat.length === 0) return 0;
    const last = chat[chat.length - 1];
    if (last.role === "assistant" && chat.length >= 2 && chat[chat.length - 2].role === "user") {
      return chat.length - 2;
    }
    return chat.length - 1;
  }, [chat]);

  const oldCount = latestStart;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [allOpen, setAllOpen] = useState(false);

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3">
      {oldCount > 0 && (
        <div className="flex items-center justify-between pb-1 text-[11px] text-muted-foreground">
          <span>
            {oldCount} earlier message{oldCount === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={() => {
              if (allOpen) {
                setExpanded(new Set());
                setAllOpen(false);
              } else {
                setExpanded(new Set(Array.from({ length: oldCount }, (_, i) => i)));
                setAllOpen(true);
              }
            }}
            className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}
      {chat.map((m, i) => {
        const isOld = i < latestStart;
        const isOpen = !isOld || expanded.has(i);
        if (isOld && !isOpen) {
          const preview = m.content.replace(/\s+/g, " ").trim().slice(0, 90);
          return (
            <button
              key={i}
              type="button"
              onClick={() => toggle(i)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition hover:bg-card hover:text-foreground"
              title="Click to expand"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider">
                {m.role === "user" ? "You" : "AI"}
              </span>
              <span className="truncate">{preview}</span>
            </button>
          );
        }
        return (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-sm ${
              m.role === "user" ? "bg-primary/10 text-foreground" : "bg-card text-foreground"
            }`}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {m.role === "user" ? "You" : "AI"}
              </span>
              {isOld && (
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground"
                >
                  Collapse
                </button>
              )}
            </div>
            <div className="prose-sm text-[0.9rem] leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============ GlobalSectionView ============
function GlobalSectionView({
  global,
  updateGlobal,
  onGenerate,
  onGenerateVisual,
  onSendChat,
  onSave,
  onOpenViewer,
  cardCount,
}: {
  global: GlobalSection;
  updateGlobal: (p: Partial<GlobalSection>) => void;
  onGenerate: () => void;
  onGenerateVisual: (d: Detail) => void;
  onSendChat: (text: string) => void;
  onSave: () => void;
  onOpenViewer: (src: string) => void;
  cardCount: number;
}) {
  const [chatInput, setChatInput] = useState("");

  return (
    <section className="space-y-4 rounded-2xl border-2 border-primary/30 bg-gradient-to-br from-primary/5 to-fuchsia-500/5 p-6 shadow-sm md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h3 className="text-xl font-bold text-foreground">Global synthesis</h3>
          <p className="text-xs text-muted-foreground">
            Across {cardCount} videos. {global.status === "stale" && (
              <span className="font-medium text-amber-600 dark:text-amber-400">
                Out of date — regenerate?
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={global.useTranscripts}
              onChange={(e) => updateGlobal({ useTranscripts: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            Use full transcripts (deeper, slower)
          </label>
          <button
            type="button"
            onClick={onGenerate}
            disabled={global.status === "loading"}
            className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
          >
            {global.status === "loading"
              ? "Generating…"
              : global.summary
                ? "Regenerate"
                : "Generate"}
          </button>
          {global.summary && (
            <button
              type="button"
              onClick={onSave}
              className="cursor-pointer rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              Save all
            </button>
          )}
        </div>
      </div>

      {global.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {global.error}
        </div>
      )}

      {global.summary && (
        <>
          <article className="text-[0.95rem] leading-relaxed [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-bold [&_p]:my-2 [&_p]:text-muted-foreground [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:text-muted-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{global.summary}</ReactMarkdown>
          </article>

          <VisualBlock
            status={global.visualStatus}
            src={global.visualSrc}
            final={global.visualFinal}
            detail={global.visualDetail}
            error={global.visualError}
            open={global.visualStatus !== "idle" || !!global.visualSrc}
            onOpen={() => updateGlobal({ visualStatus: "loading" })}
            onClose={() => updateGlobal({ visualStatus: "idle", visualSrc: null, visualError: null })}
            onGenerate={onGenerateVisual}
            onCancel={() => updateGlobal({ visualStatus: "idle" })}
            onOpenViewer={onOpenViewer}
            videoId="global"
          />

          <div className="border-t border-border pt-4">
            <ChatPanel
              title="Ask AI about all videos"
              chat={global.chat}
              input={chatInput}
              setInput={setChatInput}
              onSend={() => {
                if (!chatInput.trim()) return;
                onSendChat(chatInput);
                setChatInput("");
              }}
              onReset={() => updateGlobal({ chat: [] })}
            />
          </div>
        </>
      )}
    </section>
  );
}

// ============ OSVidSum monogram ============
function OSVidSumMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--brand-gold)"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="OSVidSum"
    >
      <circle cx="10" cy="12" r="6" />
      <path d="M14 9.5 c -1.5 -1 -3.5 -0.5 -3.5 1.2 c 0 1.6 3.5 1.4 3.5 3.1 c 0 1.7 -2 2.2 -3.5 1.2" />
    </svg>
  );
}

// ============ ImageViewer ============
function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const pinchRef = useRef<{
    initialDist: number;
    initialScale: number;
    pointers: Map<number, { x: number; y: number }>;
  }>({ initialDist: 0, initialScale: 1, pointers: new Map() });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "0") {
        setScale(1);
        setTx(0);
        setTy(0);
      }
      if (e.key === "+" || e.key === "=") setScale((s) => Math.min(8, s * 1.2));
      if (e.key === "-") setScale((s) => Math.max(0.25, s / 1.2));
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setScale((s) => Math.min(8, Math.max(0.25, s * factor)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pinchRef.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchRef.current.pointers.size === 1) {
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: tx,
        baseY: ty,
      };
    } else if (pinchRef.current.pointers.size === 2) {
      const pts = Array.from(pinchRef.current.pointers.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      pinchRef.current.initialDist = Math.hypot(dx, dy);
      pinchRef.current.initialScale = scale;
      dragRef.current = null;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pinchRef.current.pointers.has(e.pointerId)) return;
    pinchRef.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchRef.current.pointers.size === 2) {
      const pts = Array.from(pinchRef.current.pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = dist / (pinchRef.current.initialDist || 1);
      setScale(Math.min(8, Math.max(0.25, pinchRef.current.initialScale * ratio)));
    } else if (dragRef.current) {
      setTx(dragRef.current.baseX + (e.clientX - dragRef.current.startX));
      setTy(dragRef.current.baseY + (e.clientY - dragRef.current.startY));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pinchRef.current.pointers.delete(e.pointerId);
    if (pinchRef.current.pointers.size < 2) {
      pinchRef.current.initialDist = 0;
    }
    if (pinchRef.current.pointers.size === 0) {
      dragRef.current = null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <div className="text-xs text-white/70">
          Zoom: {Math.round(scale * 100)}% · Drag to pan, wheel to zoom · Esc to close, 0 to reset
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setScale(1);
              setTx(0);
              setTy(0);
            }}
            className="cursor-pointer rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => openImageInNewTab(src)}
            className="cursor-pointer rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          >
            Open in new tab
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              downloadBlob(`osvidsum-${Date.now()}.png`, dataUrlToBlob(src));
            }}
            className="cursor-pointer rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          >
            Download PNG
          </button>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          >
            Close ✕
          </button>
        </div>
      </div>
      <div
        className="flex flex-1 cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ touchAction: "none" }}
      >
        <img
          src={src}
          alt="Visual summary"
          draggable={false}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "center",
            transition: dragRef.current ? "none" : "transform 60ms",
            maxWidth: "90vw",
            maxHeight: "calc(100vh - 100px)",
          }}
        />
      </div>
    </div>
  );
}
