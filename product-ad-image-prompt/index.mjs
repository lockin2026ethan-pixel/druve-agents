// Product Ad Image Prompt: a Druve agent built for Roshan Ramani from the
// public outline of his n8n template "Nano banana AI product image creator via
// WhatsApp" (https://n8n.io/workflows/8549). Draft for Roshan to check.
// Nothing is published.
//
// The template is paid, so its prompt is not public. The prompt below was
// written by Druve to match the template's "AI Design Analysis" step as its
// description explains it: turn a simple request ("make this look premium for
// Instagram") into a professional image prompt that keeps the product exactly
// the same. Send your n8n export and your own prompt replaces it word for word.
//
// What it keeps: the prompt-enhancement step.
// What it leaves out: WhatsApp, the image download and the image generation
// call. Druve agents work in text, so the buyer attaches their product photo in
// Gemini (Nano Banana) and pastes the prompt this agent writes.
//
// Input, either JSON:
//   {"product": "...", "request": "...", "platform": "instagram"}
// or plain text with labels:
//   PRODUCT: amber glass serum bottle, gold cap, white label "Glow 20"
//   REQUEST: make this look premium for Instagram
// or plain text with no labels, read as the request.
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

function readInput(input) {
  const raw = String(input || '').trim();
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') {
      return {
        product: String(p.product || '').trim(),
        request: String(p.request || p.caption || p.text || '').trim(),
        platform: String(p.platform || '').trim(),
      };
    }
  } catch {}
  const grab = (label, next) => {
    const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${next})\\s*:|$)`, 'i');
    const m = raw.match(re);
    return m ? m[1].trim() : '';
  };
  const product = grab('PRODUCT', 'REQUEST|CAPTION|PLATFORM');
  const request = grab('(?:REQUEST|CAPTION)', 'PRODUCT|PLATFORM');
  const platform = grab('PLATFORM', 'PRODUCT|REQUEST|CAPTION');
  if (!product && !request) return { product: '', request: raw, platform: '' };
  return { product, request, platform };
}

function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function prompt(v) {
  return `You are an art director who writes prompts for an image model that edits a product photo (Google's Gemini image model, known as Nano Banana).

The user will attach their own product photo to the image model together with your prompt. Turn their request into one detailed prompt for a premium marketing image.

Rules:
- The product must stay exactly as it is in the photo: same shape, colours, label, logo, printed text and proportions. Say this plainly in the prompt.
- Describe the new scene around it: background, surface, props, lighting, camera angle, lens, depth of field, mood and colour palette.
- Match the platform. Instagram feed: 4:5 or 1:1. Stories and reels: 9:16. Facebook ads: 1:1 or 4:5. Online store: 1:1 on a clean background. If no platform is given, choose from the request.
- If the request asks for words on the image, give the exact words in quotes and where they go. Otherwise ask for no added text.
- Do not invent claims, prices, discounts or certifications.
- Write the prompt in English as one paragraph of 80 to 160 words.

Return only a JSON object with the keys "prompt", "aspectRatio" (for example "4:5") and "style" (three to six words naming the look).

Product: ${v.product || '(not described; refer to it as "the product in the photo")'}
Platform: ${v.platform || '(not given)'}
Request: ${v.request || 'make this look premium'}`;
}

export async function handleMessage(input, providerConfig) {
  const v = readInput(input);
  if (!v.product && !v.request) {
    return 'Describe your product and what you want, for example:\nPRODUCT: amber glass serum bottle, gold cap\nREQUEST: make this look premium for Instagram';
  }
  const model = getModelClient(providerConfig);

  let out = null;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const o = parseJson(await model.complete(prompt(v)));
    if (o && typeof o.prompt === 'string' && o.prompt.trim()) out = o;
  }
  if (!out) return 'The model did not return a usable prompt. Try again.';

  return [
    `## Your image prompt${out.style ? `: ${String(out.style).trim()}` : ''}`,
    `Open Gemini (or any Nano Banana tool), attach your product photo, set the aspect ratio to ${out.aspectRatio || '1:1'}, and paste this:`,
    '```text\n' + out.prompt.trim() + '\n```',
  ].join('\n\n');
}
