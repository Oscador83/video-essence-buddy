import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createParser } from "eventsource-parser";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { summarizeVideo, translateSummary, chatAboutVideo } from "@/lib/api/summarize.functions";

const TEXT_MODEL_LABEL = "Gemini 3 Flash";
const IMAGE_MODEL_LABEL = "GPT Image 2";

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
const MAX_HISTORY = 5;

type HistoryItem = {
  url: string;
  videoId: string;
  title?: string | null;
  ts: number;
};

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
  const topRef = useRef<HTMLDivElement>(null);

  // Chat panel state
  type ChatMsg = { role: "user" | "assistant"; content: string };
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);

  const summarize = useServerFn(summarizeVideo);
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

  // Load persisted state
  useEffect(() => {
    try {
      const h = localStorage.getItem(HISTORY_KEY);
      if (h) setHistory(JSON.parse(h));
    } catch {
      /* ignore */
    }
    const savedTheme = localStorage.getItem(THEME_KEY);
    const prefersDark =
      savedTheme === "dark" ||
      (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setDark(prefersDark);
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
    // Reset visual + chat + collapse video when a new summary arrives
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

  const summary = summaryMut.data?.summary;
  const transcript = summaryMut.data?.transcript;
  const videoId = summaryMut.data?.videoId;
  const videoTitle = summaryMut.data?.title;
  const videoAuthor = summaryMut.data?.author;
  const detectedLang = summaryMut.data?.detectedLang;
  const displayContent = translateMut.data?.translated ?? summary;

  const openImageInNewWindow = async () => {
    if (!visualSrc) return;
    try {
      const blob = await (await fetch(visualSrc)).blob();
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank", "noopener,noreferrer");
      if (!w) {
        // popup blocked — fall back to navigation
        window.location.href = url;
      }
      // revoke later so the window has time to load
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      /* ignore */
    }
  };

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

  const InputCard = ({ idSuffix }: { idSuffix: string }) => (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl border border-border bg-card p-6 shadow-xl shadow-slate-200/50 dark:shadow-black/30 md:p-8"
    >
      <div className="space-y-6">
        <div className="relative flex items-center">
          <input
            id={`url-${idSuffix}`}
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
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

        <div className="flex flex-wrap items-center gap-4 text-sm">
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
          <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
            Tip: ⌘/Ctrl + Enter to summarize
          </span>
        </div>
      </div>
    </form>
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div
        ref={topRef}
        className="mx-auto max-w-4xl space-y-8 px-4 py-8 md:py-10"
      >
        {/* Top bar: history + theme */}
        <div className="flex items-center justify-end gap-2">
          <div className="relative" data-history-menu>
            <button
              type="button"
              onClick={() => setHistoryOpen((o) => !o)}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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
            className="cursor-pointer rounded-lg border border-border bg-card p-2 text-muted-foreground transition hover:text-foreground"
          >
            {dark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>

        <InputCard idSuffix="top" />

        {summaryMut.isError && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {(summaryMut.error as Error).message}
          </div>
        )}

        {videoId && (
          <section className="animate-fade-in space-y-4 pt-2">
            {/* Collapsible video title bar */}
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
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`transition-transform ${videoOpen ? "rotate-180" : ""}`}
                  >
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

            {/* Summary card */}
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
                      Model: <span className="font-medium text-foreground">{TEXT_MODEL_LABEL}</span>
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
                    className="group relative inline-flex cursor-pointer items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-primary/80 via-fuchsia-500/75 to-pink-500/75 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-primary/10 transition-all hover:shadow-lg hover:shadow-primary/20 hover:brightness-105 active:translate-y-px"
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
                        <img
                          src={visualSrc}
                          alt="Visual summary"
                          className={`block h-auto w-full transition-[filter] duration-500 ${
                            visualFinal ? "blur-0" : "blur-xl"
                          }`}
                        />
                      ) : (
                        <div className="flex aspect-square items-center justify-center text-sm text-muted-foreground">
                          {visualLoading
                            ? "Generating image…"
                            : "Preparing…"}
                        </div>
                      )}
                      {/* Model badge top-right */}
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
                          onClick={openImageInNewWindow}
                          title="Open in a new window so you can zoom, pan, or drag it to another screen"
                          className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M15 3h6v6" />
                            <path d="M10 14L21 3" />
                            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                          </svg>
                          Open in new window
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

              {/* Ask AI about the video */}
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
                          Model: <span className="font-medium text-foreground">{TEXT_MODEL_LABEL}</span>
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

        {/* Second input below the summary for quick re-runs */}
        {videoId && (
          <div className="pt-2">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Summarize another video
            </p>
            <InputCard idSuffix="bottom" />
          </div>
        )}

        <footer className="text-center text-sm text-muted-foreground">
          Note: YouTube sometimes blocks transcript requests from servers. If
          you get an error, try another video.
        </footer>
      </div>
    </main>
  );
}
