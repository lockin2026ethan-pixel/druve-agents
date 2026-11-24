// AI-Powered News to Video Generator: a Druve agent built for David Olusola from
// his own n8n workflow "AI-Powered News to Video Generator with Heygen & GPT4o"
// (export he sent on 24 Nov 2026). Nothing is published until David publishes it.
//
// What it keeps, unchanged: the AI Agent prompt word for word (his "generate a
// short, engaging caption (30-60 seconds)..." text, with {{ $json.Title }} and
// {{ $json.Content }} filled in), the RSS source (CNN edition feed by default),
// the Limit step (one news item per run), and the HeyGen "Create Avatar Video"
// request body as he wrote it (avatar "normal" style, text voice at speed 1.1,
// 1280x720), plus the video_status.get check.
// What changes: the Google Sheets logs and the Google Drive upload are left out
// (a Druve agent cannot log in to Google). The agent returns the title, the
// caption and, if HeyGen details are given, the HeyGen video id and video URL.
//
// Input (JSON):
//   {"feed_url": "http://rss.cnn.com/rss/edition.rss",         // optional
//    "title": "...", "content": "...",                          // optional: skip RSS
//    "heygen_api_key": "...", "avatar_id": "...", "voice_id": "...",  // optional
//    "wait": true}                                              // optional: poll until the video is ready
// or plain text: a news article (first line = title). With no input at all it
// reads the newest item from the CNN feed.
//
// Data-fetch hosts to declare when publishing: rss.cnn.com, api.heygen.com
// (add the host of any other feed you point it at).

import { getModelClient } from '@druve/cli/providers';

const DEFAULT_FEED = 'http://rss.cnn.com/rss/edition.rss'; // RSS Read node
const HEYGEN = 'https://api.heygen.com';

// Author's AI Agent prompt, verbatim (n8n node "AI Agent", promptType "define").
const PROMPT = "= generate a short, engaging caption (30–60 seconds)on title:{{ $json.Title }} news content:{{ $json.Content }} i want just one caption out puy only the caption nothing extra because the caption is going dirctly to the video avatar site";

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

function firstItem(xml) {
  const item = (xml.match(/<item[\s>][\s\S]*?<\/item>/i) || [])[0];
  if (!item) return null;
  const tag = (t) => decode((item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1]);
  return {
    title: tag('title'),
    content: tag('content:encoded') || tag('description'),
    link: tag('link'),
  };
}

function readInput(input) {
  const raw = String(input || '').trim();
  let p = null;
  try { p = JSON.parse(raw); } catch { /* plain text */ }
  if (p && typeof p === 'object') return p;
  if (!raw) return {};
  const [first, ...rest] = raw.split('\n');
  return { title: first.trim(), content: rest.join('\n').trim() || first.trim() };
}

async function heygen(path, key, init = {}) {
  const res = await fetch(`${HEYGEN}${path}`, {
    ...init,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HeyGen HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

export async function handleMessage(input, providerConfig) {
  const p = readInput(input);
  const errors = [];

  // RSS Read + Limit: one news item.
  let news = p.title || p.content ? { title: String(p.title || ''), content: String(p.content || ''), link: p.link || '' } : null;
  if (!news) {
    const url = p.feed_url || DEFAULT_FEED;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      news = firstItem(await res.text());
      if (!news) throw new Error('no <item> in the feed');
    } catch (e) {
      return JSON.stringify({ error: `Could not read the RSS feed (${url}): ${e.message}. You can pass "title" and "content" instead.` });
    }
  }

  // AI Agent: the author's prompt with Title and Content filled in.
  const prompt = PROMPT.replace(/^=\s*/, '')
    .split('{{ $json.Title }}').join(news.title)
    .split('{{ $json.Content }}').join(news.content);
  const model = getModelClient(providerConfig);
  const caption = String(await model.complete(prompt)).trim();

  const out = { title: news.title, link: news.link || null, caption, heygen: null, errors };

  // Setup Heygen + Create Avatar Video (only when the buyer gives HeyGen details).
  if (p.heygen_api_key && p.avatar_id && p.voice_id) {
    try {
      const created = await heygen('/v2/video/generate', p.heygen_api_key, {
        method: 'POST',
        body: JSON.stringify({
          video_inputs: [{
            character: { type: 'avatar', avatar_id: p.avatar_id, avatar_style: 'normal' },
            voice: { type: 'text', input_text: caption, voice_id: p.voice_id, speed: 1.1 },
          }],
          dimension: { width: 1280, height: 720 },
        }),
      });
      const videoId = created?.data?.video_id;
      out.heygen = { video_id: videoId, status: 'processing', video_url: null };
      // Wait + Get Avatar Video: poll the status if asked (up to about 10 minutes).
      if (p.wait && videoId) {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 15000));
          const st = await heygen(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, p.heygen_api_key);
          out.heygen.status = st?.data?.status || out.heygen.status;
          if (st?.data?.video_url) { out.heygen.video_url = st.data.video_url; break; }
          if (out.heygen.status === 'failed') { errors.push(`HeyGen: ${JSON.stringify(st?.data?.error || st).slice(0, 200)}`); break; }
        }
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  return JSON.stringify(out);
}
