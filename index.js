// DECISION ROOM — quota-friendly build
//
// Free-tier Gemini only allows 20 requests per day for this model,
// so this version does each decision in 3 calls instead of 7:
//   1. Panel call — Strategist + Researcher + Analyst + Risk Officer combined
//   2. Devils Advocate — attacks the panel's leading option
//   3. Judge — reads everything, reconsiders, gives the final verdict
//
// Greetings still get one fast reply with no panel at all.

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const STYLE_NOTE =
  "Avoid unnecessary punctuation marks such as exclamation marks semicolons and extra commas. Keep sentences plain and direct.";

// Calls Gemini, and automatically waits and retries once if the free
// daily quota gives a temporary rate-limit error.
async function callAgent(systemRole, userContent, attempt = 1) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: `${systemRole}\n${STYLE_NOTE}\n\n${userContent}`,
      config: {
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    });
    return response.text.trim();
  } catch (err) {
    const isRateLimit = err?.status === 429 || err?.message?.includes("RESOURCE_EXHAUSTED");
    const isOverloaded = err?.status === 503 || err?.message?.includes("UNAVAILABLE");

    if (isOverloaded && attempt < 3) {
      console.log(`Model overloaded, waiting a bit and retrying (attempt ${attempt})...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return callAgent(systemRole, userContent, attempt + 1);
    }
    if (isRateLimit && attempt < 3) {
      console.log(`Rate limited, waiting a bit and retrying (attempt ${attempt})...`);
      await new Promise((resolve) => setTimeout(resolve, 20000));
      return callAgent(systemRole, userContent, attempt + 1);
    }
    if (isRateLimit) {
      throw new Error(
        "Daily free quota for the AI model is used up. Try again after it resets, or reduce how many test messages you send per day."
      );
    }
    if (isOverloaded) {
      throw new Error(
        "The AI model is overloaded with traffic right now. Wait a minute and try again."
      );
    }
    throw err;
  }
}

function isGreeting(text) {
  const cleaned = text.trim().toLowerCase().replace(/[^\w\s]/g, "");
  const greetings = [
    "hi", "hello", "hey", "hiya", "yo", "sup", "howdy",
    "good morning", "good afternoon", "good evening",
    "whats up", "how are you", "hows it going",
  ];
  return greetings.some(
    (g) => cleaned === g || cleaned.startsWith(g + " ")
  );
}

async function handleGreeting(text) {
  return callAgent(
    "You are a friendly assistant having a quick casual text conversation. Reply in one short natural sentence.",
    `Message: "${text}"`
  );
}

async function runDecisionRoom(decisionText, space) {
  // 1. PANEL — Strategist, Researcher, Analyst, and Risk Officer combined
  // into a single call to save on daily quota.
  const panelOutput = await callAgent(
    `You are running a decision panel with four roles in one response. Cover all four clearly labeled sections for the decision below.

STRATEGIST: identify 2 to 4 concrete distinct options, a short label plus one sentence each
RESEARCHER: for each option one or two concrete supporting facts
ANALYST: pick the single strongest option right now and explain your reasoning with rough numbers or concrete logic end this section with LEADING OPTION followed by the name
RISK OFFICER: for each option the single biggest risk or failure mode`,
    `Decision: "${decisionText}"`
  );
  await space.send(`PANEL\n${panelOutput}`);

  // 2. DEVIL'S ADVOCATE
  const devilsAdvocateOutput = await callAgent(
    "You are the Devils Advocate. Your only job is to find the single weakest assumption behind the panels leading option and explain specifically why it might be wrong. Name the exact assumption.",
    `Panel findings:\n${panelOutput}`
  );
  await space.send(`DEVILS ADVOCATE\n${devilsAdvocateOutput}`);

  // 3. JUDGE — reconsiders in light of the attack and gives the final verdict
  const judgeOutput = await callAgent(
    `You are the Judge. Read the panel findings and the Devils Advocate attack. Decide if the attack changes the leading option or not then produce a verdict in exactly this format and nothing else

VERDICT: option
CONFIDENCE: a percentage from 0 to 100
BIGGEST REASON: one line
BIGGEST RISK: one line
WHAT WOULD CHANGE THIS: one line naming the fact that would flip the decision
NEXT ACTION: one concrete step

If the Devils Advocate attack changed the recommendation say so plainly in BIGGEST REASON`,
    `Panel findings:\n${panelOutput}\n\nDevils Advocate:\n${devilsAdvocateOutput}`
  );

  return judgeOutput;
}

async function main() {
  const app = await Spectrum({
    projectId: process.env.PROJECT_ID,
    projectSecret: process.env.PROJECT_SECRET,
    providers: [imessage.config()],
  });

  console.log("Decision Room bot is running. Waiting for a text message...");

  for await (const [space, message] of app.messages) {
    if (message.content.type !== "text") continue;

    console.log(`Got a message from ${message.sender.id}: "${message.content.text}"`);

    await space.responding(async () => {
      try {
        if (isGreeting(message.content.text)) {
          const reply = await handleGreeting(message.content.text);
          await message.reply(reply);
          return;
        }

        const verdict = await runDecisionRoom(message.content.text, space);
        await message.reply(verdict);
      } catch (err) {
        console.error("Decision Room failed:", err);
        await message.reply(
          err.message.includes("Daily free quota")
            ? err.message
            : "Sorry something went wrong on my end. Try again in a moment."
        );
      }
    });
  }
}

main().catch((err) => {
  console.error("Something went wrong:", err);
});
