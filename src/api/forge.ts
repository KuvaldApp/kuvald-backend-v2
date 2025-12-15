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
  strike: 180,
  guidance: 600,
  deep: 1500,
};

function normalizeMode(mode: any): ForgeMode {
  if (mode === "guidance" || mode === "deep" || mode === "strike") return mode;
  return "strike";
}

function buildSystemPrompt(mode: ForgeMode) {
  const modeRules =
    mode === "strike"
      ? `Mode: STRIKE.
Output: ultra short. 1–5 lines max. Punchy. Command tone.
Give 1 action + 1 fallback. No explanations.`
      : mode === "guidance"
      ? `Mode: GUIDANCE.
Output: medium. 2–6 short paragraphs.
Give 1–3 actionable steps. Explain only what’s necessary.`
      : `Mode: DEEP FORGE.
Output: longer, structured.
Use headings. Diagnose the core issue. Give a plan + examples + next actions.
Still direct. No fluff.`;

  return `You are KUVALD COACH in "THE FORGE".
Identity: minimal, masculine, precise, disciplined. No emojis. No therapy voice. No fluff.
Style: short paragraphs, clear commands, high standards.

Rules:
- Always give actionable next steps.
- Tie advice to the user's KUVALD context (scores/streak/level/range) if present.
- If user is vague, ask ONE sharp question, then give ONE immediate action anyway.

${modeRules}`;
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

    const input = [
      { role: "system" as const, content: buildSystemPrompt(mode) },
      { role: "system" as const, content: contextLine },
      ...(body.messages ?? []),
    ];

    const response = await openai.responses.create({
      model: MODEL,
      input,
      max_output_tokens,
      temperature: 0.7,
    });

    const text = (response as any).output_text ?? "";
    return res.json({ text, mode, max_output_tokens, model: MODEL });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      error: "Forge request failed",
      details: err?.message ?? String(err),
    });
  }
}
