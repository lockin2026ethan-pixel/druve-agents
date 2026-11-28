// News to Mindful Instagram Post: a Druve agent ported by hand from the n8n
// template "Post daily Instagram news carousels using Claude and Gemini" by
// Prakhyat Sapkale (https://n8n.io/workflows/19934).
// Draft for Prakhyat to check. Listed on Druve only by Prakhyat, under his own name.
//
// What it keeps, unchanged: the four topic feeds of "Pick the Daily Topic"
// (Google News searches, each with its lens, tradition and series), "Build News
// Context" (top 3 headlines), the "Write the Post with Claude" system message and
// prompt word for word (including the post_type_mode switch), the "Post Output
// Parser" schema, and "Normalize & Plan Slides" word for word: the post type rule,
// the 4-slide cap, the BRAND image prompt for every slide, and the caption with
// hashtags appended after ".\n.\n.".
// What changes: no schedule, no image rendering, no S3 and no Instagram publish.
// The buyer gets the finished post (caption, hashtags, slide texts) plus one
// ready image prompt per slide to render with any image model. The template
// rotates topics after each publish; here the buyer picks "topic_index" (0-3),
// or it follows the day of the year.
//
// Input (JSON), all optional:
//   {"topic_index": 1, "post_type_mode": "AUTO" | "SINGLE_IMAGE" | "CAROUSEL"}
//   or your own topic: {"category": "...", "focus": "...", "topic": "...", "feed_url": "https://news.google.com/rss/search?q=..."}
//   or your own headlines: {"news_context": [{"title": "...", "snippet": "..."}], "category": "...", "focus": "...", "topic": "..."}
// Plain text input is treated as one headline for the day's topic.
//
// Data-fetch host to declare when publishing:
//   news.google.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "Pick the Daily Topic" feeds, verbatim.
const trendFeeds = [
  { category: "Disconnection & Loss of Meaning", feed_url: "https://news.google.com/rss/search?q=loneliness+disconnection+community+crisis&hl=en-US&gl=US&ceid=US:en", focus: "Yoga Sutras", topic: "Yoga Sutras: The Thread of Wisdom" },
  { category: "Workplace Stress & Corporate Burnout", feed_url: "https://news.google.com/rss/search?q=workplace+stress+burnout+corporate&hl=en-US&gl=US&ceid=US:en", focus: "Pranayama & Nervous System Reset", topic: "Pranayama: The Breath of Life" },
  { category: "Sedentary Lifestyle & Physical Tension", feed_url: "https://news.google.com/rss/search?q=sedentary+lifestyle+health+posture+pain&hl=en-US&gl=US&ceid=US:en", focus: "Hatha Yoga & Somatic Alignment", topic: "Hatha Yoga: Body as Wisdom" },
  { category: "Mental Health & Overwhelm", feed_url: "https://news.google.com/rss/search?q=mental+health+anxiety+overwhelm+presence&hl=en-US&gl=US&ceid=US:en", focus: "Spiritual Philosophy & Mindfulness", topic: "Spiritual Philosophy: Awakening to the Present" },
];

// "Write the Post with Claude" system message, verbatim.
const SYSTEM = "You are the editorial voice of an Instagram account that connects live world events to Yoga, Pranayama and Spiritual Philosophy.\n\nNON-NEGOTIABLE EDITORIAL RULES\n- GROUNDED. No hype, no mysticism-as-decoration, no overclaiming. Stay inside what the tradition actually says and what a reader can verify in their own body within minutes. Never promise cures, healing or outcomes. Never make medical claims.\n- EMPATHETIC. The news hook is usually distressing. Name the difficulty honestly before you offer anything. Never bypass it with forced positivity.\n- ACTIONABLE. Every post resolves into one specific thing the reader can do, drawn from across the full range of the tradition - breath, posture, movement, sensory grounding, or reframe - with counts or durations. Rotate which of these you reach for; do not let breathwork dominate by default just because it is the most familiar.\n- The news is a DOORWAY, not the subject. State what happened factually and neutrally. Never take a side, never assign blame, never comment on politics or personalities.\n\nTHE SPECIFICITY RULE - this is the one you are most likely to break\nYou are handed real headlines. Your caption must let a reader tell exactly WHICH story this post is answering. Name the concrete development: the who, the what, the where, the sector, the finding, the number. These phrases are FORBIDDEN: \"recent discussions\", \"current events\", \"the news lately\", \"what's happening in the world\", \"conversations around\", \"a lot of people are talking about\". Apply this test before you answer: if your caption would still read fine with a completely different news story pasted in, it has failed and you must rewrite it with the actual specifics.\n\nOn-image copy is display type, not prose. It must be short enough to read on a phone thumbnail, and every character limit given below is a hard limit, not a target.";

