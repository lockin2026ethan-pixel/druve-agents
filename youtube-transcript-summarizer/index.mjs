// YouTube Transcript Summarizer: a Druve agent ported by hand from the n8n
// template "Summarize YouTube Videos from Transcript" by Ahmed Alnaqa
// (https://n8n.io/workflows/2736). Draft for Ahmed to check. Nothing is
// published.
//
// What it keeps: the "Summarization of a YouTube script" step. In the template
// that node runs with default options, which is n8n's map-reduce summarization
// with LangChain's default prompt ("Write a concise summary of the
// following..."). The same prompt and the same map-then-combine method run
// here.
// One change: chunks are about 12,000 characters instead of the node's small
// default, so a long transcript takes a handful of model calls, not dozens.
// What it leaves out: the form and the Apify transcript request. A Druve agent
// cannot hold a buyer's Apify key, so the buyer pastes the transcript (YouTube:
// "...more" under the video, then "Show transcript").
//
// Input: the video transcript as text.
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// LangChain's default summarization prompt, used by n8n's Summarization Chain
// when no custom prompt is set.
const DEFAULT_PROMPT = 'Write a concise summary of the following:\n\n\n"{text}"\n\n\nCONCISE SUMMARY:';
const CHUNK = 12000;
const OVERLAP = 200;

function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length; i += CHUNK - OVERLAP) {
    out.push(text.slice(i, i + CHUNK));
    if (i + CHUNK >= text.length) break;
  }
  return out;
}

const summarize = (model, text) => model.complete(DEFAULT_PROMPT.split('{text}').join(text)).then((s) => String(s).trim());

export async function handleMessage(input, providerConfig) {
  const transcript = String(input || '')
    .replace(/^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/gm, '') // timestamp-only lines from YouTube's transcript panel
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (transcript.length < 200) {
    return 'Paste the video transcript (on YouTube: "...more" under the video, then "Show transcript", select all and copy).';
  }
  const model = getModelClient(providerConfig);
  const parts = chunks(transcript);
  if (parts.length === 1) return summarize(model, parts[0]);
  // map, then combine, as the map-reduce chain does
  const partials = await Promise.all(parts.map((p) => summarize(model, p)));
  return summarize(model, partials.join('\n\n'));
}
