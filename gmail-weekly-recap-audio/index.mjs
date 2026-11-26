// Gmail Weekly Recap + Audio: a Druve agent ported by hand from the n8n
// template "Summarize Gmail into Notion with OpenAI and create audio digests
// in Google Drive" by Alberto Idrio (https://n8n.io/workflows/13148).
// Draft for Alberto to check. Listed on Druve only by Alberto, under his own name.
//
// What it keeps, unchanged: the Gmail search ("newer_than:7d" plus the chosen
// senders), one summary per email with the "Import body emails" prompt word
// for word, the "Code in JavaScript" merge word for word (joined by ---, cut
// at 1800 characters on the last full stop, with the author's truncation
// note, in English), the "Final Summary" editor-in-chief prompt word for word, the
// optional "Mark as read", the Notion text block, and the audio settings of
// the "Generate audio" node (OpenAI tts-1-hd, voice nova).
// What changes: no n8n credentials, no weekly trigger and no Google Drive.
// The buyer runs it when they want the recap (or pastes email texts instead of
// connecting Gmail) and gets the recap text back, plus the MP3 as base64 when
// audio is on. The Notion block is written only when a Notion token and page
// link are given.
//
// Input (JSON), one of:
//   {"emails": ["full text of email 1", "full text of email 2"]}
//   {"gmail_access_token": "...", "senders": ["news@example.ai", "digest@example.com"],
//    "days": 7, "max_emails": 20, "mark_read": false}
//   or "query": "any Gmail search" instead of senders/days.
// Optional: "audio": true together with "openai_api_key": "sk-..." (the buyer must
//           pass this key in the input; the model-provider key is not reused for audio),
//           "notion_token": "...", "notion_page": "https://www.notion.so/...".
// Today's date is passed into both prompts, so "the Monday of the week" is computed
// from the real date rather than guessed.
// Plain text input is treated as one pasted email.
//
// Data-fetch hosts to declare when publishing:
//   gmail.googleapis.com, api.openai.com, api.notion.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key and accounts.

import { getModelClient } from '@druve/cli/providers';

// "Import body emails", verbatim apart from today's date added on top (the email text goes where n8n put {{ $json.text }}).
const importPrompt = (text, today) => `Today's date is ${today}.

Act as a personal editor. Analyze the text of the provided emails (${text}) and create a concise summary of the key news or information.

Formatting rules for Notion:

Use UPPERCASE for section titles (DO NOT use # or ##).

Use bullet points (-) for details.

Avoid complex markdown symbols such as tables or code blocks.

Be brief and direct.

The final result must be a maximum of 1600 characters.

At the beginning of the summary, include (only once) the date (the Monday of the week you are considering).

Exclude events from the summary.`;

// "Final Summary", verbatim apart from today's date added on top.
const finalPrompt = (finalSummary, today) => `Today's date is ${today}.

You are the editor-in-chief of a weekly newsletter.
Below you will find a series of raw summaries from various emails received this week.
Your task is to create a SINGLE final narrative text (Weekly Recap) that merges the most important news.

CORE RULES:

The final text MUST be under 1500 characters (including spaces). Be concise.

Use a conversational yet structured style (use bullet points if needed).

Do not use Markdown formatting (UPPERCASE for titles, bold for emphasis).

Ignore emails that appear to be spam or not important if you need to save space.

Start with a title: "WEEKLY RECAP:" and add the date of the Monday of the relevant week.

Here are the raw summaries:
${finalSummary}`;

