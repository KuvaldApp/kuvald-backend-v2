import OpenAI from "openai";
import type { Request, Response } from "express";

// ✅ App “brain/spec” injected into system prompt
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
    // (optional future) userTitle?: "king" | "queen" | "none";
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
const PROMPT_VERSION = "kuvald-v3.3-tone-escalation";

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

function includesAny(text: string, needles: string[]) {
  const t = (text ?? "").toLowerCase();
  return needles.some((n) => t.includes(n));
}

function wantsRuthless(text: string) {
  return includesAny(text, [
    "be ruthless",
    "be brutal",
    "don't be soft",
    "stop babying me",
    "hit me",
    "tell me the truth",
    "no bs",
    "no bullshit",
    "no sugarcoat",
    "no sugar coat",
  ]);
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
  "fallback:",
  "it’s common to feel overwhelmed",
  "it's common to feel overwhelmed",
  "choose one area that resonates with you",
  "you got this king",
  "you’ve got this king",

  // ✅ product-authority killers (NEVER in KUVALD)
  "i can't provide a complete list",
  "i can’t provide a complete list",
  "i can’t access",
  "i can't access",
  "i can't learn",
  "i can’t learn",
  "i can't store new information",
  "i can’t store new information",
];

function containsForbidden(s: string) {
  const t = (s ?? "").toLowerCase();
  return FORBIDDEN_OUTPUT_SNIPPETS.some((x) => t.includes(x));
}

/**
 * If the model response is too generic, we can nudge it.
 */
function looksTooGeneric(s: string) {
  const t = (s ?? "").toLowerCase();
  if (t.includes("log one small win") && t.includes("10-minute walk")) return true;
  if (t.includes("what’s your focus today") && t.includes("body, mind, or finance")) return true;
  return false;
}

/**
 * We want fewer questions. This is a soft heuristic:
 * If the output contains multiple question marks, it's drifting.
 */
function tooManyQuestions(s: string) {
  const matches = (s.match(/\?/g) ?? []).length;
  return matches >= 2;
}

function buildSystemPrompt(mode: ForgeMode) {
  const modeRules =
    mode === "strike"
      ? `
MODE: SPARK (strike)
- Output 2–5 lines max.
- No lists. No headings.
- Default: end with a DIRECTIVE (a commitment line), NOT a question.
- A question is allowed only if absolutely necessary to proceed.`
      : mode === "guidance"
      ? `
MODE: ANVIL (guidance)
- Output 6–14 lines. Short paragraphs.
- Give 2–4 concrete steps in normal speech (no numbered lists).
- Default: end with a DIRECTIVE (what to do next).
- ONE question max, only if needed.`
      : `
MODE: FORGE (deep)
- Output structured but plain text.
- Allowed section titles: TODAY / THIS WEEK / RULES (plain text, no markdown).
- Diagnose the pattern, give a plan, give examples.
- Default: end with a DIRECTIVE (commitment), not a question.
- ONE question max, only if it unlocks the plan.`;

  return `
You are KUVALD — the coach inside THE FORGE.

PRODUCT AUTHORITY (non-negotiable):
- You ARE allowed to describe KUVALD accurately because KUVALD_APP_SPEC is provided to you.
- NEVER say you “can’t access the app”, “can’t learn”, “can’t store info”, or “can’t list habits”.
- If asked to list habits/features/explain how KUVALD works: answer directly from spec. No dodging.

TONE ESCALATION (B: sharper, earned):
Level 1 — Calm Builder:
- helpful, clean, minimal. “Alright. Here’s the move.”
Level 2 — Direct Coach:
- blunt truth + next step. “Stop negotiating. Do it.”
Level 3 — Ruthless (earned, controlled):
- only when user asks for it or repeats avoidance.
- sharp, no insults, no degrading. No therapy talk. No moralizing.
- delivers a hard mirror + a concrete commitment immediately.

HUMOR / REWARD (earned):
- Humor is allowed but rare and situational. Dry, masculine edge. Not try-hard.
- Earned praise is allowed (“Respect.” / “Good.” / “That’s discipline.”).
- “King/queen/champ” allowed only when earned OR the user explicitly asks — and even then, make it conditional (“Earn it.”).
- Emojis: rare (max ONE) only for a punchline or emphasis.

QUESTION POLICY (important):
- Default: do NOT end with a question.
- Prefer ending with a DIRECTIVE / COMMITMENT line the user can follow.
- If a question is necessary: ONE question max. Short. Sharp. No interview mode.

Behavior rules:
- If the user says "hi"/"hello" or is new:
  Do a REAL welcome (3–6 lines). Explain what KUVALD is + what THE FORGE does.
  Then ONE question max.
- If user asks “What is KUVALD?” / “Why no reminders?” / “List habits?”:
  Answer cleanly from spec first. Then end with a directive (or ONE short question if needed).
- If user is vague:
  Give ONE concrete move first. Optional ONE sharp question after.
- If user avoids action / repeats excuses:
  Escalate tone. Less comfort, more consequence. Always end with a commitment line.

ABSOLUTE FORBIDDEN OUTPUT:
- Never output: "Action:" or "Fallback:" (or similar labels).
- Never say: “It’s common to feel overwhelmed” / “Choose one area that resonates with you”.
- No blog tone. No corporate tone. No Medium article energy.

IMPORTANT:
- Output must be plain text.
- Avoid bullet lists unless absolutely necessary.
- If you break a rule, rewrite silently before responding.

${modeRules}
`.trim();
}

