import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
      { property: "og:title", content: "YouTube Video Summarizer" },
      {
        property: "og:description",
        content: "AI-powered summaries of YouTube videos in their original language.",
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

function Index() {
  const [url, setUrl] = useState("");
  const [targetLang, setTargetLang] = useState("English");
  const [length, setLength] = useState<Length>("standard");

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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    translateMut.reset();
    summaryMut.mutate({ url: url.trim(), length });
  };

  const summary = summaryMut.data?.summary;
  const videoId = summaryMut.data?.videoId;
  const detectedLang = summaryMut.data?.detectedLang;
  const displayContent = translateMut.data?.translated ?? summary;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl space-y-10 px-4 py-12 md:py-16">
        {/* Hero */}
        <header className="space-y-4 text-center">
          <div className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 shadow-sm">
            <span className="mr-2 h-2 w-2 animate-pulse rounded-full bg-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Powered by AI
            </span>
          </div>
          <h1 className="text-balance text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            YouTube Video <span className="text-primary">Summarizer</span>
          </h1>
          <p className="mx-auto max-w-xl text-balance text-lg text-muted-foreground">
            Paste a YouTube link to get a clean AI summary in the video's
            original language. Translate it to anything you want.
          </p>
        </header>

        {/* Input Card */}
        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-border bg-card p-6 shadow-xl shadow-slate-200/50 md:p-8"
        >
          <div className="space-y-6">
            <div className="relative flex items-center">
              <input
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
                        translateMut.reset();
                        summaryMut.mutate({ url: url.trim(), length: opt.value });
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
            </div>
          </div>
        </form>

        {summaryMut.isError && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {(summaryMut.error as Error).message}
          </div>
        )}

        {videoId && (
          <section className="animate-fade-in grid grid-cols-1 gap-8 pt-2 lg:grid-cols-[320px_1fr]">
            {/* Video — compact sidebar */}
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

            {/* Summary — generous room */}
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
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                  >
                    {translateMut.isPending ? "Translating…" : "Go"}
                  </button>
                  {translateMut.data && (
                    <button
                      type="button"
                      onClick={() => translateMut.reset()}
                      className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
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
            </div>
          </section>
        )}

        <footer className="text-center text-sm text-muted-foreground">
          Note: YouTube sometimes blocks transcript requests from servers. If
          you get an error, try another video.
        </footer>
      </div>
    </main>
  );
}
