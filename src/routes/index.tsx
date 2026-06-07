import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
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
} from "@/lib/api/summarize.functions";
import { TEXT_MODEL_LABEL, IMAGE_MODEL_LABEL } from "@/lib/models";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "YouTube Video Summarizer — AI summaries from transcripts" },
      {
        name: "description",
        content:
          "Paste a YouTube URL, get an AI summary in the video's language. Translate to any language on demand.",
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
type Length = (typeof LENGTH_OPTIONS)[number]["value"];

const DETAIL_OPTIONS = [
  { value: "simple", label: "Simple" },
  { value: "medium", label: "Medium" },
  { value: "detailed", label: "Detailed" },
] as const;
type Detail = (typeof DETAIL_OPTIONS)[number]["value"];

const HISTORY_KEY = "yt-summarizer-history";
const THEME_KEY = "yt-summarizer-theme";
const MODEL_CHECK_KEY = "yt-summarizer-last-model-check";
const MODEL_REMINDER_DISMISSED_KEY = "yt-summarizer-model-reminder-dismissed";
const MAX_HISTORY = 10;
const MODEL_CHECK_INTERVAL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

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

// Try fetching the transcript directly in the browser via public CORS proxies.
// Best-effort fallback used when the server-side path is blocked.
async function fetchTranscriptViaProxy(
  videoId: string,
): Promise<{ transcript: string; lang: string | null } | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const proxies = [
    (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];

  for (const proxy of proxies) {
    try {
      const res = await fetch(proxy(watchUrl), { method: "GET" });
      if (!res.ok) continue;
      const html = await res.text();
      // Extract captions track URL from ytInitialPlayerResponse
      const m = html.match(/"captionTracks":(\[[^\]]+\])/);
      if (!m) continue;
      const tracks = JSON.parse(m[1].replace(/\\u0026/g, "&")) as Array<{
        baseUrl: string;
        languageCode?: string;
      }>;
      if (!tracks.length) continue;
      // Prefer English/Spanish/Catalan/French if present, else first
      const pref = ["en", "es", "ca", "fr"];
      const track =
        tracks.find((t) => pref.includes(t.languageCode ?? "")) ?? tracks[0];

      const xmlRes = await fetch(proxy(track.baseUrl));
      if (!xmlRes.ok) continue;
      const xml = await xmlRes.text();
      // Strip XML tags and decode entities
      const text = xml
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 20) continue;
      return { transcript: text, lang: track.languageCode ?? null };
    } catch {
      continue;
    }
  }
  return null;
}

