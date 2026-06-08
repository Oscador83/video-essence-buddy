import { createFileRoute } from "@tanstack/react-router";

const DETAIL_GUIDANCE: Record<string, string> = {
  simple:
    "Style: minimalist sketch. Use 3-5 simple labeled icons or shapes connected with thin arrows. Plenty of white space. Hand-drawn feel.",
  medium:
    "Style: clean infographic. Use 5-8 labeled boxes/circles/icons grouped into 2-3 sections, connected with arrows showing relationships. Balanced layout, readable labels.",
  detailed:
    "Style: rich, dense infographic / mind map. Use 10-15 labeled elements organized into clear clusters with arrows, sub-arrows and short text annotations showing flow and hierarchy. Like a tutorial whiteboard.",
};

export const Route = createFileRoute("/api/generate-visual-summary")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          summary?: string;
          title?: string | null;
          detail?: "simple" | "medium" | "detailed";
        };
        const summary = (body.summary ?? "").trim();
        if (!summary) return new Response("Missing summary", { status: 400 });
        const detail = body.detail ?? "medium";

        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("Missing LOVABLE_API_KEY", { status: 500 });

        const prompt = `Create a visual summary diagram of the following video content${
          body.title ? ` (titled "${body.title}")` : ""
        }. ${DETAIL_GUIDANCE[detail]}
Use a clean light background, dark text, and one accent color. The diagram must be self-explanatory at a glance — no decorative illustration, focus on conveying the structure of ideas. Keep ALL text in the diagram in English, short, and legible.

Video summary to visualize:
${summary.slice(0, 2000)}`;

        const callUpstream = () =>
          fetch("https://ai.gateway.lovable.dev/v1/images/generations", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "openai/gpt-image-2",
              prompt,
              quality: "low",
              size: "1024x1024",
              stream: true,
              partial_images: 2,
            }),
          });

        let upstream = await callUpstream();
        // One automatic retry on timeout-class errors.
        if (
          (upstream.status === 504 ||
            upstream.status === 502 ||
            upstream.status === 408) &&
          !upstream.body
        ) {
          await new Promise((r) => setTimeout(r, 2000));
          upstream = await callUpstream();
        }

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => "");
          const friendly =
            upstream.status === 504 || upstream.status === 502 || upstream.status === 408
              ? "The image service timed out. Try again, or use a lighter detail level. (This is not a daily quota.)"
              : text || "Image generation failed";
          return new Response(friendly, { status: upstream.status });
        }

        return new Response(upstream.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      },
    },
  },
});
