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

function Index() {
  const [url, setUrl] = useState("");
  const [targetLang, setTargetLang] = useState("English");

  const summarize = useServerFn(summarizeVideo);
  const translate = useServerFn(translateSummary);

  const summaryMut = useMutation({
    mutationFn: (videoUrl: string) => summarize({ data: { url: videoUrl } }),
  });

  const translateMut = useMutation({
    mutationFn: (vars: { summary: string; targetLanguage: string }) =>
      translate({ data: vars }),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    translateMut.reset();
    summaryMut.mutate(url.trim());
  };

  const summary = summaryMut.data?.summary;
  const videoId = summaryMut.data?.videoId;
  const detectedLang = summaryMut.data?.detectedLang;
  const displayContent = translateMut.data?.translated ?? summary;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-12 md:py-20">
        <header className="mb-10 text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            Powered by AI
          </div>
          <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-5xl">
            YouTube Video <span className="text-primary">Summarizer</span>
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-balance text-muted-foreground">
            Paste a YouTube link to get a clean AI summary in the video's
            original language. Translate it to anything you want.
          </p>
        </header>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-border bg-card p-2 shadow-sm"
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full flex-1 rounded-xl bg-transparent px-4 py-3 text-base outline-none placeholder:text-muted-foreground"
              required
            />
            <button
              type="submit"
              disabled={summaryMut.isPending}
              className="inline-flex items-center justify-center rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {summaryMut.isPending ? "Summarizing…" : "Summarize"}
            </button>
          </div>
        </form>

        {summaryMut.isError && (
          <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {(summaryMut.error as Error).message}
          </div>
        )}

        {videoId && (
          <section className="mt-8 space-y-6">
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="aspect-video w-full">
                <iframe
                  className="h-full w-full"
                  src={`https://www.youtube.com/embed/${videoId}`}
                  title="YouTube video"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  {detectedLang ? (
                    <>
                      Source language:{" "}
                      <span className="font-medium text-foreground">
                        {detectedLang}
                      </span>
                    </>
                  ) : (
                    "Summary"
                  )}
                  {translateMut.data && (
                    <>
                      {" · Translated to "}
                      <span className="font-medium text-foreground">
                        {targetLang}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
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
                    className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                  >
                    {translateMut.isPending ? "Translating…" : "Translate"}
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
                <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  {(translateMut.error as Error).message}
                </div>
              )}

              <article className="prose prose-sm max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {displayContent ?? ""}
                </ReactMarkdown>
              </article>
            </div>
          </section>
        )}

        <footer className="mt-12 text-center text-xs text-muted-foreground">
          Note: YouTube sometimes blocks transcript requests from servers. If
          you get an error, try another video.
        </footer>
      </div>
    </main>
  );
}
