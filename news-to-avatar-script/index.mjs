// News to Avatar Video Script: a Druve agent built for David Olusola from the
// public outline of his n8n template "Convert RSS news to AI avatar videos with
// Heygen & GPT-4o" (https://n8n.io/workflows/4288). Draft for David to check.
// Nothing is published.
//
// The template is paid, so its prompt is not public. The prompt below was
// written by Druve to match the template's description (a 30 to 60 second
// script from a news item, read by a HeyGen avatar). Send your n8n export and
// your own prompt replaces it word for word.
//
// What it keeps: the AI step. A news item goes in; a spoken script, a video
// title and a social caption come out, ready to paste into HeyGen.
// What it leaves out: the RSS fetch, the Google Sheets logs, the HeyGen API
// calls and the Drive upload. A Druve agent can only reach hosts declared in
// advance and never holds a buyer's HeyGen key, so the buyer pastes the script
// into HeyGen themselves.
//
// Input, either JSON:
//   {"title": "...", "content": "...", "link": "...", "seconds": 45}
// or plain text: the headline on the first line, the article below it.
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

const MAX_CHARS = 20000;
const WORDS_PER_SECOND = 2.5; // about 150 spoken words a minute

function stripHtml(s) {
  return String(s || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

function readInput(input) {
  const raw = String(input || '').trim();
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') {
      return {
        title: String(p.title || p.headline || '').trim(),
        content: stripHtml(p.content || p.contentSnippet || p.description || p.article || ''),
        link: String(p.link || p.url || '').trim(),
        seconds: Number(p.seconds) || 45,
      };
    }
  } catch {}
  const [first, ...rest] = raw.split('\n');
  return { title: (first || '').trim(), content: stripHtml(rest.join('\n')), link: '', seconds: 45 };
}

function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function prompt(v, seconds, words) {
  return `You write scripts for short news videos read aloud by an AI avatar.

Write a script for a video of about ${seconds} seconds, based only on the news item below. At a natural speaking pace that is about ${words} words.

Rules:
- Open with one sentence that tells the viewer what happened.
- Then give the two or three facts that matter most, in plain spoken English.
- Close with one sentence on why it matters or what happens next, only if the news item says.
- Use only facts that are in the news item. Do not add numbers, names, quotes or dates that are not there.
- Write it to be spoken: short sentences, no headings, no bullet points, no emojis, no hashtags, no stage directions.
- If a source is given, mention it once.

Also write:
- videoTitle: a plain title for the video, under 70 characters.
- caption: a social media caption of one or two sentences, then 3 to 5 relevant hashtags.

Return only a JSON object with the keys "videoTitle", "script" and "caption".

News item
Title: ${v.title}
Source: ${v.link || '(none given)'}
Article:
${v.content.slice(0, MAX_CHARS)}`;
}

export async function handleMessage(input, providerConfig) {
  const v = readInput(input);
  if (!v.title && !v.content) {
    return 'Paste a news item: the headline on the first line and the article below it. Or JSON like {"title": "...", "content": "...", "link": "...", "seconds": 45}.';
  }
  if (!v.content) v.content = v.title;
  const seconds = Math.min(60, Math.max(30, Math.round(v.seconds)));
  const words = Math.round(seconds * WORDS_PER_SECOND);
  const model = getModelClient(providerConfig);

  let out = null;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const o = parseJson(await model.complete(prompt(v, seconds, words)));
    if (o && typeof o.script === 'string' && o.script.trim()) out = o;
  }
  if (!out) return 'The model did not return a usable script. Try again.';

  const script = out.script.trim();
  const count = script.split(/\s+/).filter(Boolean).length;
  const estimate = Math.round(count / WORDS_PER_SECOND);

  return [
    `## ${String(out.videoTitle || v.title).trim()}`,
    `About ${estimate} seconds spoken (${count} words). Paste the script into HeyGen as the avatar's text.`,
    '```text\n' + script + '\n```',
    `**Caption**\n${String(out.caption || '').trim() || '(none returned)'}`,
  ].join('\n\n');
}
