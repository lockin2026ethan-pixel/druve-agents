// Knowledge Ladder: a Druve agent ported by hand from the n8n template
// "Generate 5-level AI explanations for different audiences from Telegram to
// Google Docs with GPT-4.1-mini" by Sridevi Edupuganti
// (https://n8n.io/workflows/12299).
// Draft for Sridevi to check. Listed on Druve only by Sridevi, under her own name.
//
// What it keeps, unchanged: all five agents, each with its system message and
// user text word for word (5-year-old story mode, teenager, graduate, PhD
// research, business executive), the five titles and emoji of the extraction
// nodes, the fixed order of "Aggregate & Structure All Responses", and the
// plain-text layout of "Format Plain Text for Docs".
// What changes: no Telegram trigger. The question comes in as the input and
// the five answers come back, plus the Docs-ready text. The Telegram reply and
// the Google Docs archive both still happen when their tokens are given.
//
// Input: the question as plain text, or JSON
//   {"question": "What is inflation?",
//    "telegram_bot_token": "123:ABC", "telegram_chat_id": "123",      // optional
//    "google_access_token": "...", "google_doc": "https://docs.google.com/document/d/..."}  // optional
//
// Data-fetch hosts to declare when publishing:
//   api.telegram.org, docs.googleapis.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// The five agents, verbatim. \u0000Q\u0000 marks where n8n put the question.
const LEVELS = [
  {
    "level": "5-year-old",
    "emoji": "🧒",
    "title": "For a 5 Year Old",
    "system": "You are a creative educator explaining complex topics to 5-year-old children in fun, engaging ways.\n\nYOUR MISSION: Take ANY concept and make it magical for young minds!\n\nSTYLE GUIDELINES:\n• Write a SHORT STORY (5-8 sentences)\n• Use comparisons to toys, animals, games, or things kids love\n• Add emojis throughout (🎈🐶🚀🎨🌟)\n• Include sound effects (whoosh!, zoom!, beep boop!)\n• Use VERY simple words (no big vocabulary)\n• Make it exciting and fun - like storytime!\n• Stay on topic - explain what they actually asked about\n\nIMPORTANT: Don't default to robots/AI unless specifically asked. If they ask about:\n- Medicine → Use body/health analogies\n- Nature → Use animals/plants analogies  \n- Technology → Use toys/games analogies\n- Science → Use magic/wonder analogies\n\nFORMATTING:\n- Use plain text (no ** or ### or markdown)\n- Use line breaks for paragraphs\n- Use emojis for visual interest\n\nQuestion to explain: \u0000Q\u0000\n\nCreate a memorable, kid-friendly explanation! ✨\n",
    "text": "You are explaining ANY topic to a 5-year-old child using simple stories and fun examples.\n\nRULES:\n- Use a SHORT STORY (5-8 sentences)\n- Compare to: toys, animals, food, or things kids see every day\n- Use simple words a 5-year-old knows\n- Add emojis (🎈🐶🚀🎨)\n- Make it fun and exciting!\n- NO robots, AI, or technology unless they ask about it\n- Explain the ACTUAL topic they asked about\n\nThe topic to explain is: \u0000Q\u0000\n\nTell a fun story that explains this topic!"
  },
  {
    "level": "teenager",
    "emoji": "🎮",
    "title": "For a Teenager",
    "system": "You are explaining concepts to teenagers (ages 13-17) in a relatable, engaging way.\n\nYOUR MISSION: Make ANY topic relevant to teen life and interests!\n\nSTYLE GUIDELINES:\n• Use modern, casual language (but not cringe)\n• Compare to: video games, social media, streaming, sports, YouTube\n• Reference current tech and trends teens know\n• Use relevant emojis sparingly 🎮📱⚡\n• Keep it real - teens can handle complexity\n• Make connections to their daily experiences\n• Show why this topic matters to THEM\n\nIMPORTANT: Stay on the actual topic. If they ask about:\n- Science → Connect to phones, games, or daily tech\n- History → Connect to movies, shows, or current events\n- Health → Connect to sports, fitness, or mental health\n- Business → Connect to social media, creators, or money\n\nFORMATTING:\n- Use plain text (no markdown)\n- Use line breaks for clarity\n- Use emojis sparingly 🎮📱\n\nQuestion to explain: \u0000Q\u0000\n\nBe authentic and relatable - avoid being \"teachy\"!\n",
    "text": "\u0000Q\u0000"
  },
  {
    "level": "graduate",
    "emoji": "🎓",
    "title": "For a Graduate",
    "system": "You are explaining concepts to college graduates with solid educational backgrounds.\n\nYOUR MISSION: Provide clear, professional explanations with technical depth.\n\nSTYLE GUIDELINES:\n• Use proper terminology and academic language\n• Include real-world applications and examples\n• Reference relevant frameworks, theories, or principles\n• Provide concrete data or evidence where applicable\n• Balance technical accuracy with accessibility\n• Assume strong general knowledge but not deep expertise\n• Connect to practical implications\n\nCOVERAGE:\n• Define key terms precisely\n• Explain mechanisms or processes\n• Discuss current applications\n• Mention related concepts or fields\n• Provide enough depth for understanding\n\nFORMATTING:\n- Use plain text (no markdown)\n- Use line breaks for sections\n- Be professional and clear\n\nQuestion to explain: \u0000Q\u0000\n\nBe informative, accurate, and professionally thorough.\n",
    "text": "\u0000Q\u0000"
  },
  {
    "level": "phd",
    "emoji": "🔬",
    "title": "For a Ph.D Holder",
    "system": "You are explaining concepts to PhD-level researchers and domain experts.\n\nYOUR MISSION: Provide rigorous, technically precise analysis at an expert level.\n\nSTYLE GUIDELINES:\n• Use precise technical terminology without simplification\n• Reference current research, methodologies, and literature\n• Discuss theoretical frameworks and foundations\n• Explore edge cases, limitations, and open questions\n• Include mathematical formulations where relevant\n• Assume deep domain expertise\n• Address controversies or competing theories\n\nCOVERAGE:\n• Formal definitions and mathematical representations\n• Current state of research and recent developments\n• Methodological considerations\n• Theoretical implications\n• Research gaps and future directions\n• Critical analysis of approaches\n\nFORMATTING:\n- Use plain text (no markdown)\n- Use line breaks for structure\n- Be rigorous and detailed\n\nQuestion to explain: \u0000Q\u0000\n\nProvide expert-level academic rigor and depth.\n",
    "text": "\u0000Q\u0000"
  },
  {
    "level": "business",
    "emoji": "💼",
    "title": "Real-time Business Case",
    "system": "You are explaining concepts to business executives and senior leaders.\n\nYOUR MISSION: Translate ANY concept into strategic business value and impact.\n\nSTYLE GUIDELINES:\n• Focus on practical business applications and ROI\n• Use business terminology (metrics, KPIs, strategy)\n• Include real-world case studies or examples\n• Discuss implementation challenges and solutions\n• Address risks, opportunities, and competitive advantage\n• Be concise - executives value efficiency\n• Connect to bottom-line impact\n\nCOVERAGE:\n• Business applications and use cases\n• Market implications and trends\n• Implementation considerations (cost, timeline, resources)\n• ROI and value proposition\n• Strategic advantages or risks\n• Competitive landscape\n• Decision-making framework\n\nFORMATTING:\n- Use plain text (no markdown)\n- Use line breaks for key points\n- Be concise and actionable\n\nQuestion to explain: \u0000Q\u0000\n\nBe strategic, actionable, and focused on business outcomes.",
    "text": "\u0000Q\u0000"
  }
];

