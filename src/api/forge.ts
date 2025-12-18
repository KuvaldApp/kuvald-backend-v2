import OpenAI from "openai";
import type { Request, Response } from "express";

// ✅ NEW: App “brain/spec” injected into system prompt
import { KUVALD_APP_SPEC } from "./kuvaldSpec";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type ForgeMode = "strike" | "guidance" | "deep";

type ForgeRequestBody = {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  mode?: ForgeMode;
  context?: {
    scores?: { total: number; body: number; mind: number; finance: number; status: number };
    streakDays?: number;
    level?: number;
    range?: "today" | "7d" | "30d";
  };
};

// ✅ HARD COST CONTROL
const MODEL = "gpt-4o-mini";
const OUTPUT_CAPS: Record<ForgeMode, number> = {
  strike: 220,
  guidance: 700,
  deep: 1600,
};

// ✅ DEBUG / VERIFY WHICH PROMPT IS LIVE
const PROMPT_VERSION = "kuvald-v3.2-brother-lock";

// Keep this on while tuning. Turn off later.
const RETURN_DEBUG = true;

// One cheap auto-retry if the model breaks rules.
const ENABLE_ONE_RETRY = true;

function normalizeMode(mode: any): ForgeMode {
  if (mode === "guidance" || mode === "deep" || mode === "strike") return mode;
  return "strike";
}

function isGreeting(text: string) {
  const t = (text ?? "").trim().toLowerCase();
  return (
    t === "hi" ||
    t === "hey" ||
    t === "hello" ||
    t === "yo" ||
    t === "sup" ||
    t.startsWith("hi ") ||
    t.startsWith("hey ") ||
    t.startsWith("hello ") ||
    t.startsWith("yo ") ||
    t.startsWith("sup ")
  );
}

/**
 * Remove markdown-ish formatting + common “template” artifacts.
 */
