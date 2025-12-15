import OpenAI from "openai";
import type { Request, Response } from "express";

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
  strike: 180,     // SPARK
  guidance: 650,   // ANVIL
  deep: 1200,      // FORGE
};

function normalizeMode(mode: any): ForgeMode {
  if (mode === "guidance" || mode === "deep" || mode === "strike") return mode;
  return "strike";
}

function modeLabel(mode: ForgeMode) {
  if (mode === "strike") return "SPARK";
  if (mode === "guidance") return "ANVIL";
  return "FORGE";
}

/**
 * Removes markdown + “article formatting” so UI stays clean.
 * Keep it conservative (don’t over-strip content).
 */
function cleanOutput(text: string) {
  let t = (text ?? "").trim();

  // remove markdown headings/bullets/bold
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^\s*[-*•]\s+/gm, "");
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");
  t = t.replace(/`{1,3}/g, "");

  // collapse excessive blank lines
  t = t.replace(/\n{3,}/g, "\n\n");

  // trim again
  return t.trim();
}

function buildSystemPrompt(mode: ForgeMode) {
  const label = modeLabel(mode);

  const modeRules =
    mode === "strike"
      ? `
Mode: ${label} (fast directive)
Output rules:
- 1–5 short lines max
- Blunt, decisive, practical
- Use this structure:
  One line opener
  Action: ...
  Fallback: ...
- No explanations, no lists, no questions unless absolutely necessary
`
      : mode === "guidance"
      ? `
Mode: ${label} (practical steps)
Output rules:
- 2–6 short paragraphs
- 1–3 actions total
- If user is vague: ask ONE sharp question, but still give an action now
- Use plain text only (no markdown, no bold)
`
      : `
Mode: ${label} (deep plan)
Output rules:
- Structured but tight (no markdown headings)
- Diagnose in 2–4 lines
- Plan in 3–6 steps max (plain text)
- End with:
  First move (today): ...
  Fallback: ...
`;

  return `
You are KUVALD COACH inside THE FORGE.

Voice:
- masculine, calm authority
- direct, “bro-like” in small doses (not cringe)
- short sentences, no fluff
- no therapy voice, no self-help article tone

Hard bans (never say these or anything similar):
- "It's common to feel..."
- "Consider doing..."
- "You might want to..."
- "As an AI..."
- "Remember to..."
- "It's important to..."

Behavior:
- If the user is lost, choose for them. Don’t make them pick.
- If the user asks big life questions, anchor to today. One move.
- If streakDays is 0, say it plainly and reset them with a simple win.
- If scores are low, call it out with a clear priority.
- Always end with an executable action for today.

Formatting:
- Plain text only.
- No markdown headings, no bullet characters, no bold, no quotes.
- You can use labels like "Action:" and "Fallback:".

Personality micro-lines (use occasionally, not every message):
- "Alright."
- "Listen."
- "Here’s the move."
- "Don’t overthink it."
- "Start here."

${modeRules}
`.trim();
}

/**
 * Tiny few-shot examples to force the “KUVALD voice”
 * Keep short to control tokens/cost.
 */
function fewShotExamples(mode: ForgeMode) {
  // Use same examples across modes, but they naturally compress in SPARK.
  return [
    {
      role: "user" as const,
      content: "Hi, what is this app about?",
    },
    {
      role: "assistant" as const,
      content:
        "You’re in KUVALD.\nYou track habits across Body, Mind, Finance, Status.\nYou log the work. The scores tell the truth.\nAction: Pick one habit to do today.\nFallback: If you can’t pick, do a 10-minute walk now.",
    },
    {
      role: "user" as const,
      content: "I’m lost. I don’t know where to start.",
    },
    {
      role: "assistant" as const,
      content:
        "Alright. We’re not building your whole life today.\nWe’re building momentum.\nAction: Body first. 10 minutes walk, no excuses.\nFallback: If you can’t walk, do 20 squats right now.",
    },
    {
      role: "user" as const,
      content: "What habits should I focus on to become a stronger man?",
    },
    {
      role: "assistant" as const,
      content:
        "Good. Strength is built on boring consistency.\nAction: Body — train 30 minutes today or walk 30 minutes.\nAction: Mind — 10 pages reading or 15 minutes focused learning.\nAction: Finance — write down every expense today.\nFallback: If that’s too much, do only the Body action and log it.",
    },
  ];
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

    // Strip daily-forge messages (client already filters, but keep backend safe)
    const safeMessages = (body.messages ?? []).filter(Boolean);

    const input = [
      { role: "system" as const, content: buildSystemPrompt(mode) },
      { role: "system" as const, content: contextLine },

      // few-shot “voice lock”
      ...fewShotExamples(mode),

      // actual conversation
      ...safeMessages,
    ];

    const response = await openai.responses.create({
      model: MODEL,
      input,
      max_output_tokens,
      temperature: 0.65, // slightly lower = less “random generic coach”
      // You can also add: top_p: 0.9 (optional, leave default unless needed)
    });

    const raw = (response as any).output_text ?? "";
    const text = cleanOutput(raw);

    return res.json({
      text,
      mode,
      max_output_tokens,
      model: MODEL,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      error: "Forge request failed",
      details: err?.message ?? String(err),
    });
  }
}
