// Startup Idea Validator: a Druve agent ported by hand from the n8n template
// "Validate startup ideas with Google Gemini, Groq, and Gmail" by Kanishka
// Shrivastava (https://n8n.io/workflows/16513).
// Draft for Kanishka to check. Listed on Druve only by Kanishka, under Kanishka's own name.
//
// What it keeps, unchanged: the form's three fields (Startup Idea, Industry,
// Target Audience), the "SWOT Analysis Generator" prompt word for word, the
// "Validation Report Creator" prompt word for word, and the optional email of
// the finished report.
//
// ONE DELIBERATE CHANGE, FOR THE AUTHOR TO REVIEW: the template's "Compute
// Startup Score" node is `Math.floor(Math.random() * 21) + 80`, so every idea
// scores a random 80 to 100 whatever the analysis says. A buyer reading that
// score would take it as a judgement. Here the model scores the idea from the
// SWOT against a short stated rubric and gives one line of reasoning per
// criterion, so the number is traceable. The scoring prompt below is new and is
// marked as such; everything else is the author's.
//
// Input (JSON):
//   {"idea": "...", "industry": "...", "audience": "...",
//    "gmail_access_token": "...", "send_to": "you@example.com"}   // email optional
// Plain text input is treated as the idea alone.
//
// Data-fetch host to declare when publishing:
//   gmail.googleapis.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "SWOT Analysis Generator", verbatim.
const swotPrompt = (idea, industry, audience) => `You are a startup consultant.

Analyze this startup idea:

Idea:
${idea}

Industry:
${industry}

Target Audience:
${audience}

Provide:

1. Problem solved
2. Business model
3. Strengths
4. Weaknesses
5. Opportunities
6. Threats

Format professionally.`;

// NEW (replaces the template's random score). Not the author's text.
const scorePrompt = (analysis) => `Score this startup idea from 0 to 100 using only the analysis below.
Rubric, 20 points each: how painful and frequent the problem is; how clear the business model is;
how defensible the strengths are; how serious the weaknesses and threats are (fewer and milder scores higher);
how reachable the target audience is.
Respond with only JSON: {"score": <0-100 integer>, "reasons": ["one line per rubric item", "..."]}

Analysis:
${analysis}`;

// "Validation Report Creator", verbatim.
const reportPrompt = (startupScore, analysis) => `Create a startup validation report.

Startup Score:
${startupScore}

Analysis:
${analysis}

Create:

Executive Summary

SWOT Analysis

Market Potential

Recommendations

Final Verdict`;

function parseScore(text) {
  const s = String(text);
  try {
    const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    const n = Math.round(Number(j.score));
    if (Number.isFinite(n) && n >= 0 && n <= 100) return { score: n, reasons: Array.isArray(j.reasons) ? j.reasons.map(String) : [] };
  } catch { /* fall through */ }
  return null;
}

const toB64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sendEmail(token, to, body) {
  const raw = `To: ${to}\r\nSubject: Your Startup Validation Report\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: toB64url(raw) }),
  });
  if (!res.ok) throw new Error(`Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { idea: raw };
  const idea = String(p.idea || p['Startup Idea'] || '').trim();
  if (!idea) return JSON.stringify({ error: 'Send {"idea": "...", "industry": "...", "audience": "..."}.' });
  const industry = String(p.industry || p.Industry || 'Not specified').trim();
  const audience = String(p.audience || p['Target Audience'] || 'Not specified').trim();

  const model = getModelClient(providerConfig);
  const analysis = String(await model.complete(swotPrompt(idea, industry, audience))).trim();

  let scored = null;
  for (let attempt = 0; attempt < 2 && !scored; attempt++) scored = parseScore(await model.complete(scorePrompt(analysis)));

  /* If the model will not give a usable score, say so in the report rather
     than inventing one: that is the bug this port exists to remove. */
  const startupScore = scored ? scored.score : 'Not scored (the model did not return a usable score)';
  const report = String(await model.complete(reportPrompt(startupScore, analysis))).trim();

  const out = { idea, industry, audience, score: scored ? scored.score : null, score_reasons: scored ? scored.reasons : [], analysis, report };
  if (p.gmail_access_token && p.send_to) {
    try { out.email_id = await sendEmail(p.gmail_access_token, p.send_to, report); } catch (e) { out.email_error = e.message; }
  }
  return JSON.stringify(out);
}