// "Write the Post with Claude" prompt, verbatim (mode is post_type_mode from "Your Settings").
const promptText = (ctx, mode) => `TODAY'S REAL HEADLINES (Google News):
${JSON.stringify(ctx.news_context, null, 2)}
LENS: ${ctx.category}
TRADITION: ${ctx.focus}
SERIES: ${ctx.topic}

Pick the single strongest headline above - the one with the most concrete, human detail - and build one Instagram post from it. Produce these fields:

news_hook - one sentence, max 25 words, factually naming the specific development from the headline you picked: the who/what/where, or the finding, or the number. Everything else refers back to this.

problem - what that development reveals about how people are actually suffering right now. Concrete and human, not abstract.

solution - what ${ctx.focus} teaches about this. Grounded in the real tradition; name the concept or text where there is one.

practice - ONE specific technique with concrete counts or durations, doable in under five minutes, seated, anywhere, with no props. Choose whichever technique family genuinely fits ${ctx.focus} and today's problem best - do not default to breath-counting unless it is truly the best fit. Vary the family post to post rather than repeating the same pattern:
  - Breath: a counted inhale/exhale/hold pattern
  - Body-based: a counted body scan or point-by-point tension release
  - Sensory grounding: a counted noticing exercise (e.g. naming a fixed number of things per sense)
  - Repetition: a counted mantra, phrase, or silent repetition practice
  - Micro-movement: a counted small physical gesture or seated stretch sequence
  State it in full with its numbers, e.g. "trace each fingertip slowly, five breaths per hand" or "silently repeat the phrase on each exhale, ten times" - not just "breathe deeply."

post_type - ${({ SINGLE_IMAGE: 'always "SINGLE_IMAGE".', CAROUSEL: 'always "CAROUSEL".' })[mode] || '"SINGLE_IMAGE" when the practice is a single shift or a single breath that fits on one frame. "CAROUSEL" when it genuinely needs sequential steps.'}

caption - 130 to 200 words BEFORE hashtags, flowing paragraphs, no numbered lists, in this order:
1. OPEN WITH THE NEWS. Two or three sentences describing the specific development from news_hook: what happened, where, and the number or finding that makes it real. A reader who never saw the headline must understand the story from your caption alone.
2. ACKNOWLEDGE. One or two sentences naming honestly what that actually feels like for the people living it. No silver lining yet.
3. BRIDGE. Two or three sentences on what ${ctx.focus} offers here and why - state the mechanism plainly. No mystical hand-waving.
4. THE PRACTICE. Two or three sentences giving the technique from \`practice\` in full, with its counts, so it can be done straight from the caption.
5. CLOSE. One warm, low-pressure sentence. No "DM me", no follow-bait, no growth-hack CTA.
Do not put hashtags anywhere inside the caption text.

hashtags - 8 to 12 entries, each starting with "#". Mix broad tags with ones specific to today's angle.

slides - ${({ SINGLE_IMAGE: 'exactly 1 item.', CAROUSEL: 'exactly 4 items.' })[mode] || 'exactly 1 item for SINGLE_IMAGE, 3 to 5 items for CAROUSEL.'} Each item:
  headline - the big line drawn ON the image. HARD LIMIT 6 words and 38 characters. Concrete and specific to this post, never a generic mood phrase. Title Case. No quotation marks, no emoji, no trailing punctuation. Slide 1 names the tension and the final slide names the takeaway.
  sub - the supporting line drawn ON the image, directly under the headline. HARD LIMIT 12 words and 70 characters. It must carry information the headline does not already have: the count, the mechanism, the step number, the duration. Sentence case. No emoji.
  body - one or two sentences of editorial context for this slide. This is NOT drawn on the image.
  visual_prompt - SUBJECT MATTER ONLY, max 30 words: the people, posture, objects, arrows and diagram labels needed. NEVER mention colour, palette, art style, typeface, background or "flat vector" - the brand system fixes all of that.`;

