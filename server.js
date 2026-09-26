// ============================================================
// Foundational Principles ECS — AI Study Assistant Proxy Server
// ============================================================
// This server holds the real Anthropic API key so it never has to be
// shipped inside the distributed offline app. Deploy this separately
// (see README.md) and put its public URL into the app's Settings screen.
//
// Endpoints:
//   POST /ask   { question, section: {chapterNum, chapterTitle} | null, history, accessCode }
//   POST /quiz  { chapterNum, chapterTitle, accessCode }
//   GET  /health

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const PORT = process.env.PORT || 3000;

// Comma-separated list of allowed access codes, e.g. "ECS2026,FPO-EEE-101"
// Leave ALLOWED_ACCESS_CODES unset in the environment to allow anyone (not recommended for production).
const ALLOWED_CODES = (process.env.ALLOWED_ACCESS_CODES || "").split(",").map(s => s.trim()).filter(Boolean);

// Simple per-identity daily request cap (resets when the server restarts; swap for a real
// database/Redis store if you need it to persist across restarts or scale to multiple instances).
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "40", 10);
const usage = new Map(); // key -> { count, day }

const BOOK = JSON.parse(fs.readFileSync(path.join(__dirname, "book_text.json"), "utf-8"));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Access control ----------
function checkAccess(req, res) {
  const code = (req.body && req.body.accessCode) || "";
  if (ALLOWED_CODES.length > 0 && !ALLOWED_CODES.includes(code)) {
    res.status(403).json({ error: "Invalid or missing access code. Ask your instructor for the correct code in Settings." });
    return null;
  }
  const identity = code || req.ip;
  const today = new Date().toISOString().slice(0, 10);
  const rec = usage.get(identity);
  if (!rec || rec.day !== today) {
    usage.set(identity, { count: 1, day: today });
    return identity;
  }
  if (rec.count >= DAILY_LIMIT) {
    res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} AI requests reached for today. Try again tomorrow, or keep using the app's fully offline features.` });
    return null;
  }
  rec.count += 1;
  return identity;
}

// ---------- Anthropic call helper ----------
async function callClaude(messages, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === "text");
  return textBlock ? textBlock.text : "";
}

// ---------- Simple whole-book keyword search (fallback when section context isn't enough) ----------
function keywordSearch(query, topN = 2) {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const scored = BOOK.map(ch => {
    const lower = ch.text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const matches = lower.split(t).length - 1;
      score += matches;
    }
    return { ch, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).filter(s => s.score > 0).map(s => s.ch);
}

function chapterByNum(num) {
  return BOOK.find(c => c.number === num);
}

function truncate(text, maxChars) {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
}

// ============================================================
// POST /ask
// ============================================================
app.post("/ask", async (req, res) => {
  try {
    const identity = checkAccess(req, res);
    if (!identity) return;

    const { question, section, history } = req.body;
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing question." });
    }

    let contextChapters = [];
    let usedFallback = false;

    if (section && section.chapterNum) {
      const ch = chapterByNum(section.chapterNum);
      if (ch) contextChapters = [ch];
    }

    // Step 1: if we have a specific section, try answering from it alone first,
    // asking the model to flag if it genuinely can't from that context.
    if (contextChapters.length > 0) {
      const ctx = truncate(contextChapters[0].text, 60000);
      const probeMessages = [{
        role: "user",
        content: `You are a study assistant for the textbook "Foundational Principles of Electronic Communication Systems". ` +
          `A student is currently reading Chapter ${contextChapters[0].number}: ${contextChapters[0].title}. ` +
          `Answer their question using ONLY the chapter text below. If the question truly cannot be answered from this chapter ` +
          `(it's about a different topic covered elsewhere in the book), reply with exactly: NEEDS_WIDER_SEARCH\n\n` +
          `--- CHAPTER TEXT ---\n${ctx}\n--- END CHAPTER TEXT ---\n\n` +
          `Student's question: ${question}`
      }];
      const answer = await callClaude(probeMessages, 700);
      if (!answer.trim().startsWith("NEEDS_WIDER_SEARCH")) {
        return res.json({ answer: answer.trim(), scope: `Chapter ${contextChapters[0].number}` });
      }
      usedFallback = true;
    }

    // Step 2: whole-book keyword search fallback (or default when no section was open)
    const matches = keywordSearch(question, 2);
    if (matches.length === 0) {
      // last resort: no strong keyword match, just use the currently open chapter if any, else the whole TOC
      const fallbackCtx = contextChapters.length
        ? contextChapters[0].text
        : BOOK.map(c => `Chapter ${c.number}: ${c.title}`).join("\n");
      const messages = [{
        role: "user",
        content: `You are a study assistant for the textbook "Foundational Principles of Electronic Communication Systems". ` +
          `Answer the student's question as well as you can. If you're not confident the book covers this, say so honestly.\n\n` +
          `Available context:\n${truncate(fallbackCtx, 20000)}\n\nStudent's question: ${question}`
      }];
      const answer = await callClaude(messages, 700);
      return res.json({ answer: answer.trim(), scope: "best effort (no strong match found)" });
    }

    const combinedCtx = matches.map(ch => `### Chapter ${ch.number}: ${ch.title}\n${truncate(ch.text, 40000)}`).join("\n\n");
    const messages = [{
      role: "user",
      content: `You are a study assistant for the textbook "Foundational Principles of Electronic Communication Systems". ` +
        `Answer the student's question using the most relevant chapter(s) below. Mention which chapter your answer draws from.\n\n` +
        `${combinedCtx}\n\nStudent's question: ${question}`
    }];
    const answer = await callClaude(messages, 800);
    return res.json({ answer: answer.trim(), scope: `whole-book search: ${matches.map(m => `Ch.${m.number}`).join(", ")}`, usedFallback });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong answering that question. Please try again." });
  }
});

// ============================================================
// POST /quiz
// ============================================================
app.post("/quiz", async (req, res) => {
  try {
    const identity = checkAccess(req, res);
    if (!identity) return;

    const { chapterNum } = req.body;
    const ch = chapterByNum(chapterNum);
    if (!ch) return res.status(400).json({ error: "Unknown chapter." });

    const prompt = `You are creating a 5-question multiple-choice practice quiz for engineering students, based ONLY on the ` +
      `textbook chapter below (Chapter ${ch.number}: ${ch.title}, from "Foundational Principles of Electronic Communication Systems"). ` +
      `Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:\n` +
      `{"questions":[{"prompt":"...","options":[{"text":"...","correct":true},{"text":"...","correct":false},{"text":"...","correct":false},{"text":"...","correct":false}],"explanation":"..."}]}\n` +
      `Requirements: exactly 5 questions, exactly 4 options each with exactly one marked correct:true, questions should cover ` +
      `distinct parts of the chapter, explanations should be 1-2 sentences citing the relevant concept.\n\n` +
      `--- CHAPTER TEXT ---\n${truncate(ch.text, 80000)}\n--- END CHAPTER TEXT ---`;

    const raw = await callClaude([{ role: "user", content: prompt }], 2000);
    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: "The quiz generator returned an unexpected format. Please try again." });
    }
    res.json(parsed);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the quiz. Please try again." });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", model: ANTHROPIC_MODEL, chapters: BOOK.length }));

app.listen(PORT, () => console.log(`Study-assistant server running on port ${PORT}`));
