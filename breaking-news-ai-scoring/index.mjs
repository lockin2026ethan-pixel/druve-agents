// Breaking News AI Scoring: a Druve agent ported by hand from the n8n template
// "Filter breaking geopolitical news with AI scoring & Telegram alerts" by
// Devjothi Dutta (https://n8n.io/workflows/10248).
// Draft for Devjothi to check. Listed on Druve only by Devjothi, under his own name.
//
// What it keeps, unchanged: the default config from the template's Google Drive
// file (India geopolitics: ai_role, alert_threshold 6, primary and secondary
// keywords, the five scoring bands), the "RSS_Cleanup_Node" field mapping, the
// "Dynamic Filter" (at least one primary AND one secondary keyword), the
// "Dynamic AI Prompt Generator" system prompt word for word, the "Breaking News
// Analyzer" user text word for word, the output fields of the structured
// parser, and the "Aggregate Alerts" Telegram message format word for word.
// What changes: no schedule and no n8n data table. The buyer runs it when they
// want a check (or on their own schedule with the Druve CLI). Duplicates are
// skipped within a run, and links from earlier runs can be passed in
// "seen_links". The Telegram alert is sent only when a bot token and chat id
// are given.
//
// Input (JSON), all fields optional:
//   {"feeds": ["https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
//    "config": {"ai_role": "...", "alert_threshold": 6, "primary_keywords": [...], ...},
//    "articles": [{"title": "...", "contentSnippet": "...", "link": "...", "source": "...", "pubDate": "..."}],
//    "rss_xml": ["<rss>...</rss>"],
//    "seen_links": ["https://..."], "max_articles": 20,
//    "telegram_bot_token": "123:ABC", "telegram_chat_id": "-100..."}
// With no input at all it reads the two default feeds (NYT World, BBC World).
// Other feeds from the template (Times of India, Al Jazeera, SCMP, NDTV) need
// their hosts declared too; Druve allows 3, so paste their XML into "rss_xml"
// or their items into "articles" instead.
//
// Data-fetch hosts to declare when publishing:
//   rss.nytimes.com, feeds.bbci.co.uk, api.telegram.org
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

const DEFAULT_FEEDS = [
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
];

// The template's config file, as published by the author.
const DEFAULT_CONFIG = {
  config_id: 'india_geopolitics',
  config_name: 'India Geopolitical Alerts',
  ai_role: 'geopolitical news analyst for India',
  alert_threshold: 6,
  primary_keywords: ['india', 'indian', 'delhi', 'modi', 'jaishankar'],
  secondary_keywords: [
    'military', 'skirmish', 'strike', 'missile', 'brahmos', 'drone', 'conflict', 'kashmir', 'myanmar',
    'pakistan', 'border', 'tariff', 'defense deal', 'notam', 'trade deal', 'sanction', 'geopolitic',
    'diplomat', 'treaty', 'agreement',
  ],
  scoring_criteria: [
    { score_min: 9, score_max: 10, category: 'Military Action', description: 'Missile strikes, combat, border clashes, military skirmishes' },
    { score_min: 8, score_max: 9, category: 'Conflict Updates', description: 'Escalations, casualties, tactical developments, NOTAM alerts' },
    { score_min: 7, score_max: 8, category: 'Trade/Economic', description: 'Tariffs, sanctions, major trade deals, economic tensions' },
    { score_min: 6, score_max: 7, category: 'Defense Agreements', description: 'Arms deals, military pacts, defense partnerships' },
    { score_min: 5, score_max: 6, category: 'Diplomatic', description: 'Treaties, strategic partnerships, diplomatic visits' },
  ],
};

// "Dynamic AI Prompt Generator", verbatim.
function systemPrompt(config) {
  let criteriaText = '';
  for (const rule of config.scoring_criteria) {
    criteriaText += `  • ${rule.category} (${rule.score_min}-${rule.score_max}): ${rule.description}\n`;
  }
  return `You are a ${config.ai_role}. Analyze RSS articles for breaking news urgency.

  BREAKING NEWS CRITERIA:
  ${criteriaText}
  NOT BREAKING (1-4): Routine updates, opinion pieces

  INSTRUCTIONS:
  You receive: title, contentSnippet, link, source, pubDate

  1. Analyze urgency score (1-10)
  2. If score < ${config.alert_threshold}: Set should_alert = false
  3. If score >= ${config.alert_threshold}: Set should_alert = true

  Always return ALL these fields:
  - score: [1-10 based on breaking news urgency]
  - category: [Category name matching the score range]
  - alert_topic: [use the article title]
  - alert_description: [use contentSnippet]
  - impact: [your one-sentence impact analysis]
  - source: [use source field]
  - timestamp: [use pubDate]
  - link: [use link field]
  - should_alert: [false if score < ${config.alert_threshold}, true if score >= ${config.alert_threshold}]`;
}

// "Breaking News Analyzer" user text, verbatim.
const userText = (a) => 'Analyze this article:\n\nTitle: ' + a.title + '\n\nContent: ' + a.contentSnippet + '\n\nLink: ' +
  a.link + '\n\nSource: ' + a.source + '\n\nPublished: ' + a.pubDate;

// The structured output parser's example, given to the model as the format.
const FORMAT = `Respond with only a JSON object in this format, no other text:
{
    "score": 8,
    "category": "Trade Policy",
    "alert_topic": "India announces new tariffs on Chinese imports",
    "alert_description": "Government unveils comprehensive tariff structure affecting electronics and manufacturing sectors",
    "impact": "Significant escalation in trade tensions, potential retaliation expected",
    "source": "Times of India",
    "timestamp": "2025-10-25T20:30:00+05:30",
    "link": "https://timesofindia.indiatimes.com/article/12345",
    "should_alert": true
  }`;

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const stripHTML = (html) => (html ? html.replace(/<[^>]*>/g, '').trim() : '');

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}

