// Job Application Auto-Reply: a Druve agent ported by hand from the n8n template
// "Send AI job application auto-replies with Gmail, OpenAI GPT-4o and SMTP"
// by Md Abdullah Al Noman (https://n8n.io/workflows/14267).
// Draft for Md Abdullah to check. Listed on Druve only by him, under his own name.
//
// What it keeps, unchanged: the "If" rule (only emails whose subject, lowercased,
// contains "job application"), the "Edit Fields" mapping (candidateEmail = the
// Reply-To address, companyEmail = the To address, subject), the "AI Agent"
// prompt word for word (including the author's company name, which a user can
// replace with "company_name"), and the {subject, body} reply format.
// What changes: no Gmail trigger and no SMTP node. A user pastes application
// emails, or gives a Gmail access token: the agent reads matching emails and,
// only when "send": true, sends each reply from that Gmail account.
//
// Input (JSON):
//   {"emails": [{"subject": "Job Application - Data Analyst - Jane Doe", "from": "jane@x.com", "to": "hr@company.com"}]}
//   {"gmail_access_token": "...", "query": "is:unread subject:(job application)", "max": 10, "send": false}
// Optional: "company_name": "Your Company" (replaces the template's "Luminar Technology").
//
// Data-fetch host to declare when publishing:
//   gmail.googleapis.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "AI Agent" prompt, verbatim; n8n renders the three inputs as their raw values.
const promptFor = (f, company) => `You are an HR assistant at Luminar Technology. Your task is to generate professional and courteous email replies to job applicants based on their application details.

Here are the rules:

1. Address the applicant by their name from the email subject or body.
2. Mention the position they applied for.
3. Thank them for applying.
4. Keep the tone friendly, professional, and concise.
5. Do not include sensitive internal information.
6. Provide a closing with "Best regards" or "Sincerely" from the hiring team.

Use this JSON format in your output:

{
  "subject": "<email subject for reply>",
  "body": "<email body for reply>"
}

The inputs you will receive:
{
  "candidateEmail": ${f.candidateEmail},
  "companyEmail": ${f.companyEmail},
  "subject": ${f.subject}
}

Generate the reply email based on this input.
Special Note:Remove the name of the candidate from the subject.`.replace('Luminar Technology', company || 'Luminar Technology');

function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
async function gmail(token, path, init = {}) {
  const res = await fetch(`${GMAIL}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const addr = (v) => (String(v || '').match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0];

async function fetchEmails(p) {
  const q = p.query || 'is:unread subject:(job application)';
  const max = Math.max(1, Math.min(25, Number(p.max) || 10));
  const list = await gmail(p.gmail_access_token, `/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
  const out = [];
  for (const { id } of list.messages || []) {
    const msg = await gmail(p.gmail_access_token, `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Reply-To`);
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    out.push({ subject: h.subject || '', from: h['reply-to'] || h.from || '', to: h.to || '' });
  }
  return out;
}

async function sendReply(token, from, to, subject, body) {
  const mime = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;
  const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail(token, '/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
  return 'sent';
}

export async function handleMessage(input, providerConfig) {
  let p;
  try { p = JSON.parse(String(input || '')); } catch { p = null; }
  if (!p || typeof p !== 'object') return JSON.stringify({ error: 'Send {"emails": [...]} or {"gmail_access_token": "..."}. See the header of this file.' });

  let emails;
  try {
    emails = Array.isArray(p.emails) ? p.emails : p.gmail_access_token ? await fetchEmails(p) : null;
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
  if (!emails) return JSON.stringify({ error: 'Send {"emails": [...]} or {"gmail_access_token": "..."}.' });

  const model = getModelClient(providerConfig);
  const results = [];
  for (const em of emails.slice(0, 25)) {
    const subject = String(em.subject || '');
    // "If": subject contains "job application".
    if (!subject.toLowerCase().includes('job application')) {
      results.push({ subject, skipped: 'Subject does not contain "job application".' });
      continue;
    }
    // "Edit Fields".
    const f = { candidateEmail: addr(em.from), companyEmail: addr(em.to), subject };
    const reply = parseJson(await model.complete(promptFor(f, p.company_name)));
    if (!reply || typeof reply.subject !== 'string' || typeof reply.body !== 'string') {
      results.push({ subject, error: 'The model did not return {subject, body}.' });
      continue;
    }
    const item = { to: f.candidateEmail, from: f.companyEmail, reply };
    if (p.send && p.gmail_access_token && f.candidateEmail) {
      try { item.sent = await sendReply(p.gmail_access_token, f.companyEmail, f.candidateEmail, reply.subject, reply.body); }
      catch (e) { item.sent = `error: ${e.message}`; }
    }
    results.push(item);
  }
  return JSON.stringify({ processed: results.length, results });
}
