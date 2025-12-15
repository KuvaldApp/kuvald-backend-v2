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

function lastUserMessage(messages: ForgeRequestBody["messages"]) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return m.content ?? "";
  }
  return "";
}

function isFirstTurn(messages: ForgeRequestBody["messages"]) {
  const userCount = (messages ?? []).filter((m) => m.role === "user").length;
  const assistantCount = (messages ?? []).filter((m) => m.role === "assistant").length;
  // If user is basically starting the chat (no real assistant history yet)
  return userCount <= 1 && assistantCount === 0;
}

function looksLikeGreeting(text: string) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  return (
    t === "hi" ||
    t === "hello" ||
    t === "hey" ||
    t.startsWith("hi ") ||
    t.startsWith("hello ") ||
    t.startsWith("hey ") ||
    t.includes("what is this app") ||
    t.includes("what is this") ||
    t.includes("what do you do") ||
    t.includes("how does this work")
  );
}

function stripMarkdown(text: string) {
  if (!text) return "";
  let t = String(text);

  // remove common markdown artifacts
  t = t.replace(/\*\*(.*?)\*\*/g, "$1"); // **bold**
  t = t.replace(/\*(.*?)\*/g, "$1"); // *italic*
  t = t.replace(/^#{1,6}\s+/gm, ""); // headings
  t = t.replace(/`{1,3}([\s\S]*?)`{1,3}/g, "$1"); // code blocks
  t = t.replace(/^\s*[-*]\s+/gm, ""); // bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, ""); // numbered list markers

  // cleanup extra spacing
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function buildSystemPrompt(mode: ForgeMode) {
  // Core identity + strict output constraints = less “generic GPT”
  const base = `
You are KUVALD COACH inside THE FORGE.

Voice:
- Masculine. Calm. Direct. Not robotic. Not generic.
- You speak like a disciplined mentor, not a therapist.
- You can use at most ONE emoji, only if it adds punch. Usually none.

Hard format rules:
- Output PLAIN TEXT ONLY. No markdown. No headings. No bold. No bullet symbols like "-", "*", "•". No numbered lists.
- Keep lines short. Use spacing, not formatting.
- Do NOT use quotes around words unless truly necessary.

Behavior rules:
- Always produce something actionable now (a concrete next action).
- Ask at most ONE question per reply. If user is vague, still give one action.
- Avoid generic filler like “set goals” or “balance categories” unless the user asks for basics.
- Use the user's context (scores/streak/level/range) to make it feel personal.
- If the user asks about the app (hi / what is this), give a short intro + one question + one action.
`;

  const modeRules =
    mode === "strike"
      ? `
Mode: STRIKE
Output length: very short.
Goal: one decisive move.
Structure: 2–5 lines total.
Must include:
- One command (the action)
- One fallback (if they resist or can’t do it)
`
      : mode === "guidance"
      ? `
Mode: ANVIL (guidance)
Output length: medium.
Goal: practical steps, not lecture.
Structure: 2–6 short paragraphs.
Must include:
- One immediate action for today
- One tiny routine for the next 7 days
- One sharp question at the end
`
      : `
Mode: FORGE (deep)
Output length: longer but still tight.
Goal: diagnose, then plan.
Structure:
- 1 short diagnosis paragraph (what’s actually happening)
- 1 plan paragraph (what to do)
- 1 friction paragraph (what will try to stop them + counter)
- End with one question.
No headings, no lists, no markdown.
`;

  return `${base}\n${modeRules}`.trim();
}

function buildContextLine(body: ForgeRequestBody) {
  const scores = body.context?.scores;
  const streakDays = body.context?.streakDays ?? 0;
  const level = body.context?.level ?? 1;
  const range = body.context?.range ?? "today";

  // Give the model a concrete “read” so it can reference something real
  if (scores) {
    return `User context: range=${range}, level=${level}, streakDays=${streakDays}, scores total=${scores.total}, body=${scores.body}, mind=${scores.mind}, finance=${scores.finance}, status=${scores.status}.`;
  }
  return `User context: range=${range}, level=${level}, streakDays=${streakDays}.`;
}

function buildFirstContactHint(body: ForgeRequestBody) {
  const scores = body.context?.scores;
  const weakArea = scores
    ? ([
        { k: "body", v: scores.body },
        { k: "mind", v: scores.mind },
        { k: "finance", v: scores.finance },
        { k: "status", v: scores.status },
      ].sort((a, b) => a.v - b.v)[0]?.k ?? null)
    : null;

  // This is not shown to user; it nudges the model to “introduce” and feel intentional
  return `
If this is a first contact or greeting:
- Explain KUVALD in 2–4 lines: it tracks habits across Body/Mind/Finance/Status and turns today into a clear next action.
- Then ask ONE sharp question to pick a target.
- Then give ONE immediate action (60–120 seconds) that matches their weakest area if known (${weakArea ?? "unknown"}).
`.trim();
}

export async function forgeHandler(req: Request, res: Response) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in .env" });
    }

    const body = req.body as ForgeRequestBody;
    const mode = normalizeMode(body.mode);
    const max_output_tokens = OUTPUT_CAPS[mode];

    const userText = lastUserMessage(body.messages ?? []);
    const firstTurn = isFirstTurn(body.messages ?? []);
    const greeting = looksLikeGreeting(userText);

    // Extra nudge when the user’s first message is “hi / what is this”
    const firstContactHint =
      firstTurn || greeting ? buildFirstContactHint(body) : "";

    const input = [
      { role: "system" as const, content: buildSystemPrompt(mode) },
      { role: "system" as const, content: buildContextLine(body) },
      ...(firstContactHint ? [{ role: "system" as const, content: firstContactHint }] : []),
      ...(body.messages ?? []),
    ];

    const response = await openai.responses.create({
      model: MODEL,
      input,
      max_output_tokens,
      temperature: mode === "strike" ? 0.6 : 0.75,
      // Optional: helps reduce repetition and “samey” replies a bit
      top_p: 0.9,
    });

    const raw = (response as any).output_text ?? "";
    const text = stripMarkdown(raw);

    return res.json({ text, mode, max_output_tokens, model: MODEL });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({
      error: "Forge request failed",
      details: err?.message ?? String(err),
    });
  }
}
