// Typed localStorage persistence with a schema version.
// Stores the entire app session so a window resize / refresh never loses work.

export type Length = "short" | "standard" | "detailed";
export type Detail = "simple" | "medium" | "detailed";
export type VisualStatus = "idle" | "loading" | "done" | "error";
export type TextStatus = "idle" | "loading" | "done" | "error";
export type ChatMsg = { role: "user" | "assistant"; content: string };

export type Card = {
  id: string;
  url: string;
  length: Length;
  customInstructions: string;
  videoId: string | null;
  title: string | null;
  author: string | null;
  detectedLang: string | null;
  transcript: string | null;
  textStatus: TextStatus;
  text: string | null;
  textError: string | null;
  translated: { lang: string; content: string } | null;
  videoOpen: boolean;
  visualOpen: boolean;
  visualDetail: Detail;
  visualStatus: VisualStatus;
  visualSrc: string | null;
  visualFinal: boolean;
  visualError: string | null;
  chat: ChatMsg[];
  createdAt: number;
};

export type GlobalSection = {
  status: TextStatus | "stale";
  summary: string | null;
  error: string | null;
  visualStatus: VisualStatus;
  visualSrc: string | null;
  visualFinal: boolean;
  visualDetail: Detail;
  visualError: string | null;
  chat: ChatMsg[];
  useTranscripts: boolean;
};

export type InputDraft = {
  url: string;
  length: Length;
  customInstructions: string;
};

export type Session = {
  v: 1;
  autoSummarize: boolean;
  multiMode: boolean;
  theme: "light" | "dark";
  targetLang: string;
  input: InputDraft;
  cards: Card[];
  global: GlobalSection | null;
};

const KEY = "osvidsum:session:v1";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function makeFilledCard(init: Partial<Card> & { id?: string }): Card {
  return {
    id: init.id ?? newId(),
    url: "",
    length: "standard",
    customInstructions: "",
    videoId: null,
    title: null,
    author: null,
    detectedLang: null,
    transcript: null,
    textStatus: "idle",
    text: null,
    textError: null,
    translated: null,
    videoOpen: false,
    visualOpen: false,
    visualDetail: "medium",
    visualStatus: "idle",
    visualSrc: null,
    visualFinal: false,
    visualError: null,
    chat: [],
    createdAt: Date.now(),
    ...init,
  };
}

export function makeEmptyGlobal(): GlobalSection {
  return {
    status: "idle",
    summary: null,
    error: null,
    visualStatus: "idle",
    visualSrc: null,
    visualFinal: false,
    visualDetail: "medium",
    visualError: null,
    chat: [],
    useTranscripts: false,
  };
}

export function defaultSession(): Session {
  return {
    v: 1,
    autoSummarize: true,
    multiMode: false,
    theme: "light",
    targetLang: "English",
    input: { url: "", length: "standard", customInstructions: "" },
    cards: [],
    global: null,
  };
}

export function loadSession(): Session {
  if (typeof window === "undefined") return defaultSession();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSession();
    const parsed = JSON.parse(raw) as Session;
    if (parsed?.v !== 1 || !Array.isArray(parsed.cards)) {
      return defaultSession();
    }
    // Reset transient loading states from a previous session
    parsed.cards = parsed.cards.map((c) => ({
      ...c,
      textStatus: c.text ? "done" : "idle",
      visualStatus: c.visualFinal ? "done" : c.visualSrc ? "done" : "idle",
    }));
    if (parsed.global) {
      parsed.global.status = parsed.global.summary ? "done" : "idle";
      parsed.global.visualStatus = parsed.global.visualFinal
        ? "done"
        : parsed.global.visualSrc
          ? "done"
          : "idle";
    }
    if (!parsed.input) parsed.input = { url: "", length: "standard", customInstructions: "" };
    return parsed;
  } catch {
    return defaultSession();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveSession(s: Session) {
  if (typeof window === "undefined") return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // Quota exceeded — drop generated images.
      try {
        const slim: Session = {
          ...s,
          cards: s.cards.map((c) => ({
            ...c,
            visualSrc: null,
            visualStatus: "idle",
            visualFinal: false,
          })),
          global: s.global
            ? {
                ...s.global,
                visualSrc: null,
                visualStatus: "idle",
                visualFinal: false,
              }
            : null,
        };
        localStorage.setItem(KEY, JSON.stringify(slim));
      } catch {
        /* ignore */
      }
    }
  }, 250);
}

export function clearSession() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