function stripMarkdown(s: string) {
  return (
    s
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`+/g, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*+/g, "")
      .replace(/\*+/g, "")
      .replace(/__+/g, "")
      .replace(/_+/g, "")
      .trim()
  );
}

/**
 * HARD REMOVE any lines that start with forbidden labels.
 * (Not just removing the word — nukes the whole line.)
 */
function removeForbiddenLabeledLines(s: string) {
  return s
    .split("\n")
    .filter((line) => {
      const l = line.trim().toLowerCase();
      if (l.startsWith("action:")) return false;
      if (l.startsWith("fallback:")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

const FORBIDDEN_OUTPUT_SNIPPETS = [
  "action:",
  "i can’t provide a complete list",
  "i can't provide a complete list",
  "fallback:",
  "it’s common to feel overwhelmed",
  "it's common to feel overwhelmed",
  "choose one area that resonates with you",
  "you got this king",
  "you’ve got this king",
];

function containsForbidden(s: string) {
  const t = (s ?? "").toLowerCase();
  return FORBIDDEN_OUTPUT_SNIPPETS.some((x) => t.includes(x));
}

/**
 * If the model response is too generic, we can nudge it.
 * (Kept minimal; don't over-engineer.)
 */
function looksTooGeneric(s: string) {
  const t = (s ?? "").toLowerCase();
  // common dead responses we keep seeing
  if (t.includes("log one small win") && t.includes("10-minute walk")) return true;
  if (t.includes("what’s your focus today") && t.includes("body, mind, or finance")) return true;
  return false;
}

function buildSystemPrompt(mode: ForgeMode) {
  const modeRules =
    mode === "strike"
      ? `
MODE: SPARK (strike)
- Output 2–5 lines max.
- No lists. No headings.
- End with ONE: either a single next step OR a single question.
- Be specific. No generic "go for a walk" unless user asked for body/movement.`
      : mode === "guidance"
      ? `
MODE: ANVIL (guidance)
- Output 6–14 lines. Short paragraphs.
- Give 2–4 concrete steps in normal speech (no numbered lists).
- Ask ONE sharp question only if needed.
- Include at least one “do this today” step.`
      : `
MODE: FORGE (deep)
- Output structured but plain text.
- Allowed section titles: TODAY / THIS WEEK / RULES (plain text, no markdown).
- Diagnose the pattern, give a plan, give examples.
- End with ONE forcing-clarity question.`;

  return `
You are KUVALD — the coach inside THE FORGE.

Identity:
- Not a therapist. Not a cheerleader.
- Grounded older brother energy: calm, direct, honest.
- Masculine humor is allowed only when it lands. No cringe. No try-hard.

Core job:
- Turn vague intention into a concrete move.
- Track patterns, not moods.
- Respect effort. Confront avoidance.
- Help the user build the man, not comfort the excuse.

TONE LOCK (non-negotiable):
- Natural speech. Short paragraphs.
- No corporate tone. No blog-post tone.
- No generic motivational quotes.
- Emojis: rare (max ONE), only for subtle humor.

ABSOLUTE FORBIDDEN OUTPUT:
- Never output these labels or anything like them:
  "Action:", "Fallback:"
- Never say:
  "It’s common to feel overwhelmed"
  "Choose one area that resonates with you"
- Never talk like a Medium article.

Behavior rules:
- If the user says "hi"/"hello" or is new:
  Do a REAL welcome (3–6 lines). Explain what KUVALD is + what THE FORGE does.
  Then ask ONE simple question to start.
- If user is vague:
  Ask ONE sharp question and still give ONE concrete move they can do today.
- If user avoids action / repeats excuses:
  Go dead serious. Call it out. No jokes.
- If momentum exists:
  Reinforce it. Say less. Tighten the plan.

Style phrases you MAY use (sparingly):
- "Alright."
- "Listen."
- "Hear me out."
- "Here’s the move."
- "We’re not reinventing life today."

IMPORTANT:
- Output must be plain text.
- Avoid bullet lists unless absolutely necessary.
- If you accidentally use a forbidden label, you FAILED — rewrite without it before responding.

${modeRules}
`.trim();
}

/**
 * A stricter emergency prompt used only on retry.
 * (This is what stops mini from drifting into templates.)
 */
function buildRetrySystemPrompt(mode: ForgeMode) {
  return `
You are KUVALD. You must obey these constraints:

- Output plain text only.
- Do NOT output any line containing "Action:" or "Fallback:".
- Do NOT output any list labels, templates, or coaching structures.
- Speak like a grounded older brother. Short paragraphs.
- Be specific to the user's last message.

If the user greeted you, welcome them in 3–6 lines, explain THE FORGE, ask ONE question.

If you break any rule, rewrite silently and output only the corrected answer.
`.trim();
}

async function callForgeLLM(params: {
  mode: ForgeMode;
  max_output_tokens: number;
  input: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature: number;
}) {
  const { max_output_tokens, input, temperature } = params;

  const response = await openai.responses.create({
    model: MODEL,
    input,
    max_output_tokens,
    temperature,
  });

  const raw = String((response as any).output_text ?? "").trim();
  return raw;
}

export async function forgeHandler(req: Request, res: Response) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in .env" });
    }

    const body = req.body as ForgeRequestBody;
    const mode = normalizeMode(body.mode);
    const max_output_tokens = OUTPUT_CAPS[mode];

    const scores = body.context?.scores;
    const streakDays = body.context?.streakDays ?? 0;
    const level = body.context?.level ?? 1;
    const range = body.context?.range ?? "today";

    const contextLine = scores
      ? `Context: range=${range}, level=${level}, streakDays=${streakDays}, scores(total=${scores.total}, body=${scores.body}, mind=${scores.mind}, finance=${scores.finance}, status=${scores.status}).`
      : `Context: range=${range}, level=${level}, streakDays=${streakDays}.`;

    const userLast =
      [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    const greeted = isGreeting(userLast);

    // Force greeting behavior without making it “template-y”
    const greetingDirective = greeted
      ? `User greeting detected. Do first-contact onboarding now (3–6 lines). Then ask ONE question.`
      : `No greeting. Respond normally.`;

    // ✅ NEW: Inject the KUVALD app spec as the first system message
    // This makes the model able to list habits, explain features, use the correct brand language, etc.
    const kuvaldSpecSystem = { role: "system" as const, content: KUVALD_APP_SPEC };

    // Build input (server owns system prompts)
    const input = [
      kuvaldSpecSystem,
      { role: "system" as const, content: buildSystemPrompt(mode) },
      { role: "system" as const, content: `PROMPT_VERSION=${PROMPT_VERSION}` },
      { role: "system" as const, content: contextLine },
      { role: "system" as const, content: greetingDirective },
      ...(body.messages ?? []),
    ];

    // First call
    let raw = await callForgeLLM({
      mode,
      max_output_tokens,
      input,
      temperature: 0.65, // lower temp = less template drift
    });

    let text = stripMarkdown(raw);
    text = removeForbiddenLabeledLines(text);

    // If it violates rules or looks like old “generic template”, retry once with stricter prompt.
    if (ENABLE_ONE_RETRY && (containsForbidden(text) || looksTooGeneric(text))) {
      const retryInput = [
        kuvaldSpecSystem,
        { role: "system" as const, content: buildRetrySystemPrompt(mode) },
        { role: "system" as const, content: `PROMPT_VERSION=${PROMPT_VERSION}` },
        { role: "system" as const, content: contextLine },
        { role: "system" as const, content: greetingDirective },
        ...(body.messages ?? []),
      ];

      const retryRaw = await callForgeLLM({
        mode,
        max_output_tokens,
        input: retryInput,
        temperature: 0.55,
      });

      let retryText = stripMarkdown(retryRaw);
      retryText = removeForbiddenLabeledLines(retryText);

      // Use retry if it's better (i.e., less forbidden + less generic)
      if (!containsForbidden(retryText)) text = retryText;
    }

    // Final hard guard: remove any remaining forbidden labels anywhere
    text = text.replace(/\bAction:\s*/gi, "").replace(/\bFallback:\s*/gi, "").trim();

    const payload: any = {
      text,
      mode,
      max_output_tokens,
      model: MODEL,
    };

    if (RETURN_DEBUG) {
      payload.prompt_version = PROMPT_VERSION;
      payload.server_time = new Date().toISOString();
    }

    return res.json(payload);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      error: "Forge request failed",
      details: err?.message ?? String(err),
    });
  }
}
