// Tech News to LinkedIn Post: a Druve agent ported by hand from the n8n
// template "Post daily Verge tech updates to LinkedIn with Gemini and Airtable"
// by Abdullah Al Shishani (https://n8n.io/workflows/15964).
// Draft for Abdullah to check. Listed on Druve only by Abdullah, under his own name.
//
// What it keeps, unchanged: The Verge RSS feed and the 10-item limit, the
// "Aggregate Fields" arrays (title, URL, Date & Time, author, content, summary,
// id, isoDate), the "AI Agent" prompt word for word, the "Think" tool's
// topic-picking rules word for word, the structured output schema, the LinkedIn
// post layout of the "Post" node, and the Airtable "Record" fields.
// What changes: no schedule, no image rendering and no automatic LinkedIn post.
// The buyer gets the ready post text, the image prompt and the article records,
// and the Airtable row is written only when an Airtable token, base and table
// are given. The Calculator and Wikipedia tools are left out.
//
// Input (JSON), all optional:
//   {"feed": "https://www.theverge.com/rss/index.xml", "max_items": 10,
//    "airtable_token": "pat...", "airtable_base": "app...", "airtable_table": "tbl..."}
// Or paste RSS XML as plain text.
//
// Data-fetch hosts to declare when publishing:
//   www.theverge.com, api.airtable.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

const FEED = 'https://www.theverge.com/rss/index.xml';
const j = (v) => JSON.stringify(v);

// "AI Agent" prompt, verbatim (the aggregated arrays go where n8n put them).
const agentPrompt = (a) => `Role: 
You are helping me turn RSS items into clean records for Airtable and one ready-to-post LinkedIn update.

Input format (from the previous step)
- You receive a single JSON array with one object whose array fields are aligned by index, like this:

title[${j(a.title)}]
URL[${j(a.URL)}]
Date & Time[${j(a['Date & Time'])}] (ISO strings)
author[${j(a.author)}]
content[${j(a.content)}] (HTML, may include images)
summary[${j(a.summary)}] (short text)
id[${j(a.id)}]
isoDate[${j(a.isoDate)}] (ISO strings)
Example: title[0] belongs with URL[0], content[0], etc.

Think:
Use this tool to thing about the best topic to pick.

What to produce
- A list of article records for Airtable with these columns:
- News Title – plain text
- News URL – canonical, without tracking params
- News Article Body – clean text (strip HTML), tight 3–5 sentence brief; avoid fluff
- Date Published – ISO 8601 (UTC) from isoDate or Date & Time (prefer isoDate if present)
- Technology category – one of: AI, Policy/Regulation, Hardware, Gadgets, Apps/Platforms, or Deals
- Create a text to image prompt using only 3 hex colors codes (#f39f1c, #364250, #fefbf6) to generate minimal creative, with characters in the image for linkedin post.

Also include (for my ops use only—NOT for Airtable if you need to keep it minimal):
- Author – if available
- Short Summary – 1–2 sentences

Write a LinkedIn Post in my style:
- Hook (one line, direct, no buzzwords)
- Second Hook (one line that lands the point)
- Title (clear, human)
- Description (4–6 short lines; simple English; no jargon; practical impact for CS/CX)
- Article URL (the chosen article’s clean link)
- Full Post with (Hook, Second Hook, Title, Description, Hashtags, Article URL) in between each there should be a line or 2 lines. to make it as much as formatted for linkedin post. 

Rules
- Strip HTML and unescape entities from content.
- If summary is stronger than the cleaned content, use summary to help the News Article - Body (keep it concise).
- Normalize dates to ISO 8601 (UTC).
- Shorten long URLs if they have obvious tracking params (?utm_ etc.)—remove those params only; do not use link shorteners.
- Be concise and practical. Plain language. No hype.`;

// "Think" tool description, verbatim (here as guidance before answering).
const THINK = "Think silently, to help pick the best topic, as below rules: \n\nChoose ONE best article to continue with:\n- Preference order: (a) AI topics that touch customer service, support, CX, or content operations; (b) broader technology with a plausible CX angle (automation, agent tooling, content, channels, policy that affects hiring/CS).\n- Give a one-line reason for the choice.\n\nCategories:\n- AI → model updates, AI features, GenAI content, automation\n- Policy/Regulation → visas, legal, platform rules\n- Hardware → chips, displays, devices for builders\n- Gadgets → consumer gadgets, wearables\n- Apps/Platforms → social, productivity, messaging, enterprise platforms\n- Deals → sales/discounts\n\nIf nothing fits CX, pick the closest tech/AI item and state the angle (e.g., content workflows, agent enablement, brand engagement).";