function Index() {
  const [url, setUrl] = useState("");
  const [targetLang, setTargetLang] = useState("English");
  const [length, setLength] = useState<Length>("standard");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [copied, setCopied] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [visualOpen, setVisualOpen] = useState(false);
  const [visualDetail, setVisualDetail] = useState<Detail>("medium");
  const [visualSrc, setVisualSrc] = useState<string | null>(null);
  const [visualFinal, setVisualFinal] = useState(false);
  const [visualLoading, setVisualLoading] = useState(false);
  const [visualError, setVisualError] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [showModelReminder, setShowModelReminder] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  type ChatMsg = { role: "user" | "assistant"; content: string };
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);

  const summarize = useServerFn(summarizeVideo);
  const summarizeFromTranscript = useServerFn(summarizeWithTranscript);
  const translate = useServerFn(translateSummary);
  const chat = useServerFn(chatAboutVideo);

  const summaryMut = useMutation({
    mutationFn: (vars: { url: string; length: Length }) =>
      summarize({ data: vars }),
  });

  const translateMut = useMutation({
    mutationFn: (vars: { summary: string; targetLanguage: string }) =>
      translate({ data: vars }),
  });

  const chatMut = useMutation({
    mutationFn: (vars: {
      transcript: string;
      title: string | null;
      messages: ChatMsg[];
    }) => chat({ data: vars }),
    onSuccess: (res) => {
      setChatMessages((m) => [...m, { role: "assistant", content: res.reply }]);
    },
  });

  // Load persisted state — DEFAULT to LIGHT mode (no system-pref auto-follow).
  useEffect(() => {
    try {
      const h = localStorage.getItem(HISTORY_KEY);
      if (h) setHistory(JSON.parse(h));
    } catch {
      /* ignore */
    }
    const savedTheme = localStorage.getItem(THEME_KEY);
    setDark(savedTheme === "dark");

    // Dormant model-check reminder (every 60 days)
    try {
      const last = Number(localStorage.getItem(MODEL_CHECK_KEY) ?? 0);
      const dismissed = Number(
        localStorage.getItem(MODEL_REMINDER_DISMISSED_KEY) ?? 0,
      );
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

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }, [dark]);

  // Push to history + scroll on new summary
  useEffect(() => {
    if (!summaryMut.data) return;
    const { videoId, title } = summaryMut.data;
    const submitted = summaryMut.variables?.url ?? url;
    setHistory((prev) => {
      const next = [
        { url: submitted, videoId, title, ts: Date.now() },
        ...prev.filter((p) => p.videoId !== videoId),
      ].slice(0, MAX_HISTORY);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    setVideoOpen(false);
    setVisualOpen(false);
    setVisualSrc(null);
    setVisualFinal(false);
    setVisualError(null);
    setChatOpen(false);
    setChatMessages([]);
    setChatInput("");
    chatMut.reset();
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [summaryMut.data]);

  // Close history dropdown on outside click
  useEffect(() => {
    if (!historyOpen) return;
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest("[data-history-menu]")) setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [historyOpen]);

  const runSummarize = useCallback(
    (overrideUrl?: string, overrideLength?: Length) => {
      const u = (overrideUrl ?? url).trim();
      if (!u) return;
      if (overrideUrl) setUrl(overrideUrl);
      translateMut.reset();
      summaryMut.mutate({ url: u, length: overrideLength ?? length });
    },
    [url, length, summaryMut, translateMut],
  );

  // Fallback data state (populated by runFallbackClean below)

  const [fallbackData, setFallbackData] = useState<
    Awaited<ReturnType<typeof summarizeFromTranscript>> | null
  >(null);

  const runFallbackClean = useCallback(async () => {
    const u = url.trim();
    const vid = extractVideoIdClient(u);
    if (!vid) return;
    setFallbackBusy(true);
    try {
      const result = await fetchTranscriptViaProxy(vid);
      if (!result) {
        alert(
          "In-browser fallback also failed. The video may have no captions, or all proxies are down right now.",
        );
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
          length,
          title: meta?.title ?? null,
          author: meta?.author_name ?? null,
          detectedLang: result.lang,
        },
      });
      summaryMut.reset();
      setFallbackData(data);
      // Push to history
      setHistory((prev) => {
        const next = [
          {
            url: u,
            videoId: vid,
            title: data.title ?? null,
            ts: Date.now(),
          },
          ...prev.filter((p) => p.videoId !== vid),
        ].slice(0, MAX_HISTORY);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      setVideoOpen(false);
      setVisualOpen(false);
      setVisualSrc(null);
      setChatOpen(false);
      setChatMessages([]);
      topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      alert(
        "Fallback failed: " +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setFallbackBusy(false);
    }
  }, [url, length, summaryMut, summarizeFromTranscript]);

  // When a fresh server-side summary arrives, clear any stale fallback
  useEffect(() => {
    if (summaryMut.data) setFallbackData(null);
  }, [summaryMut.data]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runSummarize();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!summaryMut.isPending) runSummarize();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runSummarize, summaryMut.isPending]);

  // The "effective" summary data is the server one if present, else fallback
  const effective = summaryMut.data ?? fallbackData;
  const summary = effective?.summary;
  const transcript = effective?.transcript;
  const videoId = effective?.videoId;
  const videoTitle = effective?.title;
  const videoAuthor = effective?.author;
  const detectedLang = effective?.detectedLang;
  const displayContent = translateMut.data?.translated ?? summary;

  const isTranscriptBlocked = useMemo(() => {
    if (!summaryMut.isError) return false;
    const msg = (summaryMut.error as Error)?.message ?? "";
    return /blocking|disabled|temporarily|captcha|too many/i.test(msg);
  }, [summaryMut.isError, summaryMut.error]);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text || !transcript || chatMut.isPending) return;
    const next: ChatMsg[] = [...chatMessages, { role: "user", content: text }];
    setChatMessages(next);
    setChatInput("");
    chatMut.mutate({
      transcript,
      title: videoTitle ?? null,
      messages: next,
    });
  };

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

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  };

  const generateVisual = useCallback(
    async (detail: Detail) => {
      if (!summary) return;
      setVisualOpen(true);
      setVisualLoading(true);
      setVisualFinal(false);
      setVisualError(null);
      setVisualSrc(null);
      setVisualDetail(detail);
      try {
        const res = await fetch("/api/generate-visual-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary, title: videoTitle, detail }),
        });
        if (!res.ok || !res.body) {
          throw new Error(
            `Image generation failed (${res.status}): ${await res
              .text()
              .catch(() => "")}`,
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
              setVisualSrc(`data:image/png;base64,${payload.b64_json}`);
              if (isFinal) setVisualFinal(true);
            });
            if (isFinal) sawCompleted = true;
          },
        });
        const reader = res.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.feed(value);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        if (!sawCompleted) {
          throw new Error("Image stream ended without a completed event.");
        }
      } catch (err) {
        setVisualError(err instanceof Error ? err.message : String(err));
      } finally {
        setVisualLoading(false);
      }
    },
    [summary, videoTitle],
  );

  // ============ Drag-and-drop handlers for the URL input area ============
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
      const vid = extractVideoIdClient(c.trim());
      if (vid) {
        const clean = c.trim();
        setUrl(clean);
        return;
      }
    }
    // No YT URL — surface a hint
    if (candidates.length > 0) {
      alert("That doesn't look like a YouTube link.");
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types ?? []).some((t) => t.startsWith("text"))) {
      e.preventDefault();
      setDragOver(true);
    }
  };
  const handleDragLeave = () => setDragOver(false);

  // ============ Controls card (input + length + history + theme) ============
  const renderControls = (idSuffix: string) => (
    <form
      onSubmit={onSubmit}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={`relative rounded-2xl border bg-card p-6 shadow-xl shadow-slate-200/50 transition-all dark:shadow-black/30 md:p-8 ${
        dragOver
          ? "border-primary ring-2 ring-primary/30"
          : "border-border"
      }`}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/5 text-sm font-semibold text-primary">
          Drop YouTube link here
        </div>
      )}
      <div className="space-y-5">
        <div className="relative flex items-center">
          <input
            id={`url-${idSuffix}`}
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste or drop a YouTube link…"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-border bg-muted py-4 pl-4 pr-36 text-base text-foreground outline-none transition-all placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
            required
          />
          <button
            type="submit"
            disabled={summaryMut.isPending}
            title="Summarize (⌘/Ctrl + Enter)"
            className="absolute right-2 cursor-pointer rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:brightness-110 active:translate-y-px active:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {summaryMut.isPending ? "Summarizing…" : "Summarize"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-muted-foreground">Length:</span>
          <div className="flex rounded-lg bg-muted p-1">
            {LENGTH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={summaryMut.isPending}
                onClick={() => {
                  setLength(opt.value);
                  if (url.trim() && summary && opt.value !== length) {
                    runSummarize(undefined, opt.value);
                  }
                }}
                className={`cursor-pointer rounded-md px-4 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  length === opt.value
                    ? "bg-card font-semibold text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Recent + theme toggle — moved here from the empty top band */}
          <div className="ml-auto flex items-center gap-2">
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
                    <span className="text-xs font-semibold text-foreground">
                      Recent videos
                    </span>
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
                              runSummarize(h.url);
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
              onClick={() => setDark((d) => !d)}
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
              className="cursor-pointer rounded-lg border border-border bg-muted p-1.5 text-muted-foreground transition hover:text-foreground"
            >
              {dark ? (
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
          </div>
        </div>
        <div className="hidden text-[11px] text-muted-foreground md:block">
          Tip: ⌘/Ctrl + Enter to summarize. You can also drop a YouTube link onto this box.
        </div>
      </div>
    </form>
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div
        ref={topRef}
        className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:py-8"
      >
        {showModelReminder && (
          <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0 text-muted-foreground">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <div className="flex-1 text-muted-foreground">
              It's been 2+ months since we last checked for newer AI models. Ask
              the assistant: <em>"are there newer text/image models I should switch to?"</em>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowModelReminder(false);
                try {
                  localStorage.setItem(
                    MODEL_REMINDER_DISMISSED_KEY,
                    String(Date.now()),
                  );
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

        {renderControls("top")}

        {summaryMut.isError && (
          <div className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <div>{(summaryMut.error as Error).message}</div>
            {isTranscriptBlocked && (
              <button
                type="button"
                disabled={fallbackBusy}
                onClick={runFallbackClean}
                className="cursor-pointer rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {fallbackBusy
                  ? "Trying in-browser fetch…"
                  : "Try fetching transcript from your browser (best-effort)"}
              </button>
            )}
          </div>
        )}

        {videoId && (
          <section className="animate-fade-in space-y-4 pt-2">
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <button
                type="button"
                onClick={() => setVideoOpen((o) => !o)}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition hover:bg-muted"
              >
                <img
                  src={`https://i.ytimg.com/vi/${videoId}/default.jpg`}
                  alt=""
                  className="h-10 w-16 flex-shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {videoTitle ?? "YouTube video"}
                  </div>
                  {videoAuthor && (
                    <div className="truncate text-xs text-muted-foreground">
                      {videoAuthor}
                    </div>
                  )}
                </div>
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  {videoOpen ? "Hide" : "Show"} video
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${videoOpen ? "rotate-180" : ""}`}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              </button>
              {videoOpen && (
                <div className="border-t border-border bg-muted">
                  <div className="aspect-video w-full">
                    <iframe
                      className="h-full w-full"
                      src={`https://www.youtube.com/embed/${videoId}`}
                      title={videoTitle ?? "YouTube video"}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-6 rounded-2xl border border-border bg-card p-6 shadow-sm md:p-8">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div>
                  <h3 className="text-xl font-bold text-foreground">
                    Video Summary
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {detectedLang && (
                      <>
                        Source:{" "}
                        <span className="font-medium text-foreground">
                          {detectedLang}
                        </span>
                        {" · "}
                      </>
                    )}
                    {translateMut.data && (
                      <>
                        Translated to{" "}
                        <span className="font-medium text-foreground">
                          {targetLang}
                        </span>
                        {" · "}
                      </>
                    )}
                    <span title="AI model used for the summary">
                      Model:{" "}
                      <span className="font-medium text-foreground">
                        {TEXT_MODEL_LABEL}
                      </span>
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copyAll}
                    disabled={!displayContent}
                    title="Copy summary"
                    className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    {copied ? "Copied!" : "Copy"}
                  </button>
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Translate:
                  </span>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="rounded-lg border border-border bg-muted px-3 py-1.5 text-sm font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/10"
                  >
                    {POPULAR_LANGS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!summary || translateMut.isPending}
                    onClick={() =>
                      summary &&
                      translateMut.mutate({
                        summary,
                        targetLanguage: targetLang,
                      })
                    }
                    className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {translateMut.isPending ? "Translating…" : "Go"}
                  </button>
                  {translateMut.data && (
                    <button
                      type="button"
                      onClick={() => translateMut.reset()}
                      className="cursor-pointer rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Original
                    </button>
                  )}
                </div>
              </div>

              {translateMut.isError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  {(translateMut.error as Error).message}
                </div>
              )}

              <article className="text-[0.95rem] leading-relaxed text-foreground [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground [&_p]:my-3 [&_p]:text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-6 [&_li]:pl-1 [&_li]:text-muted-foreground [&_li::marker]:font-semibold [&_li::marker]:text-primary [&_a]:text-primary [&_a]:underline">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {displayContent ?? ""}
                </ReactMarkdown>
              </article>

              {/* Visual summary */}
              <div className="border-t border-border pt-5">
                {!visualOpen ? (
                  <button
                    type="button"
                    onClick={() => generateVisual(visualDetail)}
                    className="group relative inline-flex cursor-pointer items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-primary/60 via-fuchsia-500/55 to-pink-500/55 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:shadow-md hover:brightness-105 active:translate-y-px"
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
                      <h4 className="text-sm font-bold text-foreground">
                        Visual summary
                      </h4>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          Detail:
                        </span>
                        <div className="flex rounded-lg bg-muted p-1">
                          {DETAIL_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              disabled={visualLoading}
                              onClick={() => generateVisual(opt.value)}
                              className={`cursor-pointer rounded-md px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                visualDetail === opt.value
                                  ? "bg-card font-semibold text-primary shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setDark((d) => !d)}
                          title={dark ? "Switch to light mode" : "Switch to dark mode"}
                          className="cursor-pointer rounded-lg border border-border bg-muted p-1.5 text-muted-foreground transition hover:text-foreground"
                        >
                          {dark ? (
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
                        <button
                          type="button"
                          onClick={() => {
                            setVisualOpen(false);
                            setVisualSrc(null);
                            setVisualError(null);
                          }}
                          className="cursor-pointer rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Close
                        </button>
                      </div>
                    </div>

                    {visualError && (
                      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                        {visualError}
                      </div>
                    )}

                    <div className="relative overflow-hidden rounded-xl border border-border bg-muted">
                      {visualSrc ? (
                        <button
                          type="button"
                          onClick={() => visualFinal && setViewerOpen(true)}
                          className="block w-full cursor-zoom-in"
                          title={visualFinal ? "Click to zoom & pan" : ""}
                        >
                          <img
                            src={visualSrc}
                            alt="Visual summary"
                            className={`block h-auto w-full transition-[filter] duration-500 ${
                              visualFinal ? "blur-0" : "blur-xl"
                            }`}
                          />
                        </button>
                      ) : (
                        <div className="flex aspect-square items-center justify-center text-sm text-muted-foreground">
                          {visualLoading ? "Generating image…" : "Preparing…"}
                        </div>
                      )}
                      <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                        {IMAGE_MODEL_LABEL}
                      </div>
                      {visualLoading && (
                        <div className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
                          {visualFinal ? "Finalizing…" : "Rendering…"}
                        </div>
                      )}
                    </div>

                    {visualFinal && visualSrc && (
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setViewerOpen(true)}
                          className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="7" />
                            <path d="M21 21l-4.3-4.3" />
                            <path d="M8 11h6M11 8v6" />
                          </svg>
                          Zoom & pan
                        </button>
                        <a
                          href={visualSrc}
                          download={`visual-summary-${videoId}.png`}
                          className="cursor-pointer rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                        >
                          Download PNG
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {transcript && (
                <div className="border-t border-border pt-5">
                  {!chatOpen ? (
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
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-foreground">
                          Ask AI about this video
                        </h4>
                        <span className="text-[11px] text-muted-foreground">
                          Model:{" "}
                          <span className="font-medium text-foreground">
                            {TEXT_MODEL_LABEL}
                          </span>
                        </span>
                      </div>

                      {chatMessages.length > 0 && (
                        <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3">
                          {chatMessages.map((m, i) => (
                            <div
                              key={i}
                              className={`rounded-lg px-3 py-2 text-sm ${
                                m.role === "user"
                                  ? "bg-primary/10 text-foreground"
                                  : "bg-card text-foreground"
                              }`}
                            >
                              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {m.role === "user" ? "You" : "AI"}
                              </div>
                              <div className="prose-sm text-[0.9rem] leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {m.content}
                                </ReactMarkdown>
                              </div>
                            </div>
                          ))}
                          {chatMut.isPending && (
                            <div className="px-3 py-1 text-xs text-muted-foreground">
                              Thinking…
                            </div>
                          )}
                        </div>
                      )}

                      {chatMut.isError && (
                        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                          {(chatMut.error as Error).message}
                        </div>
                      )}

                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              sendChat();
                            }
                          }}
                          placeholder="Ask anything about the video…"
                          className="flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                        />
                        <button
                          type="button"
                          onClick={sendChat}
                          disabled={!chatInput.trim() || chatMut.isPending}
                          className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Send
                        </button>
                        {chatMessages.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setChatMessages([]);
                              chatMut.reset();
                            }}
                            className="cursor-pointer rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {videoId && (
          <div className="pt-2">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Summarize another video
            </p>
            {renderControls("bottom")}
          </div>
        )}

        {/* OSVidSum footer signature */}
        <footer className="flex flex-col items-center gap-1 pt-4 text-center text-xs text-muted-foreground">
          <div>
            Note: YouTube sometimes blocks transcript requests from servers. If
            you get an error, try again in a few minutes.
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

      {/* ============ Image viewer modal (pan + zoom) ============ */}
      {viewerOpen && visualSrc && (
        <ImageViewer src={visualSrc} onClose={() => setViewerOpen(false)} />
      )}
    </main>
  );
}

// ============ OSVidSum monogram (interlocked O + S, gold) ============
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
      {/* O */}
      <circle cx="10" cy="12" r="6" />
      {/* S — sweeping S that also reads as a play tick inside the O */}
      <path d="M14 9.5 c -1.5 -1 -3.5 -0.5 -3.5 1.2 c 0 1.6 3.5 1.4 3.5 3.1 c 0 1.7 -2 2.2 -3.5 1.2" />
    </svg>
  );
}

// ============ Image viewer with drag pan + wheel zoom + pinch ============
function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const pinchRef = useRef<{
    initialDist: number;
    initialScale: number;
    pointers: Map<number, { x: number; y: number }>;
  }>({ initialDist: 0, initialScale: 1, pointers: new Map() });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "0") {
        setScale(1);
        setTx(0);
        setTy(0);
      }
      if (e.key === "+" || e.key === "=")
        setScale((s) => Math.min(8, s * 1.2));
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
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy);
      if (pinchRef.current.initialDist > 0) {
        const next =
          (dist / pinchRef.current.initialDist) * pinchRef.current.initialScale;
        setScale(Math.min(8, Math.max(0.25, next)));
      }
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top bar */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between gap-2 p-3 text-white">
        <div className="flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs backdrop-blur">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.25, s / 1.2))}
            className="cursor-pointer rounded px-2 py-0.5 hover:bg-white/10"
            title="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(8, s * 1.2))}
            className="cursor-pointer rounded px-2 py-0.5 hover:bg-white/10"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => {
              setScale(1);
              setTx(0);
              setTy(0);
            }}
            className="ml-1 cursor-pointer rounded px-2 py-0.5 hover:bg-white/10"
            title="Reset (press 0)"
          >
            Reset
          </button>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={src}
            download="visual-summary.png"
            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white backdrop-blur transition hover:bg-white/20"
          >
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="cursor-pointer rounded-lg bg-white/10 p-2 text-white backdrop-blur transition hover:bg-white/20"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="h-full w-full touch-none overflow-hidden"
        style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
      >
        <img
          src={src}
          alt="Visual summary"
          draggable={false}
          className="absolute left-1/2 top-1/2 max-h-none max-w-none select-none"
          style={{
            transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "center center",
          }}
        />
      </div>

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-[11px] text-white/80 backdrop-blur">
        Drag to pan · scroll / pinch to zoom · Esc to close
      </div>
    </div>
  );
}
