// Gmail Support Agent: a Druve agent ported by hand from the n8n template
// "AI Gmail support automation with Google Gemini, OpenAI & Pinecone" by
// Muhammad Ali (https://n8n.io/workflows/10465).
// Draft for Muhammad to check. Listed on Druve only by Muhammad, under his own name.
//
// What it keeps, unchanged: the "Intent Classifier" categories and descriptions
// word for word ("Customer Support" / "Other"), the "Email Support Agent" system
// message word for word, the Pinecone knowledge-base lookup (embed the email with
// OpenAI, query the index, read each match's "text" metadata as n8n stores it),
// the Gmail reply in the same thread, and "Label Query" (add a label after replying).
// What changes: no polling trigger and no Slack message. The buyer runs it when
// they want to clear the inbox (or on their own schedule with the Druve CLI).
// The vector store is queried once before the agent answers, instead of the
// agent calling it as a tool. Replies are drafted by default and sent only
// with "send": true. Instead of Pinecone, a plain FAQ text can be pasted.
//
// Input (JSON), one of:
//   {"email": "full text of one customer email", "knowledge": "your FAQ text"}
//   {"gmail_access_token": "...", "query": "is:unread in:inbox", "max_emails": 10,
//    "send": false, "label_id": "Label_123"}
// Knowledge, one of:
//   "knowledge": "pasted FAQ or policy text"
//   "pinecone_host": "https://<index>-<project>.svc.<env>.pinecone.io", "pinecone_api_key": "...",
//   "openai_api_key": "sk-...", optional "namespace", "top_k" (default 4),
//   "embedding_model" (default "text-embedding-ada-002"; use the model the index was built with).
// Plain text input is treated as one email with no knowledge base.
//
// Data-fetch hosts to declare when publishing:
//   gmail.googleapis.com, api.openai.com, and your Pinecone index host
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key and accounts.

import { getModelClient } from '@druve/cli/providers';

// "Intent Classifier" categories, verbatim.
const CATEGORIES = [
  { category: 'Customer Support', description: 'Any email that is related to helping cutomer . it may contains a question , query etc ' },
  { category: 'Other', description: 'email other than Customer support' },
];

// n8n Text Classifier's default system prompt, with the categories and a JSON format.
const classifyPrompt = (text) => `Please classify the text provided by the user into one of the following categories: ${CATEGORIES.map((c) => `${c.category} (${c.description.trim()})`).join(', ')}, and use the provided formatting instructions below. Don't explain, and only output the json.

Respond with only this JSON: {"category": "<one of: ${CATEGORIES.map((c) => c.category).join(' | ')}>"}

${text}`;

// "Email Support Agent" system message, verbatim.
const AGENT_SYSTEM = `You are an expert Customer support Agent your job is to reply to customer message. Use ppincone vector tool to get data from knowledge base to answer to relevant question of Customer
## Output
output must be body of email it does not include subject
it is replying to an email not writing an email`;

const agentPrompt = (text, context) => `${AGENT_SYSTEM}

Knowledge base results for this message (from the Pinecone vector tool, described as "Use this tool when you need to answer customer query "):
${context || '(no knowledge base was given)'}

${text}`;

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmail(token, path, init = {}) {
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const toB64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const stripHtml = (h) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The text n8n's Gmail Trigger (simple: off) gives as $json.text.
function messageText(msg) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) plain.push(b64url(part.body.data));
    else if (part.mimeType === 'text/html' && part.body?.data) html.push(b64url(part.body.data));
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  return (plain.join('\n').trim() || stripHtml(html.join('\n')) || msg.snippet || '').slice(0, 20000);
}

const headerMap = (msg) => Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));

