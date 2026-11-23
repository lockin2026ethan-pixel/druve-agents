// Lyrics to SRT + LRC: a Druve agent built for Václav Čikl from his n8n
// template "Create .SRT subtitles & .LRC lyrics from audio with Whisper AI and
// GPT-5-nano" (https://n8n.io/workflows/9589). Draft for Václav to check.
// Nothing is published.
//
// The template is paid, so its nodes are not public. What is public, and kept
// word for word: the segmentation system prompt quoted in the template's
// description ("You are helping with preparing song lyrics for musicians...").
// The timestamp matching and the .SRT/.LRC formatting below were written by
// Druve to do what the description says; send your export and your own
// TimestampMatching / SubtitlesPreparation code replaces them.
//
// What changes: Druve agents work in text, so the agent does not call Whisper.
// The buyer runs Whisper (OpenAI /v1/audio/transcriptions with
// response_format=verbose_json and timestamp_granularities[]=word) and pastes
// the JSON. The agent segments it into lyric lines, matches each line back to
// the word timestamps, and returns both files.
// The manual quality-check loop: send {"words": [...], "lines": "edited lyrics,
// one line per row"} and the edited lines are re-aligned to the timestamps.
//
// Input: Whisper verbose_json with a "words" array, or the same object with an
// extra "lines" field holding edited lyric lines.
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// From the template's public description, verbatim.
const SEGMENT_SYSTEM = 'You are helping with preparing song lyrics for musicians. Take the following transcription and split it into lyric-like lines. Keep lines short (2–8 words), natural for singing/rap phrasing, and do not change the wording.';

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
const tokens = (s) => norm(s).split(/\s+/).filter(Boolean);

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const close = (a, b) => a === b || lev(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 4));

// Walk the lines in order and match each token to the next Whisper word,
// tolerating small edits (Levenshtein) and skipped or extra words.
function align(lines, words) {
  const w = words.map((x) => ({ t: norm(x.word), start: Number(x.start), end: Number(x.end) })).filter((x) => x.t);
  let p = 0;
  const out = [];
  for (const line of lines) {
    const toks = tokens(line);
    let first = null, last = null;
    for (const tok of toks) {
      let hit = -1;
      for (let k = p; k < Math.min(w.length, p + 6); k++) if (close(tok, w[k].t)) { hit = k; break; }
      if (hit === -1) continue;
      if (first === null) first = hit;
      last = hit;
      p = hit + 1;
    }
    if (first === null) {
      // nothing matched: place it right after the previous line
      const prevEnd = out.length ? out[out.length - 1].end : 0;
      out.push({ text: line, start: prevEnd, end: prevEnd + 2, matched: false });
      continue;
    }
    out.push({ text: line, start: w[first].start, end: w[last].end, matched: true });
  }
  return out;
}

const pad = (n, l = 2) => String(Math.floor(n)).padStart(l, '0');
function srtTime(s) {
  const ms = Math.round(s * 1000);
  return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
function lrcTime(s) {
  const cs = Math.round(s * 100);
  return `${pad(cs / 6000)}:${pad((cs / 100) % 60)}.${pad(cs % 100)}`;
}
const toSrt = (rows) => rows.map((r, i) => `${i + 1}\n${srtTime(r.start)} --> ${srtTime(Math.max(r.end, r.start + 0.5))}\n${r.text}\n`).join('\n');
const toLrc = (rows) => rows.map((r) => `[${lrcTime(r.start)}]${r.text}`).join('\n');

export async function handleMessage(input, providerConfig) {
  let data = null;
  try { data = JSON.parse(String(input || '')); } catch {}
  if (!data || !Array.isArray(data.words) || !data.words.length) {
    return 'Paste Whisper\'s verbose JSON with word timestamps (OpenAI /v1/audio/transcriptions, response_format=verbose_json, timestamp_granularities[]=word). To re-align edited lyrics, add "lines": "one lyric line per row".';
  }
  const transcript = String(data.text || data.words.map((x) => x.word).join(' ')).trim();

  let lines;
  if (typeof data.lines === 'string' && data.lines.trim()) {
    lines = data.lines.split('\n').map((s) => s.trim()).filter(Boolean);
  } else {
    const model = getModelClient(providerConfig);
    const out = await model.complete(`${SEGMENT_SYSTEM}\n\nReturn only the lyric lines, one per line, with nothing else.\n\nTranscription:\n${transcript}`);
    lines = String(out).split('\n').map((s) => s.replace(/^\s*[-*\d.)]+\s+/, '').trim()).filter(Boolean);
  }
  if (!lines.length) return 'The model did not return any lyric lines. Try again.';

  const rows = align(lines, data.words);
  const unmatched = rows.filter((r) => !r.matched).length;
  return [
    `## ${rows.length} lines${unmatched ? ` (${unmatched} could not be matched to timestamps and were placed after the previous line)` : ''}`,
    '**lyrics.srt**',
    '```srt\n' + toSrt(rows) + '```',
    '**lyrics.lrc**',
    '```text\n' + toLrc(rows) + '\n```',
    'To fix wording, edit the lines and send them back as "lines" with the same JSON; timestamps are re-matched.',
  ].join('\n\n');
}
