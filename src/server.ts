import "dotenv/config";
import express from "express";
import cors from "cors";

import { forgeHandler } from "./api/forge";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ✅ Optional: root route so browser doesn’t show "Cannot GET /"
app.get("/", (_req, res) => {
  res.send("KUVALD backend is running. Use /health or POST /forge");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/forge", forgeHandler);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

app.listen(PORT, () => {
  console.log(`[KUVALD backend] running on http://localhost:${PORT}`);
});