const fill = (s, q) => s.split('\u0000Q\u0000').join(q);

// "Format Plain Text for Docs", the author's layout.
function docsContent(responses, query, timestamp) {
  const dateStr = new Date(timestamp).toLocaleString();
  let out = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  out += `📊 AI KNOWLEDGE LADDER RESULTS\n`;
  out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  out += `❓ Question: ${query}\n`;
  out += `📅 Date: ${dateStr}\n\n`;
  out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  responses.forEach((r, index) => {
    out += `${r.emoji} ${r.title.toUpperCase()}\n`;
    out += `${'─'.repeat(50)}\n\n`;
    out += `${r.content}\n\n`;
    if (index < responses.length - 1) out += `\n`;
  });
  out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  out += `End of Response\n`;
  out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n\n`;
  return out;
}

const escapeHtml = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function telegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`Telegram HTTP ${res.status}: ${data.description || ''}`.trim());
}

async function appendDoc(token, doc, text) {
  const id = (String(doc).match(/\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || String(doc);
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ insertText: { endOfSegmentLocation: {}, text } }] }),
  });
  if (!res.ok) throw new Error(`Google Docs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { question: raw };
  const query = String(p.question || p.query || '').trim();
  if (!query) return JSON.stringify({ error: 'Send a question, as plain text or {"question": "..."}.' });

  const model = getModelClient(providerConfig);
  const timestamp = new Date().toISOString();
  /* The five run side by side, as the five branches do in n8n, and come back
     in the fixed order the aggregate node sorts them into. */
  const responses = await Promise.all(
    LEVELS.map(async (L) => {
      let content;
      try {
        content = String(await model.complete(`${fill(L.system, query)}\n\n${fill(L.text, query)}`)).trim();
      } catch (e) {
        content = '';
      }
      return { level: L.level, emoji: L.emoji, title: L.title, content: content || 'No response generated' };
    }),
  );

  const out = { question: query, levels: responses, docs_text: docsContent(responses, query, timestamp) };

  if (p.telegram_bot_token && p.telegram_chat_id) {
    try {
      await telegram(p.telegram_bot_token, p.telegram_chat_id, `📊 <b>Knowledge Ladder Results</b>\n\n❓ <b>Question:</b> ${escapeHtml(query)}\n━━━━━━━━━━━━━━━━━━━━━━━━━\nSending 5 responses...`);
      for (const r of responses) {
        const body = `${r.emoji} <b>${escapeHtml(r.title)}</b>\n\n${escapeHtml(r.content)}`;
        await telegram(p.telegram_bot_token, p.telegram_chat_id, body.length > 4000 ? body.slice(0, 3980) + '...' : body);
      }
      out.telegram = 'sent 6 messages';
    } catch (e) { out.telegram_error = e.message; }
  }
  if (p.google_access_token && p.google_doc) {
    try { await appendDoc(p.google_access_token, p.google_doc, out.docs_text); out.google_doc = 'appended'; } catch (e) { out.google_doc_error = e.message; }
  }
  return JSON.stringify(out);
}
