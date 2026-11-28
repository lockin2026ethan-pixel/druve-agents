// Instagram Profile Analyzer: a Druve agent ported by hand from the n8n
// template "Analyze Instagram profiles with Apify, Google Gemini, and Supabase"
// by Pawan Kumar (https://n8n.io/workflows/9163).
// Draft for Pawan to check. Listed on Druve only by Pawan, under his own name.
//
// What it keeps, unchanged: the Apify Instagram Scraper run (directUrls for the
// profile, resultsType "posts", resultsLimit 5), "JS Prune Payload" (the same
// eight fields per post), the three analysis prompts word for word (niche &
// frequency, content & strategy, engagement & actions, run side by side), the
// "Compile Final Report Object" shape (niche_analysis, content_strategy,
// engagement_actions), and the Supabase "reports" table with its 24-hour cache
// (checked by username) and update-or-insert.
// What changes: no webhook. The buyer runs it with a username. Supabase is
// optional; without it every run scrapes fresh. Posts can also be pasted.
//
// Input (JSON):
//   {"username": "natgeo", "apify_token": "apify_api_...", "results_limit": 5,
//    "supabase_url": "https://<project>.supabase.co", "supabase_key": "..."}
//   or {"username": "natgeo", "posts": [{caption, type, likesCount, commentsCount, ...}]}
// Plain text input is treated as the username.
//
// Data-fetch hosts to declare when publishing:
//   api.apify.com, and your Supabase project host if you use the cache
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key and accounts.

import { getModelClient } from '@druve/cli/providers';

// The three Gemini prompts, verbatim.
const PROMPTS = {
  niche_analysis: (u, d) => `Analyze this profile data for @${u}. Identify profile overview, core niche, posting frequency patterns, and best performing post times:\n\n${d}`,
  content_strategy: (u, d) => `Analyze content strategy for @${u}. Breakdown themes, format distribution (Reels vs Carousels), caption tones, and hashtag usage strategy:\n\n${d}`,
  engagement_actions: (u, d) => `Calculate total engagement insights for @${u}. Extract performance analysis on top posts, list 5 hyper-actionable growth recommendations, and point out missing content gaps:\n\n${d}`,
};

// "JS Prune Payload".
function prune(posts) {
  return posts.map((p) => ({
    id: p.id,
    type: p.type,
    caption: p.caption || '',
    likesCount: p.likesCount || 0,
    commentsCount: p.commentsCount || 0,
    videoViewCount: p.videoViewCount || 0,
    timestamp: p.timestamp,
    hashtags: p.hashtags || [],
  }));
}

async function scrape(token, username, limit) {
  const res = await fetch(`https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directUrls: [`https://www.instagram.com/${username}/`], resultsType: 'posts', resultsLimit: limit }),
  });
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const items = await res.json();
  return Array.isArray(items) ? items.filter((i) => !i.error) : [];
}

function supa(p) {
  const base = String(p.supabase_url || '').replace(/\/+$/, '');
  const headers = { apikey: p.supabase_key, Authorization: `Bearer ${p.supabase_key}`, 'Content-Type': 'application/json' };
  return {
    async cached(username) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const res = await fetch(`${base}/rest/v1/reports?select=*&username=eq.${encodeURIComponent(username)}&updated_at=gt.${encodeURIComponent(since)}`, { headers });
      if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const rows = await res.json();
      return rows[0] || null;
    },
    async save(username, scraped_data, analysis_report) {
      const res = await fetch(`${base}/rest/v1/reports?username=eq.${encodeURIComponent(username)}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify({ analysis_report, scraped_data }) });
      if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const updated = await res.json();
      if (Array.isArray(updated) && updated.length) return 'updated';
      const ins = await fetch(`${base}/rest/v1/reports`, { method: 'POST', headers, body: JSON.stringify({ username, analysis_report, scraped_data }) });
      if (!ins.ok) throw new Error(`Supabase HTTP ${ins.status}: ${(await ins.text()).slice(0, 200)}`);
      return 'inserted';
    },
  };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { username: raw };
  const username = String(p.username || '').replace('@', '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');
  if (!username) return JSON.stringify({ error: 'Send {"username": "...", "apify_token": "..."}. See the header of this file.' });

  const db = p.supabase_url && p.supabase_key ? supa(p) : null;
  const out = { username };
  try {
    if (db && !p.refresh) {
      const hit = await db.cached(username);
      if (hit) return JSON.stringify({ username, cached: true, ...(typeof hit.analysis_report === 'string' ? JSON.parse(hit.analysis_report) : hit.analysis_report) });
    }
    let posts;
    if (Array.isArray(p.posts)) posts = p.posts;
    else if (p.apify_token) posts = await scrape(p.apify_token, username, Math.max(1, Math.min(50, Number(p.results_limit) || 5)));
    else return JSON.stringify({ error: 'Add "apify_token" to scrape the profile, or paste "posts".' });
    if (!posts.length) return JSON.stringify({ username, error: 'No data returned' });

    const scraped_data = prune(posts);
    const data = JSON.stringify(scraped_data);
    const model = getModelClient(providerConfig);
    const [niche, content, engagement] = await Promise.all(
      Object.values(PROMPTS).map(async (f) => String(await model.complete(f(username, data))).trim()),
    );
    const analysis_report = { niche_analysis: niche, content_strategy: content, engagement_actions: engagement };
    Object.assign(out, { cached: false, posts_analyzed: scraped_data.length, ...analysis_report });
    if (db) {
      try { out.supabase = await db.save(username, scraped_data, analysis_report); } catch (e) { out.supabase_error = e.message; }
    }
    return JSON.stringify(out);
  } catch (e) {
    return JSON.stringify({ username, error: e.message });
  }
}