// RSS (and Atom) items, then "RSS_Cleanup_Node": link, title, contentSnippet, pubDate, source.
function parseFeed(xml) {
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let link = tag(b, 'link');
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const source = tag(b, 'dc:creator') || tag(b, 'author') || 'Unknown';
    const contentSnippet = stripHTML(tag(b, 'description') || tag(b, 'summary')) || stripHTML(tag(b, 'content:encoded') || tag(b, 'content')) || '';
    const pubDate = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published');
    return { link: decode(link), title: stripHTML(tag(b, 'title')), contentSnippet, pubDate, source };
  });
}

// "Dynamic Filter": at least one primary AND one secondary keyword.
function matches(a, config) {
  const text = `${a.title} ${a.contentSnippet}`.toLowerCase();
  const hasPrimary = config.primary_keywords.some((kw) => text.includes(kw.toLowerCase()));
  const hasSecondary = config.secondary_keywords.some((kw) => text.includes(kw.toLowerCase()));
  return hasPrimary && hasSecondary;
}

function parseJson(text) {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// "Aggregate Alerts", verbatim.
function aggregate(outputs) {
  let message = `🚨 BREAKING NEWS ALERTS (${outputs.length} items)\n\n`;
  outputs.forEach((output, index) => {
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `${index + 1}. BREAKING: ${output.category}\n\n`;
    message += `📰 Source: ${output.source}\n`;
    message += `💥 Impact: ${output.impact}\n\n`;
    message += `📌 ${output.alert_topic}\n\n`;
    message += `📄 ${output.alert_description}\n\n`;
    message += `🔗 Read More: ${output.link}\n\n`;
    message += `⏰ Alert Time: ${output.timestamp}\n`;
    message += `Score: ${output.score}\n\n`;
  });
  return message;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendTelegram(token, chatId, message) {
  // Telegram caps a message at 4096 characters; long batches go in parts.
  const parts = message.match(/[\s\S]{1,3900}(?=\n|$)|[\s\S]{1,3900}/g) || [];
  for (const text of parts) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: escapeHtml(text), parse_mode: 'HTML' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(`Telegram HTTP ${res.status}: ${data.description || ''}`.trim());
  }
  return parts.length;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p = {};
  if (raw) {
    try { p = JSON.parse(raw); } catch { p = null; }
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      p = raw.includes('<item') || raw.includes('<entry') ? { rss_xml: [raw] } : { articles: [{ title: raw, contentSnippet: '', link: '', source: 'Pasted', pubDate: '' }] };
    }
  }
  const config = { ...DEFAULT_CONFIG, ...(p.config || {}) };

  const items = [];
  const errors = [];
  if (Array.isArray(p.articles)) items.push(...p.articles.map((a) => ({ link: '', title: '', contentSnippet: '', pubDate: '', source: 'Unknown', ...a })));
  for (const xml of Array.isArray(p.rss_xml) ? p.rss_xml : []) items.push(...parseFeed(xml));
  const feeds = Array.isArray(p.feeds) ? p.feeds : (p.articles || p.rss_xml ? [] : DEFAULT_FEEDS);
  for (const url of feeds) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items.push(...parseFeed(await res.text()));
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }

  // Skip duplicates, then keyword filter, then cap how many go to the model.
  const seen = new Set((p.seen_links || []).map(String));
  const fresh = [];
  for (const a of items) {
    const key = a.link || a.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(a);
  }
  const filtered = fresh.filter((a) => matches(a, config));
  const max = Math.max(1, Math.min(100, Number(p.max_articles) || 20));
  const toAnalyze = filtered.slice(0, max);

  const model = getModelClient(providerConfig);
  const system = systemPrompt(config);
  const analyzed = [];
  for (const a of toAnalyze) {
    const reply = await model.complete(`${system}\n\n${userText(a)}\n\n${FORMAT}`);
    const out = parseJson(reply);
    if (!out) { errors.push(`Could not read the model's answer for: ${a.title}`); continue; }
    const score = Number(out.score);
    // The If node checks should_alert; the threshold rule from the prompt is applied too.
    out.should_alert = out.should_alert === true || out.should_alert === 'true' || (Number.isFinite(score) && score >= Number(config.alert_threshold));
    analyzed.push(out);
  }
  const alerts = analyzed.filter((o) => o.should_alert);

  const result = {
    config: config.config_name || config.config_id,
    articles_read: items.length,
    matched_keywords: filtered.length,
    analyzed: analyzed.length,
    alerts: alerts.length,
    message: alerts.length ? aggregate(alerts) : '',
    scored: analyzed.map((o) => ({ score: o.score, category: o.category, title: o.alert_topic, link: o.link, should_alert: o.should_alert })),
    seen_links: [...seen],
  };
  if (filtered.length > toAnalyze.length) result.not_analyzed = filtered.length - toAnalyze.length;
  if (errors.length) result.errors = errors;

  const chatId = p.telegram_chat_id || (config.telegram_chat_id !== 'YOUR_TELEGRAM_CHAT_ID' ? config.telegram_chat_id : '');
  if (alerts.length && p.telegram_bot_token && chatId) {
    try { result.telegram_messages = await sendTelegram(p.telegram_bot_token, chatId, result.message); } catch (e) { result.telegram_error = e.message; }
  }
  return JSON.stringify(result);
}