// "Post Output Parser" schema, given to the model as the required format.
const SCHEMA = "{\n  \"type\": \"object\",\n  \"properties\": {\n    \"news_hook\": {\n      \"type\": \"string\",\n      \"description\": \"One sentence, max 25 words, naming the specific development from the chosen headline: who/what/where, or the finding, or the number.\"\n    },\n    \"problem\": {\n      \"type\": \"string\",\n      \"description\": \"What that development reveals about how people are suffering right now. Concrete and human.\"\n    },\n    \"solution\": {\n      \"type\": \"string\",\n      \"description\": \"What the tradition teaches about this, grounded in the real tradition. Name the concept or text where there is one.\"\n    },\n    \"practice\": {\n      \"type\": \"string\",\n      \"description\": \"One specific technique with counts or durations, doable in under five minutes, seated, with no props.\"\n    },\n    \"post_type\": {\n      \"type\": \"string\",\n      \"enum\": [\"SINGLE_IMAGE\", \"CAROUSEL\"],\n      \"description\": \"SINGLE_IMAGE for one shift or one breath that fits on a single frame; CAROUSEL when sequential steps are genuinely needed.\"\n    },\n    \"caption\": {\n      \"type\": \"string\",\n      \"description\": \"130-200 words before hashtags, flowing paragraphs. Order: news specifics, honest acknowledgement, bridge to the tradition with its mechanism, the full practice with counts, warm close. No hashtags inside this text. Must name the actual news story concretely.\"\n    },\n    \"hashtags\": {\n      \"type\": \"array\",\n      \"items\": { \"type\": \"string\" },\n      \"description\": \"8 to 12 hashtags, each starting with '#'. Mix broad tags with ones specific to today's angle.\"\n    },\n    \"slides\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"headline\": {\n            \"type\": \"string\",\n            \"description\": \"Big line drawn ON the image. Hard limit 6 words and 38 characters. Title Case, concrete, no quotes, no emoji, no trailing punctuation.\"\n          },\n          \"sub\": {\n            \"type\": \"string\",\n            \"description\": \"Supporting line drawn ON the image under the headline. Hard limit 12 words and 70 characters. Must add information the headline lacks: count, mechanism, step number or duration. Sentence case, no emoji.\"\n          },\n          \"body\": {\n            \"type\": \"string\",\n            \"description\": \"One or two sentences of editorial context. NOT drawn on the image.\"\n          },\n          \"visual_prompt\": {\n            \"type\": \"string\",\n            \"description\": \"Subject matter only, max 30 words: people, posture, objects, arrows, diagram labels. Never mention colour, palette, art style, typeface or background.\"\n          }\n        },\n        \"required\": [\"headline\", \"sub\", \"body\", \"visual_prompt\"]\n      },\n      \"description\": \"Exactly 1 item for SINGLE_IMAGE, 3 to 5 items for CAROUSEL.\"\n    }\n  },\n  \"required\": [\n    \"news_hook\",\n    \"problem\",\n    \"solution\",\n    \"practice\",\n    \"post_type\",\n    \"caption\",\n    \"hashtags\",\n    \"slides\"\n  ]\n}";

// "Normalize & Plan Slides": brand system, verbatim.
const BRAND = [
  'Design a 3:4 vertical Instagram poster.',
  '',
  'BACKGROUND COLOR (non-negotiable, exact, never vary): the entire background is a single flat solid fill of exactly hex #F7F4EC. No gradients, no shading, no texture, no tone variation anywhere in the background - one uniform color, edge to edge.',
  '',
  'BRAND SYSTEM (fixed, never vary): flat 2D minimalist vector illustration in an editorial infographic style. Sage green and terracotta orange accents only, with dark forest green for type. Clean geometric shapes, generous white space, no gradients, no photorealism, no 3D, no drop shadows, no paper texture.',
  '',
  'NO BORDERS, BOXES OR PLACEHOLDER SHAPES: do not draw any border, frame, card, rectangle, panel, sticky note, tag, badge or placeholder shape anywhere on the poster. The illustration and text sit directly on the flat background with nothing boxed, outlined or bordered.',
  '',
  'LAYOUT (strict):',
  '- SAFE AREA: every piece of text and every important element must sit inside the central safe area, at least 10% of the width in from the left and right edges and at least 12% of the height in from the top and bottom edges (Instagram trims roughly 3% off the top and 3% off the bottom when it displays this frame, so the top and bottom bands must hold nothing that matters). Nothing may touch or bleed off an edge. This poster is viewed as a cropped grid thumbnail, so the headline must be fully readable with room to spare on all four sides.',
  '- TOP THIRD: the headline. Bold geometric sans-serif, dark forest green, centred, on 1 or 2 lines, set large enough to read at thumbnail size.',
  '- DIRECTLY UNDER THE HEADLINE: the supporting line. Same sans-serif at a lighter weight, muted grey-green, centred, on 1 or 2 lines, clearly smaller than the headline.',
  '- LOWER TWO THIRDS: the illustration.',
   'TYPOGRAPHY: render the two text strings below exactly as written, correctly spelled, with no extra or substituted words. Do not add any other caption, label, date, handle, signature, watermark, page number or decorative filler text. Short functional labels belonging to the diagram itself (arrow labels such as INHALE / EXHALE) are allowed.',
].join('\n');