// "Code in JavaScript", the author's code (outputs in, final_summary out).
function mergeSummaries(outputs) {
  let mergedText = outputs.join('\n\n---\n\n');
  const MAX_LENGTH = 1800;
  if (mergedText && mergedText.length > MAX_LENGTH) {
    let trimmed = mergedText.substring(0, MAX_LENGTH);
    const lastDotIndex = trimmed.lastIndexOf('.');
    if (lastDotIndex > 0) {
      trimmed = trimmed.substring(0, lastDotIndex + 1);
    }
    mergedText = trimmed + '\n\n(Text truncated due to length limits...)';
  }
  return { final_summary: mergedText };
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmail(token, path, init = {}) {
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const b64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const stripHtml = (h) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The text n8n's "Get a message" (simple: off) puts in $json.text.
function messageText(msg) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) plain.push(b64(part.body.data));
    else if (part.mimeType === 'text/html' && part.body?.data) html.push(b64(part.body.data));
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  const body = plain.join('\n').trim() || stripHtml(html.join('\n')) || msg.snippet || '';
  return `From: ${h.from || ''}\nSubject: ${h.subject || ''}\nDate: ${h.date || ''}\n\n${body}`.slice(0, 20000);
}

async function fetchEmails(p) {
  const token = p.gmail_access_token;
  const days = Math.max(1, Math.min(60, Number(p.days) || 7));
  const senders = Array.isArray(p.senders) ? p.senders.filter(Boolean) : [];
  const q = p.query || `newer_than:${days}d${senders.length ? ` (${senders.map((s) => `from:${s}`).join(' OR ')})` : ''}`;
  const max = Math.max(1, Math.min(50, Number(p.max_emails) || 20));
  const list = await gmail(token, `/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
  const ids = (list.messages || []).map((m) => m.id);
  const texts = [];
  for (const id of ids) {
    const msg = await gmail(token, `/messages/${id}?format=full`);
    texts.push(messageText(msg));
    if (p.mark_read) {
      // "Mark as read": remove the UNREAD label.
      await gmail(token, `/messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) });
    }
  }
  return { query: q, texts };
}

// "Generate audio": OpenAI tts-1-hd, voice nova.
async function speech(key, text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1-hd', voice: 'nova', input: text, response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`OpenAI audio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// "Create a text block Notion": append the recap as a paragraph block.
async function notionBlock(token, page, text) {
  const id = (String(page).match(/[0-9a-f]{32}/i) || String(page).replace(/-/g, '').match(/[0-9a-f]{32}/i) || [])[0];
  if (!id) throw new Error('Could not read a Notion page id from "notion_page".');
  const chunks = text.match(/[\s\S]{1,1900}/g) || [];
  const res = await fetch(`https://api.notion.com/v1/blocks/${id}/children`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: chunks.map((c) => ({ type: 'text', text: { content: c } })) } }],
    }),
  });
  if (!res.ok) throw new Error(`Notion HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return 'added';
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object') p = raw ? { emails: [raw] } : {};

  let texts = [];
  let query;
  try {
    if (Array.isArray(p.emails)) texts = p.emails.map(String).filter((t) => t.trim());
    else if (p.gmail_access_token) ({ texts, query } = await fetchEmails(p));
    else return JSON.stringify({ error: 'Send {"emails": [...]} or {"gmail_access_token": "...", "senders": [...]}. See the header of this file.' });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
  if (!texts.length) return JSON.stringify({ query, emails_found: 0, note: 'No emails matched, so there is nothing to recap.' });

  const model = getModelClient(providerConfig);
  const today = new Date().toISOString().slice(0, 10);
  const outputs = [];
  for (const text of texts) {
    outputs.push(String(await model.complete(importPrompt(text, today))).trim());
  }
  const { final_summary } = mergeSummaries(outputs);
  const recap = String(await model.complete(finalPrompt(final_summary, today))).trim();

  const out = { query, emails_found: texts.length, email_summaries: outputs, recap };

  if (p.audio) {
    const key = p.openai_api_key;
    try {
      if (!key) throw new Error('Audio needs an OpenAI key in the input: add "openai_api_key": "sk-...".');
      out.audio_mp3_base64 = await speech(key, recap);
      out.audio_file_name = `News${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.mp3`;
    } catch (e) { out.audio_error = e.message; }
  }
  if (p.notion_token && p.notion_page) {
    try { out.notion = await notionBlock(p.notion_token, p.notion_page, recap); } catch (e) { out.notion = `error: ${e.message}`; }
  }
  return JSON.stringify(out);
}