// "Structured Output Parser" schema.
const SCHEMA = "{\n  \"type\": \"object\",\n  \"properties\": {\n    \"airtable_records\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"news_title\": { \"type\": \"string\" },\n          \"news_url\": { \"type\": \"string\" },\n          \"news_article_body\": { \"type\": \"string\" },\n          \"date_published\": { \"type\": \"string\" },\n          \"technology_category\": {\n            \"type\": \"string\",\n            \"enum\": [\n              \"AI\",\n              \"Policy/Regulation\",\n              \"Hardware\",\n              \"Gadgets\",\n              \"Apps/Platforms\",\n              \"Deals\"\n            ]\n          },\n          \"image_prompt\": { \"type\": \"string\" },\n          \"ops\": {\n            \"type\": \"object\",\n            \"properties\": {\n              \"author\": { \"type\": \"string\" },\n              \"short_summary\": { \"type\": \"string\" }\n            },\n            \"required\": [\"short_summary\"]\n          }\n        },\n        \"required\": [\n          \"news_title\",\n          \"news_url\",\n          \"news_article_body\",\n          \"date_published\",\n          \"technology_category\",\n          \"image_prompt\",\n          \"ops\"\n        ]\n      }\n    },\n    \"linkedin_post\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"chosen_article_url\": { \"type\": \"string\" },\n        \"hook\": { \"type\": \"string\" },\n        \"second_hook\": { \"type\": \"string\" },\n        \"title\": { \"type\": \"string\" },\n        \"description\": {\n          \"type\": \"array\",\n          \"items\": { \"type\": \"string\" }\n        },\n        \"hashtags\": {\n          \"type\": \"array\",\n          \"items\": { \"type\": \"string\" }\n        },\n        \"full_post\": { \"type\": \"string\" }\n      },\n      \"required\": [\n        \"chosen_article_url\",\n        \"hook\",\n        \"second_hook\",\n        \"title\",\n        \"description\",\n        \"hashtags\",\n        \"full_post\"\n      ]\n    }\n  },\n  \"required\": [\"airtable_records\", \"linkedin_post\"]\n}\n";

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const tag = (b, n) => { const m = b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i')); return m ? decode(m[1]).trim() : ''; };

// n8n's RSS Read output for RSS and Atom (The Verge serves Atom).
function parseFeed(xml) {
  const blocks = String(xml).match(/<entry[\s>][\s\S]*?<\/entry>|<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const link = (b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || tag(b, 'link');
    const date = tag(b, 'published') || tag(b, 'updated') || tag(b, 'pubDate');
    const iso = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : '';
    return {
      title: tag(b, 'title'),
      link: decode(link),
      pubDate: date,
      author: tag(tag(b, 'author') ? b.match(/<author[\s\S]*?<\/author>/i)[0] : '', 'name') || tag(b, 'dc:creator') || tag(b, 'author'),
      content: tag(b, 'content') || tag(b, 'content:encoded') || tag(b, 'description'),
      summary: tag(b, 'summary') || tag(b, 'description'),
      id: tag(b, 'id') || tag(b, 'guid'),
      isoDate: iso,
    };
  });
}

// "Aggregate Fields".
function aggregate(items) {
  return {
    title: items.map((i) => i.title), URL: items.map((i) => i.link), 'Date & Time': items.map((i) => i.pubDate),
    author: items.map((i) => i.author), content: items.map((i) => i.content), summary: items.map((i) => i.summary),
    id: items.map((i) => i.id), isoDate: items.map((i) => i.isoDate),
  };
}

function parseJson(text) {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// The "Post" node's text layout.
function postText(o) {
  const p = o.linkedin_post;
  const description = Array.isArray(p.description) ? p.description.join('\n') : String(p.description || '');
  const url = o.airtable_records?.[0]?.news_url || p.chosen_article_url;
  return `${p.hook}\n\n→ ${p.second_hook}\n\n\n↳ ${p.title}\n\n↳ ${description}\n\nRead More: [${url}]`;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p = {};
  if (raw) {
    try { p = JSON.parse(raw); } catch { p = null; }
    if (!p || typeof p !== 'object' || Array.isArray(p)) p = { rss_xml: raw };
  }
  let items;
  try {
    let xml = p.rss_xml;
    if (!xml) {
      const res = await fetch(p.feed || FEED);
      if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
      xml = await res.text();
    }
    items = parseFeed(xml).slice(0, Math.max(1, Math.min(25, Number(p.max_items) || 10)));
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
  if (!items.length) return JSON.stringify({ error: 'The feed had no items.' });

  // The model sees clean text; HTML stripping is also one of the prompt's rules.
  const a = aggregate(items.map((i) => ({ ...i, content: i.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500) })));
  const model = getModelClient(providerConfig);
  const ask = `${agentPrompt(a)}\n\nBefore answering, think silently using these rules:\n${THINK}\n\nRespond with only one JSON object that matches this JSON Schema, no other text:\n${SCHEMA}`;
  let o = null;
  for (let attempt = 0; attempt < 2 && !(o && o.linkedin_post && Array.isArray(o.airtable_records)); attempt++) o = parseJson(await model.complete(ask));
  if (!(o && o.linkedin_post && Array.isArray(o.airtable_records))) return JSON.stringify({ error: 'The model did not return the expected JSON.', items: items.length });

  const result = { articles_read: items.length, linkedin_post_text: postText(o), image_prompt: o.airtable_records[0]?.image_prompt || '', ...o };
  if (p.airtable_token && p.airtable_base && p.airtable_table) {
    const lp = o.linkedin_post;
    const fields = {
      Source: 'n8n Integration', Status: 'Done', Approved: true, Hashtags: '',
      'Post Body': `${lp.hook}\n${lp.second_hook}\n${lp.title}\n${Array.isArray(lp.description) ? lp.description.join('\n') : lp.description}`,
      'Article URL': o.airtable_records[0]?.news_url || lp.chosen_article_url,
      'Date & Time': new Date().toISOString(),
    };
    try {
      const res = await fetch(`https://api.airtable.com/v0/${encodeURIComponent(p.airtable_base)}/${encodeURIComponent(p.airtable_table)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.airtable_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Airtable HTTP ${res.status}: ${data.error?.message || ''}`.trim());
      result.airtable_record_id = data.records?.[0]?.id;
    } catch (e) {
      result.airtable_error = e.message;
    }
  }
  return JSON.stringify(result);
}
