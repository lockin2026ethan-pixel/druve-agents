// Sora 2 UGC Video Prompt: a Druve agent ported by hand from the n8n template
// "Generate UGC Video Ads from Product Images with Kie.ai Sora 2 + Tavily
// Research" by Ezema Kingsley Chibuzo (https://n8n.io/workflows/10536). Draft
// for Kingsley to check. Nothing is published.
//
// What it keeps: the AI Agent's system prompt and its user message ("Here is
// the prompt: ..."), unchanged except for rule 1.
// What changes: rule 1 told the agent to call the Tavily tool. A Druve agent
// cannot hold a buyer's Tavily key, so rule 1 now uses research notes the
// buyer pastes (optional). The original rule 1 is kept below as RULE_1_ORIGINAL.
// What it leaves out: Google Sheets, the Kie.ai Sora 2 call, the wait loop and
// the status switch. The buyer pastes the prompt into Sora 2 with their image.
// The prompt is also given as one line, the way the template sends it to Kie.ai.
//
// Input, either JSON:
//   {"prompt": "...", "productName": "...", "imageLink": "...", "research": "..."}
// or plain text with labels (only PROMPT is required):
//   PRODUCT NAME: GlowUp vitamin C serum
//   PROMPT: UGC style, woman applies serum in a bright bathroom
//   IMAGE LINK: https://...
//   RESEARCH: (optional notes on trends for this product)
// or plain text with no labels, read as the prompt.
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// Author's system prompt, verbatim except rule 1 (see above).
const SYSTEM = "You are an expert AI video prompt engineer trained to design optimized prompts for Sora 2 video generation on Kie.ai.\nYour role is to take a raw product concept, a short idea, and an image link and transform them into a highly detailed, realistic, and visually rich video prompt that aligns with modern marketing standards.\n\n\n🎯 Objective\nGenerate a prompt that helps Sora 2 produce a realistic, natural-looking short video matching the intent of the product or service.\nThe result should look like it was filmed by a real person or a professional ad team — depending on the desired style.\n\n\n🧩 Your Rules\n1. If research notes on the product or its category are provided below, use them to make the video prompt reflect current, effective styles in video advertising, avoiding outdated approaches.\n2. Understand the product — analyze what it is, who it’s for, and its emotional appeal (use any research insight provided).\n3. Always describe:\n- Main subject(s): appearance, clothing, expression, action.\n- Setting: location, lighting, time of day, atmosphere.\n- Camera style: framing, motion, handheld vs cinematic, lens type, realism.\n- Tone: emotional mood (friendly, elegant, cinematic, testimonial, etc.).\n- Lighting: realistic natural or studio lighting, with mood consistency.\n4. If the user specifies “UGC” or “influencer-style”, simulate a smartphone or handheld camera perspective, vertical 9:16 format, and a natural, authentic tone.\n5. If no style is specified, default to a cinematic ad style that looks visually stunning and brand-ready.\n6. Avoid repetition, keep every sentence meaningful, and ensure the description reads like a cinematographer describing the shot to a director.";
const RULE_1_ORIGINAL = "1. Before generating the video prompt, always use the Tavily tool to search for the latest trends, product type, related products or categories, and current market insights of the product or product category. Use this information to ensure the video prompt reflects the most current and effective styles in video advertising, avoiding outdated approaches.";
// Author's user message, verbatim.
const TEXT = "Here is the prompt: {{ $json.Prompt }}";

const sub = (tpl, key, val) => tpl.split(key).join(val);

function readInput(input) {
  const raw = String(input || '').trim();
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') {
      return { prompt: String(p.prompt || p.Prompt || '').trim(), product: String(p.productName || p['Product Name'] || '').trim(), image: String(p.imageLink || p['Image Link'] || '').trim(), research: String(p.research || '').trim() };
    }
  } catch {}
  const labels = 'PRODUCT NAME|PROMPT|IMAGE LINK|RESEARCH';
  const grab = (label) => {
    const m = raw.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${labels})\\s*:|$)`, 'i'));
    return m ? m[1].trim() : '';
  };
  const v = { prompt: grab('PROMPT'), product: grab('PRODUCT NAME'), image: grab('IMAGE LINK'), research: grab('RESEARCH') };
  if (!v.prompt && !v.product && !v.image && !v.research) v.prompt = raw;
  return v;
}

export async function handleMessage(input, providerConfig) {
  const v = readInput(input);
  if (!v.prompt) {
    return 'Send your idea for the video, for example:\nPRODUCT NAME: GlowUp vitamin C serum\nPROMPT: UGC style, woman applies serum in a bright bathroom\nIMAGE LINK: (optional)\nRESEARCH: (optional notes on current trends)';
  }
  const model = getModelClient(providerConfig);
  const extra = [
    v.product && `Product name: ${v.product}`,
    v.image && `Image link: ${v.image}`,
    v.research && `Research notes:\n${v.research}`,
  ].filter(Boolean).join('\n');
  const user = sub(TEXT, '{{ $json.Prompt }}', v.prompt) + (extra ? `\n\n${extra}` : '');
  const out = String(await model.complete(`${SYSTEM}\n\n---\n\n${user}`)).trim();
  if (!out) return 'The model did not return a prompt. Try again.';
  // Same clean-up the template applies before sending to Kie.ai.
  const oneLine = out.replace(/\r?\n|\r/g, ' ');
  return [
    `## Sora 2 video prompt${v.product ? `: ${v.product}` : ''}`,
    out,
    `**One line, ready to paste into Sora 2${v.image ? ' with your image' : ''}:**`,
    '```text\n' + oneLine + '\n```',
  ].join('\n\n');
}
