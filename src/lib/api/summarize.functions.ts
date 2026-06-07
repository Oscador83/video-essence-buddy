import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { YoutubeTranscript } from "youtube-transcript";
import { TEXT_MODEL_ID } from "@/lib/models";


function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  // raw 11-char id
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") return url.pathname.slice(1) || null;
    if (url.hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      const idx = parts.findIndex((p) => ["shorts", "embed", "live"].includes(p));
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {
    // not a URL
  }
  return null;
}

async function callLovableAI(messages: Array<{ role: string; content: string }>) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("AI is not configured (LOVABLE_API_KEY missing).");

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TEXT_MODEL_ID,
      messages,
    }),
  });


  if (!res.ok) {
    if (res.status === 429) throw new Error("AI rate limit reached. Try again in a minute.");
    if (res.status === 402) throw new Error("AI credits exhausted on this workspace.");
    const t = await res.text();
    throw new Error(`AI gateway error (${res.status}): ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI returned an empty response.");
  return content;
}

const LENGTHS = ["short", "standard", "detailed"] as const;
type Length = (typeof LENGTHS)[number];

const LENGTH_INSTRUCTIONS: Record<Length, string> = {
  short:
    "Keep it very concise: a 1-2 sentence overview, then 3-4 bullet points. Aim for ~120 words total.",
  standard:
    "A 2-3 sentence overview, then 5-8 bullet points of key takeaways. Aim for ~300 words.",
  detailed:
    "Write a thorough breakdown: a short overview, then section headings (## ) grouping related ideas, with bullet points under each. Include nuances, examples, and any numbered lists the speaker presents. Aim for ~700 words.",
};

export const summarizeVideo = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      url: z.string().min(1).max(500),
      length: z.enum(LENGTHS).default("standard"),
    }),
  )
  .handler(async ({ data }) => {
    const videoId = extractVideoId(data.url);
    if (!videoId) {
      throw new Error("Could not parse a YouTube video ID from that input.");
    }

    // Fetch the video title in parallel (oEmbed is public, no key needed)
    const titlePromise = fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    )
      .then((r) => (r.ok ? (r.json() as Promise<{ title?: string; author_name?: string }>) : null))
      .catch(() => null);

    let segments: Array<{ text: string; lang?: string }> = [];
    try {
      segments = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const blocked =
        /disabled|blocked|429|403|captcha|too many requests/i.test(msg);
      if (blocked) {
        throw new Error(
          "YouTube is temporarily blocking transcript requests from our server. This usually clears up in a few minutes — try again shortly, or try a different video. (You can also try the in-browser fallback if available.)",
        );
      }
      throw new Error(
        `Couldn't fetch the transcript for this video. Details: ${msg}`,
      );
    }


    if (!segments.length) {
      throw new Error("No transcript was returned for this video.");
    }

    const meta = await titlePromise;

    const transcript = segments
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    // Cap transcript size to keep token usage sane
    const MAX_CHARS = 60_000;
    const truncated = transcript.length > MAX_CHARS;
    const transcriptForAI = truncated ? transcript.slice(0, MAX_CHARS) : transcript;

    const detectedLang = segments.find((s) => s.lang)?.lang ?? null;

    const system = `You are an expert video summarizer.
LANGUAGE RULES (CRITICAL):
- Detect the language of the transcript.
- If the transcript is in English, Spanish, Catalan, or French, write the ENTIRE summary in THAT SAME language. Never switch to another language.
- If the transcript is in any other language, write the summary in English.
- Never translate between English / Spanish / Catalan / French — preserve the source language exactly.
- Transcript language hint (from YouTube, may be missing or inaccurate — trust the actual transcript text over this): ${detectedLang ?? "unknown"}.
STRUCTURE:
- Length & structure: ${LENGTH_INSTRUCTIONS[data.length]}
- Use clear Markdown formatting. When the video presents a list (top N, steps, tips, reasons), render it as a Markdown list — use a numbered list (1. 2. 3.) when order matters or when the speaker explicitly numbers items, otherwise use bullets (- ). Use "## " section headings to group related points when helpful.
- No preamble like "Here is the summary".`;

    const user = `Summarize this YouTube video transcript${
      truncated ? " (note: transcript was truncated to fit)" : ""
    }:

${transcriptForAI}`;

    const summary = await callLovableAI([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

    return {
      videoId,
      summary,
      detectedLang,
      title: meta?.title ?? null,
      author: meta?.author_name ?? null,
      transcript: transcriptForAI,
      transcriptChars: transcript.length,
      truncated,
    };
  });

export const chatAboutVideo = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      transcript: z.string().min(1).max(80_000),
      title: z.string().max(300).nullable().optional(),
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(4_000),
          }),
        )
        .min(1)
        .max(30),
    }),
  )
  .handler(async ({ data }) => {
    const system = `You are an assistant answering questions about a YouTube video.
You have ONLY the transcript below as your source. If the answer isn't in the transcript, say so briefly.
Answer in the same language as the user's question. Keep answers concise and use Markdown when helpful.
${data.title ? `Video title: ${data.title}\n` : ""}
TRANSCRIPT:
${data.transcript}`;

    const reply = await callLovableAI([
      { role: "system", content: system },
      ...data.messages,
    ]);
    return { reply };
  });

export const translateSummary = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      summary: z.string().min(1).max(20_000),
      targetLanguage: z.string().min(1).max(60),
    }),
  )
  .handler(async ({ data }) => {
    const translated = await callLovableAI([
      {
        role: "system",
        content: `You are a professional translator. Translate the user's Markdown content into ${data.targetLanguage}. Preserve all Markdown formatting (headings, bullets, bold). Output ONLY the translation, no commentary.`,
      },
      { role: "user", content: data.summary },
    ]);
    return { translated };
  });

// Summarize from a transcript fetched on the client (e.g. via a CORS proxy)
// when the server-side YouTube fetch is blocked.
export const summarizeWithTranscript = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      videoId: z.string().min(1).max(64),
      transcript: z.string().min(20).max(120_000),
      length: z.enum(LENGTHS).default("standard"),
      title: z.string().max(300).nullable().optional(),
      author: z.string().max(200).nullable().optional(),
      detectedLang: z.string().max(16).nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const cleaned = data.transcript.replace(/\s+/g, " ").trim();
    const MAX_CHARS = 60_000;
    const truncated = cleaned.length > MAX_CHARS;
    const transcriptForAI = truncated ? cleaned.slice(0, MAX_CHARS) : cleaned;

    const system = `You are an expert video summarizer.
LANGUAGE RULES (CRITICAL):
- Detect the language of the transcript.
- If the transcript is in English, Spanish, Catalan, or French, write the ENTIRE summary in THAT SAME language. Never switch.
- If the transcript is in any other language, write the summary in English.
- Transcript language hint: ${data.detectedLang ?? "unknown"}.
STRUCTURE:
- Length & structure: ${LENGTH_INSTRUCTIONS[data.length]}
- Use clear Markdown. Use lists for enumerations, "## " headings to group ideas.
- No preamble like "Here is the summary".`;

    const user = `Summarize this YouTube video transcript${
      truncated ? " (note: transcript was truncated)" : ""
    }:\n\n${transcriptForAI}`;

    const summary = await callLovableAI([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

    return {
      videoId: data.videoId,
      summary,
      detectedLang: data.detectedLang ?? null,
      title: data.title ?? null,
      author: data.author ?? null,
      transcript: transcriptForAI,
      transcriptChars: cleaned.length,
      truncated,
    };
  });
