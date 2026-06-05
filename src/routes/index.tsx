import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { summarizeVideo, translateSummary } from "@/lib/api/summarize.functions";

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

const HISTORY_KEY = "yt-summarizer-history";
const THEME_KEY = "yt-summarizer-theme";
const MAX_HISTORY = 5;

type HistoryItem = { url: string; videoId: string; title?: string; ts: number };

function Index() {
  const [url, setUrl] = useState("");
  const [targetLang, setTargetLang] = useState("English");
  const [length, setLength] = useState<Length>("standard");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [copied, setCopied] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  const summarize = useServerFn(summarizeVideo);
  const translate = useServerFn(translateSummary);

  const summaryMut = useMutation({
    mutationFn: (vars: { url: string; length: Length }) =>
      summarize({ data: vars }),
  });

  const translateMut = useMutation({
    mutationFn: (vars: { summary: string; targetLanguage: string }) =>
      translate({ data: vars }),
  });

  // Load persisted state
  useEffect(() => {
    try {
      const h = localStorage.getItem(HISTORY_KEY);
      if (h) setHistory(JSON.parse(h));
    } catch {}
    const savedTheme = localStorage.getItem(THEME_KEY);
    const prefersDark =
      savedTheme === "dark" ||
      (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setDark(prefersDark);
  }, []);

  // Apply dark class
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }, [dark]);

  // Persist + push history on successful summary
  useEffect(() => {
    if (!summaryMut.data) return;
    const { videoId } = summaryMut.data;
    const submitted = summaryMut.variables?.url ?? url;
    setHistory((prev) => {
      const next = [
        { url: submitted, videoId, ts: Date.now() },
        ...prev.filter((p) => p.videoId !== videoId),
      ].slice(0, MAX_HISTORY);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
    // Scroll to top so user sees the new summary from its beginning
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

  const runSummarize = (overrideUrl?: string, overrideLength?: Length) => {
    const u = (overrideUrl ?? url).trim();
    if (!u) return;
    if (overrideUrl) setUrl(overrideUrl);
    translateMut.reset();
    summaryMut.mutate({ url: u, length: overrideLength ?? length });
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runSummarize();
  };

  // Cmd/Ctrl + Enter shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!summaryMut.isPending) runSummarize();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [url, length, summaryMut.isPending]);

  const summary = summaryMut.data?.summary;
  const videoId = summaryMut.data?.videoId;
  const detectedLang = summaryMut.data?.detectedLang;
  const displayContent = translateMut.data?.translated ?? summary;

  const copyAll = async () => {
    if (!displayContent) return;
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const clearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {}
  };

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
                              {h.url.replace(/^https?:\/\//, "")}
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
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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
          <section className="animate-fade-in grid grid-cols-1 gap-8 pt-2 lg:grid-cols-[320px_1fr]">
            <div className="space-y-4">
              <div className="aspect-video overflow-hidden rounded-xl bg-muted shadow-lg lg:aspect-[4/3]">
                <iframe
                  className="h-full w-full"
                  src={`https://www.youtube.com/embed/${videoId}`}
                  title="YouTube video"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>

            <div className="space-y-6 rounded-2xl border border-border bg-card p-6 shadow-sm md:p-8">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div>
                  <h3 className="text-xl font-bold text-foreground">
                    Video Summary
                  </h3>
                  {(detectedLang || translateMut.data) && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {detectedLang && (
                        <>
                          Source:{" "}
                          <span className="font-medium text-foreground">
                            {detectedLang}
                          </span>
                        </>
                      )}
                      {translateMut.data && (
                        <>
                          {detectedLang && " · "}
                          Translated to{" "}
                          <span className="font-medium text-foreground">
                            {targetLang}
                          </span>
                        </>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copyAll}
                    disabled={!displayContent}
                    title="Copy summary"
                    className="flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
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

              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  disabled
                  title="Coming soon"
                  className="cursor-not-allowed rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground opacity-70"
                >
                  ✨ Generate visual summary (coming soon)
                </button>
              </div>
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