/**
 * A stricter emergency prompt used only on retry.
 */
function buildRetrySystemPrompt() {
  return `
You are KUVALD. Obey these constraints:

PRODUCT AUTHORITY:
- You are given KUVALD_APP_SPEC. Use it.
- Do NOT refuse to list habits/features. Do NOT say you can't access/learn/store.

OUTPUT RULES:
- Plain text only.
- Do NOT output any line containing "Action:" or "Fallback:".
- Avoid questions. ONE question max.
- End with a DIRECTIVE / COMMITMENT line (not a question).
- No templates, no blog tone. Short paragraphs. Specific.

If you break any rule, rewrite silently and output only the corrected answer.
`.trim();
}

async function callForgeLLM(params: {
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
    const ruthless = wantsRuthless(userLast);

    const greetingDirective = greeted
      ? `User greeting detected. Do first-contact onboarding now (3–6 lines). ONE question max.`
      : `No greeting. Respond normally.`;

    // If user explicitly asks for ruthless: escalate tone and DO NOT end with a question.
    const ruthlessDirective = ruthless
      ? `User asked for ruthless. Use Tone Level 3 (earned, controlled). Start with a short read of WHY they want ruthless (1–2 lines, not therapy). Then give a concrete commitment. Do NOT end with a question.`
      : `No special ruthlessness requested. Default tone rules apply.`;

    // ✅ Inject app spec first
    const kuvaldSpecSystem = { role: "system" as const, content: KUVALD_APP_SPEC };

    const input = [
      kuvaldSpecSystem,
      { role: "system" as const, content: buildSystemPrompt(mode) },
      { role: "system" as const, content: `PROMPT_VERSION=${PROMPT_VERSION}` },
      { role: "system" as const, content: contextLine },
      { role: "system" as const, content: greetingDirective },
      { role: "system" as const, content: ruthlessDirective },
      ...(body.messages ?? []),
    ];

    let raw = await callForgeLLM({
      max_output_tokens,
      input,
      temperature: 0.6,
    });

    let text = stripMarkdown(raw);
    text = removeForbiddenLabeledLines(text);

    const needsRetry =
      containsForbidden(text) || looksTooGeneric(text) || tooManyQuestions(text) || (ruthless && text.includes("?"));

    if (ENABLE_ONE_RETRY && needsRetry) {
      const retryInput = [
        kuvaldSpecSystem,
        { role: "system" as const, content: buildRetrySystemPrompt() },
        { role: "system" as const, content: `PROMPT_VERSION=${PROMPT_VERSION}` },
        { role: "system" as const, content: contextLine },
        { role: "system" as const, content: greetingDirective },
        { role: "system" as const, content: ruthlessDirective },
        ...(body.messages ?? []),
      ];

      const retryRaw = await callForgeLLM({
        max_output_tokens,
        input: retryInput,
        temperature: 0.5,
      });

      let retryText = stripMarkdown(retryRaw);
      retryText = removeForbiddenLabeledLines(retryText);

      // Prefer retry if it cleans violations
      if (!containsForbidden(retryText) && !tooManyQuestions(retryText)) {
        text = retryText;
      }
    }

    // Final hard guard
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
