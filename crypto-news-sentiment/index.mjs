// Crypto News & Sentiment: a Druve agent ported by hand from the n8n template
// "Real-time Crypto News & Sentiment Analysis via Telegram with GPT-4o" by Don
// Jayamaha Jr. (https://n8n.io/workflows/3751). Draft for Don to check.
// Nothing is published.
//
// What it keeps, unchanged: the keyword agent's system message, the "Filter
// by Query" logic, the "Build Prompt" text and the analyst line sent with it.
// It fetches the news live, like the template.
// What changes: Druve lets an agent declare at most 3 hosts it may fetch from,
// so it reads 3 of the template's 9 RSS feeds (Cointelegraph, CoinDesk,
// crypto.news). Swap any of them for the others in FEEDS. Declare the same 3
// hostnames under "Data fetch targets" when you publish.
// Small additions: if no article mentions the coin, it says so instead of
// asking the model to summarize an empty list, and it caps the list at 25.
// What it leaves out: Telegram in and out.
//
// Input: a question or a coin name, for example "What's the news on Solana?"
//
// Data fetch targets to declare: cointelegraph.com, www.coindesk.com, crypto.news
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

const FEEDS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss", // template has a trailing slash, which now 308-redirects here
  "https://crypto.news/feed/",
];
const MAX_ARTICLES = 25;

// Author's text, verbatim.
const KEYWORD_SYSTEM = "Your job is to analyze the keyword of the question and output it as a single word.";
const ANALYST_LINE = "You are a crypto‐industry news analyst. Summarize sentiment clearly and concisely.";

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

async function readFeed(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Druve agent)' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map((it) => ({
      title: tag(it, 'title'),
      link: tag(it, 'link'),
      contentSnippet: tag(it, 'description'),
      content: tag(it, 'content:encoded'),
    }));
  } catch {
    return [];
  }
}

export async function handleMessage(input, providerConfig) {
  const question = String(input || '').trim();
  if (!question) return 'Ask about a coin or crypto company, for example: "What is the news on Solana?"';
  const model = getModelClient(providerConfig);

  // Keyword agent: the author's system message, then the user's question.
  const raw = String(await model.complete(`${KEYWORD_SYSTEM}\n\n${question}`)).trim();
  const q = (raw.split(/\s+/)[0] || question).replace(/[^\p{L}\p{N}.\-]/gu, '');

  // RSS feeds, merged.
  const items = (await Promise.all(FEEDS.map(readFeed))).flat();

  // Filter by Query: the author's logic.
  const term = q.toLowerCase();
  const hits = items.filter((j) => {
    const title = (j.title || '').toLowerCase();
    const snippet = (j.contentSnippet || j.description || '').toLowerCase();
    const fullContent = (j.content || '').toLowerCase();
    return title.includes(term) || snippet.includes(term) || fullContent.includes(term);
  }).slice(0, MAX_ARTICLES);

  if (!items.length) return 'Could not reach the news feeds just now. Try again in a minute.';
  if (!hits.length) return `None of the latest ${items.length} articles from Cointelegraph, CoinDesk and crypto.news mention "${q}".`;

  // Build Prompt: the author's text.
  const list = hits.map((i) => `- ${i.title} (${i.link})`).join('\n');
  const prompt = `
You are a crypto-industry news analyst.
Summarize current news and market sentiment for **${q}** based on these articles:
${list}

Answer in 3 parts:
1. Summary of News
2. Market Sentiment
3. Links to reference news articles
`;
  const summary = await model.complete(`${ANALYST_LINE}\n${prompt}`);
  return String(summary).trim();
}