async function knowledge(p, text) {
  if (p.knowledge) return String(p.knowledge).slice(0, 30000);
  if (!(p.pinecone_host && p.pinecone_api_key && p.openai_api_key)) return '';
  const emb = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.openai_api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: p.embedding_model || 'text-embedding-ada-002', input: text.slice(0, 8000) }),
  });
  if (!emb.ok) throw new Error(`OpenAI embeddings HTTP ${emb.status}: ${(await emb.text()).slice(0, 200)}`);
  const vector = (await emb.json()).data[0].embedding;
  const host = String(p.pinecone_host).replace(/\/+$/, '');
  const q = await fetch(`${host.startsWith('http') ? host : `https://${host}`}/query`, {
    method: 'POST',
    headers: { 'Api-Key': p.pinecone_api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, topK: Math.max(1, Math.min(20, Number(p.top_k) || 4)), includeMetadata: true, ...(p.namespace ? { namespace: p.namespace } : {}) }),
  });
  if (!q.ok) throw new Error(`Pinecone HTTP ${q.status}: ${(await q.text()).slice(0, 200)}`);
  const matches = (await q.json()).matches || [];
  return matches.map((m, i) => `[${i + 1}] ${m.metadata?.text ?? m.metadata?.pageContent ?? JSON.stringify(m.metadata || {})}`).join('\n\n');
}

function parseCategory(reply) {
  const s = String(reply);
  try {
    const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    if (j.category) return String(j.category);
  } catch { /* fall through */ }
  return /customer support/i.test(s) ? 'Customer Support' : 'Other';
}

// "Reply to Query": a reply in the same Gmail thread.
async function replyInThread(token, msg, body) {
  const h = headerMap(msg);
  const subject = /^re:/i.test(h.subject || '') ? h.subject : `Re: ${h.subject || ''}`;
  const to = h['reply-to'] || h.from;
  const refs = [h.references, h['message-id']].filter(Boolean).join(' ');
  const encSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const headers = [
    `To: ${to}`,
    `Subject: ${encSubject}`,
    h['message-id'] ? `In-Reply-To: ${h['message-id']}` : null,
    refs ? `References: ${refs}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  const raw = `${headers.join('\r\n')}\r\n\r\n${body}`;
  const sent = await gmail(token, '/messages/send', { method: 'POST', body: JSON.stringify({ raw: toB64url(raw), threadId: msg.threadId }) });
  return sent.id;
}

async function handleOne(model, p, text) {
  const category = parseCategory(await model.complete(classifyPrompt(text)));
  if (category !== 'Customer Support') return { category };
  const context = await knowledge(p, text);
  const reply = String(await model.complete(agentPrompt(text, context))).trim();
  return { category, reply, knowledge_used: Boolean(context) };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = raw ? { email: raw } : {};
  const model = getModelClient(providerConfig);

  try {
    if (p.email) {
      return JSON.stringify(await handleOne(model, p, String(p.email)));
    }
    if (!p.gmail_access_token) {
      return JSON.stringify({ error: 'Send {"email": "..."} or {"gmail_access_token": "..."}. See the header of this file.' });
    }
    const token = p.gmail_access_token;
    const max = Math.max(1, Math.min(50, Number(p.max_emails) || 10));
    const q = p.query || 'is:unread in:inbox';
    const list = await gmail(token, `/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
    const results = [];
    for (const { id } of list.messages || []) {
      const msg = await gmail(token, `/messages/${id}?format=full`);
      const h = headerMap(msg);
      const r = { id, from: h.from, subject: h.subject, ...(await handleOne(model, p, messageText(msg))) };
      if (r.reply) {
        // "Label Query", then "Reply to Query".
        if (p.label_id) {
          try { await gmail(token, `/messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds: [p.label_id] }) }); r.labelled = true; } catch (e) { r.label_error = e.message; }
        }
        if (p.send) {
          try { r.sent_id = await replyInThread(token, msg, r.reply); } catch (e) { r.send_error = e.message; }
        } else {
          r.note = 'Draft only. Add "send": true to send replies.';
        }
      }
      results.push(r);
    }
    return JSON.stringify({ query: q, emails_found: results.length, support_emails: results.filter((r) => r.reply).length, results });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
