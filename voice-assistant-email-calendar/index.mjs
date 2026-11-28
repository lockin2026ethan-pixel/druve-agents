// Voice Assistant for Email and Calendar: a Druve agent ported by hand from
// the n8n template "Turn Telegram voice messages into Gmail emails and Google
// Calendar events with Whisper and Ollama" by Jyothish S L
// (https://n8n.io/workflows/15754).
// Draft for Jyothish to check. Listed on Druve only by Jyothish, under his own name.
//
// What it keeps, unchanged: the Text Classifier categories (SendEmail,
// BookAnEvent, Normal Query) with their descriptions, the four prompts word for
// word (email assistant, calendar event assistant, voice assistant, email
// rewrite), the JSON clean-up code (markdown stripped, last valid JSON block),
// and the approval rule: nothing is sent or booked until the user approves.
// What changes: no Telegram trigger and no self-hosted Whisper. The input is the
// instruction as text (a transcript works). The first run returns the draft;
// run again with "approve": true and the same draft to send the Gmail message or
// create the Calendar event, or "rephrase": true to get the rewritten email.
//
// Input (JSON):
//   {"text": "Email HR that I will be late tomorrow"}
//   {"approve": true, "email": {"to": "...", "subject": "...", "body": "..."}, "google_access_token": "..."}
//   {"approve": true, "event": {"title": "...", "date": "2026-12-01", "time": "10:00", "duration": "30", "location": "", "description": ""},
//    "google_access_token": "...", "timezone": "Asia/Kolkata", "calendar_id": "primary"}
//   {"rephrase": true, "email": {...}}
// Plain text input is treated as the instruction.
//
// Data-fetch hosts to declare when publishing:
//   gmail.googleapis.com, www.googleapis.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key and accounts.

import { getModelClient } from '@druve/cli/providers';

const CATEGORIES = [{"category": "SendEmail", "description": "if user wants to send an email"}, {"category": "BookAnEvent", "description": "If user want to book/schedule an event on calender"}, {"category": "Normal Query", "description": "everything else (questions, greetings, info, chat)"}];

const classifyPrompt = (text) => `Please classify the text provided by the user into one of the following categories: ${CATEGORIES.map((c) => `${c.category} (${c.description})`).join(', ')}, and use the provided formatting instructions below. Don't explain, and only output the json.

Respond with only this JSON: {"category": "<one of: ${CATEGORIES.map((c) => c.category).join(' | ')}>"}

${text}`;

// "AI Agent" (email), verbatim.
const emailPrompt = (input) => `You are an Email Automation Assistant.

Convert user instructions into a structured email.

Extract:
- recipient (email or role like HR/manager/client)
- subject
- professional email body

Rules:
- Always be formal and professional
- If recipient email is missing, assume role-based (HR, Manager, Support)
- Do NOT send email, only prepare it
- Keep body concise and clear

Input:
${input}

Output ONLY JSON:
{
  "to": "",
  "subject": "",
  "body": ""
}
Return ONLY valid JSON.
No markdown.
No explanation.
No comments.
No extra text.`;
// "AI Agent3" (calendar), verbatim.
const eventPrompt = (input) => `You are a Calendar Event Automation Assistant.
INPUT: ${input}
Return ONLY valid JSON.

CRITICAL RULES:
- Output must be ONLY JSON
- NO markdown (no \`\`\` )
- NO explanations
- NO comments (// or /* */ are not allowed)
- NO extra text before or after JSON
- MUST be valid JSON parseable by JSON.parse()

Output format:
{
  "title": "",
  "date": "",
  "time": "",
  "duration": "",
  "location": "",
  "description": ""
}`;
// "AI Agent1" (voice assistant), verbatim.
const chatPrompt = (input) => `You are a helpful voice assistant.

Rules:
- Respond naturally like spoken conversation
- Keep answers short and clear
- If user asks technical questions, explain simply
- If unclear, ask a short follow-up question

Input:
${input}
`;
// "AI Agent2" (rephrase), verbatim.
const rewritePrompt = (draft) => `You are an email writing assistant.

Rewrite the email body to make it more natural, professional, and human-like.

Rules:
- Keep the same meaning
- Do not change the subject or recipient
- Improve grammar and tone
- Make it sound smooth and polite
- Do NOT add extra information
- Output ONLY JSON

Output ONLY JSON:
{
  "to": "",
  "subject": "",
  "body": ""
}
Return ONLY valid JSON.
No markdown.
No explanation.
No comments.
No extra text.
INPUT : ${draft}`;