function buildPrompt(slide) {
  return BRAND +
    '\n\nHEADLINE TEXT (exact): "' + String(slide.headline || '').trim() + '"' +
    '\n\nSUPPORTING TEXT (exact): "' + String(slide.sub || '').trim() + '"' +
    '\n\nILLUSTRATION SUBJECT: ' + String(slide.visual_prompt || '').trim();
}

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const strip = (h) => decode(h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (b, n) => { const m = b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i')); return m ? m[1] : ''; };

// "Fetch News Headlines" + "Build News Context": the top 3 items, title and snippet.
async function headlines(feedUrl) {
  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.slice(0, 3).map((b) => ({ title: strip(tag(b, 'title')), snippet: strip(tag(b, 'description')) }));
}

function parseJson(text) {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// "Normalize & Plan Slides", the author's logic (S3 fields left out).
function normalize(o, mode) {
  const nSlides = (o.slides || []).length;
  if (mode === 'SINGLE_IMAGE' || mode === 'CAROUSEL') o.post_type = mode;
  if (o.post_type !== 'SINGLE_IMAGE' && o.post_type !== 'CAROUSEL') o.post_type = nSlides > 1 ? 'CAROUSEL' : 'SINGLE_IMAGE';
  if (o.post_type === 'CAROUSEL' && nSlides < 2) {
    throw new Error('A carousel needs at least 2 slides but the AI returned ' + nSlides + '. Run again.');
  }
  const MAX_SLIDES = o.post_type === 'CAROUSEL' ? 4 : 1;
  const slides = (o.slides || []).slice(0, MAX_SLIDES).map((s, i) => ({
    headline: s.headline,
    sub: s.sub,
    body: s.body,
    visual_prompt: s.visual_prompt,
    slideIndex: i,
    image_prompt: buildPrompt(s),
  }));
  if (!slides.length) throw new Error('AI Agent returned no slides. Raw output: ' + JSON.stringify(o).slice(0, 800));
  const hashtags = (Array.isArray(o.hashtags) ? o.hashtags : [])
    .map((h) => String(h).trim())
    .filter(Boolean)
    .map((h) => (h.startsWith('#') ? h : '#' + h));
  const caption = [String(o.caption || '').trim(), hashtags.join(' ')].filter(Boolean).join('\n\n.\n.\n.\n');
  return { news_hook: o.news_hook, problem: o.problem, solution: o.solution, practice: o.practice, post_type: o.post_type, caption, hashtags, slides };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p = {};
  if (raw) {
    try { p = JSON.parse(raw); } catch { p = null; }
    if (!p || typeof p !== 'object' || Array.isArray(p)) p = { news_context: [{ title: raw, snippet: '' }] };
  }
  const day = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86400000);
  const idx = Number.isInteger(Number(p.topic_index)) && p.topic_index !== undefined && p.topic_index !== ''
    ? ((Number(p.topic_index) % trendFeeds.length) + trendFeeds.length) % trendFeeds.length
    : day % trendFeeds.length;
  const picked = { ...trendFeeds[idx] };
  for (const k of ['category', 'focus', 'topic', 'feed_url']) if (p[k]) picked[k] = String(p[k]);
  const mode = ['AUTO', 'SINGLE_IMAGE', 'CAROUSEL'].includes(p.post_type_mode) ? p.post_type_mode : 'AUTO';

  let news_context;
  try {
    news_context = Array.isArray(p.news_context) && p.news_context.length ? p.news_context : await headlines(picked.feed_url);
  } catch (e) {
    return JSON.stringify({ error: e.message, feed_url: picked.feed_url });
  }
  if (!news_context.length) return JSON.stringify({ error: 'The news feed returned no headlines.', feed_url: picked.feed_url });

  const ctx = { news_context, category: picked.category, focus: picked.focus, topic: picked.topic };
  const model = getModelClient(providerConfig);
  const ask = `${SYSTEM}\n\n${promptText(ctx, mode)}\n\nRespond with only one JSON object that matches this JSON Schema, no other text:\n${SCHEMA}`;

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const o = parseJson(await model.complete(ask));
    if (!o) { lastError = 'The model did not return JSON.'; continue; }
    try {
      return JSON.stringify({ date: new Date().toISOString().slice(0, 10), category: ctx.category, focus: ctx.focus, topic: ctx.topic, headlines: news_context, ...normalize(o, mode) });
    } catch (e) {
      lastError = e.message;
    }
  }
  return JSON.stringify({ error: lastError, headlines: news_context });
}