// "Code in JavaScript3": strip markdown, try JSON blocks from last to first.
function parseJsonLoose(raw) {
  raw = String(raw).replace(/```json/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(raw); } catch { /* try blocks */ }
  const candidates = raw.match(/\{[\s\S]*?\}/g);
  if (!candidates || candidates.length === 0) return { error: 'No JSON candidates found', raw };
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i]); } catch { continue; }
  }
  return { error: 'No valid JSON could be parsed', raw };
}

function category(reply) {
  const j = parseJsonLoose(reply);
  const c = String(j.category || reply);
  if (/sendemail/i.test(c)) return 'SendEmail';
  if (/bookanevent/i.test(c)) return 'BookAnEvent';
  return 'Normal Query';
}

const toB64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sendGmail(token, e) {
  if (!/@/.test(String(e.to || ''))) throw new Error(`"${e.to}" is not an email address. Put the real address in email.to and approve again.`);
  const subject = /^[\x20-\x7e]*$/.test(e.subject || '') ? e.subject : `=?UTF-8?B?${Buffer.from(e.subject, 'utf8').toString('base64')}?=`;
  const raw = `To: ${e.to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${e.body || ''}`;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: toB64url(raw) }),
  });
  if (!res.ok) throw new Error(`Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
}

async function createEvent(token, ev, timeZone, calendarId) {
  if (!ev.date) throw new Error('The event has no date. Add event.date (YYYY-MM-DD) and approve again.');
  const minutes = parseInt(ev.duration, 10) || 60;
  let body;
  if (ev.time) {
    const start = `${ev.date}T${String(ev.time).slice(0, 5)}:00`;
    const endDate = new Date(Date.parse(`${start}Z`) + minutes * 60000).toISOString().slice(0, 19);
    body = { start: { dateTime: start, timeZone }, end: { dateTime: endDate, timeZone } };
  } else {
    const next = new Date(Date.parse(`${ev.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    body = { start: { date: ev.date }, end: { date: next } };
  }
  Object.assign(body, { summary: ev.title || 'Event', location: ev.location || undefined, description: ev.description || undefined });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || 'primary')}/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Calendar HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).htmlLink;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { text: raw };
  const model = getModelClient(providerConfig);

  try {
    if (p.approve) {
      if (!p.google_access_token) return JSON.stringify({ error: 'Approving needs "google_access_token".' });
      if (p.email) return JSON.stringify({ sent: true, gmail_id: await sendGmail(p.google_access_token, p.email), ...p.email });
      if (p.event) return JSON.stringify({ booked: true, link: await createEvent(p.google_access_token, p.event, p.timezone || 'UTC', p.calendar_id), ...p.event });
      return JSON.stringify({ error: 'Pass the "email" or "event" draft you are approving.' });
    }
    if (p.rephrase && p.email) {
      const email = parseJsonLoose(await model.complete(rewritePrompt(JSON.stringify(p.email))));
      return JSON.stringify({ type: 'SendEmail', email, next: 'Run again with "approve": true and this email to send it.' });
    }
    const text = String(p.text || '').trim();
    if (!text) return JSON.stringify({ error: 'Send {"text": "your instruction"}. See the header of this file.' });

    const type = category(await model.complete(classifyPrompt(text)));
    if (type === 'SendEmail') {
      const email = parseJsonLoose(await model.complete(emailPrompt(text)));
      return JSON.stringify({ type, email, next: 'Review it. Run again with "approve": true and this email to send it, or "rephrase": true to rewrite it.' });
    }
    if (type === 'BookAnEvent') {
      const event = parseJsonLoose(await model.complete(eventPrompt(text)));
      return JSON.stringify({ type, event, next: 'Review it. Run again with "approve": true and this event to add it to your calendar.' });
    }
    return JSON.stringify({ type, reply: String(await model.complete(chatPrompt(text))).trim() });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
