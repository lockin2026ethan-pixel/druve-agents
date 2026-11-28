// UX Feedback Tagger: a Druve agent ported by hand from the n8n template
// "AI automate UX feedback: Sentiment & emotion analysis in Google Sheets +
// OpenAI" by parhumm (https://n8n.io/workflows/9881).
// Draft for the author to check. Listed on Druve only by the author, under their own name.
//
// What it keeps, unchanged: the "Tag Feedbacks with AI" system prompt word for
// word, the user message ({"allowed_tags": [...], "feedbacks": [{id, row_number,
// text}]}), batches of 10, "Split Batch Results" (array or {results}), and the
// "Update Google Sheet (Tagged)" columns: Tag 1-3, AI Tag 1-2, Sentiment,
// Primary Emotion, Secondary Emotion, Status ("Updated" when allowed tags were
// used, "Needs Review" otherwise) and "Updated Date (N8N)". Like the template,
// it reads allowed tags from the "Tags" tab (column "Tags") and feedback rows
// from the "Feedbacks" tab (column "Feedbacks") whose Status is empty.
// What changes: no schedule. The buyer runs it when they want (or on their own
// schedule with the Druve CLI), or pastes feedback without Google Sheets.
//
// Input (JSON), one of:
//   {"feedbacks": ["App crashes on login", "Love the new design"], "allowed_tags": ["Bug", "Design"]}
//   {"google_access_token": "...", "sheet": "https://docs.google.com/spreadsheets/d/<id>/edit", "max_rows": 100}
// Plain text input is treated as one feedback per line.
//
// Data-fetch host to declare when publishing:
//   sheets.googleapis.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "Tag Feedbacks with AI" system prompt, verbatim.
const SYSTEM = "You are a tagging, sentiment, and emotion analysis assistant.  \n\nInput format:\n- You will receive multiple feedbacks in an array under `feedbacks`.\n- Each feedback item has: `row_number` and `text`.\n- Feedback text may be multilingual (e.g., Persian/Farsi). Analyze natively.\n- You will also receive an `allowed_tags` array (may be empty).\n\nGeneral rules:\n- Analyze each feedback independently.\n- Detect and describe emotional tone naturally.\n- Identify one **primary emotion** that captures the dominant feeling.\n- Optionally include up to two **secondary emotions** that reflect additional nuances.\n- Output must be a **valid JSON array** only, with **no extra text** before or after.\n- Maintain the original input order.\n\n⚠️ CRITICAL TAGGING RULES (2-tier system with STRONG preference for allowed_tags):\n\n**TIER 1: ALWAYS TRY ALLOWED TAGS FIRST (Your Primary Responsibility)**\n- If `allowed_tags` is provided, you MUST thoroughly examine it for matches.\n- **Be creative and flexible in matching:**\n  - Look for direct matches (e.g., \"Bug\" for bug reports)\n  - Look for semantic matches (e.g., \"Payment\" tag for \"billing issue\" feedback)\n  - Look for category matches (e.g., \"Performance\" for \"slow\", \"lag\", \"loading\")\n  - Look for broader themes (e.g., \"User Experience\" for usability complaints)\n- **Think broadly:** A tag doesn't need to be a perfect word-for-word match.\n- Consider the **intent and topic** of the feedback, not just exact keywords.\n- Return up to **3** most relevant tags from `allowed_tags` (sorted by relevance).\n- **Only proceed to Tier 2 if you genuinely cannot find ANY relevant match** after careful analysis.\n\n**TIER 2: AI-Generated Tags (ONLY as a last resort)**\n- Use this ONLY when:\n  - `allowed_tags` is completely empty, OR\n  - After thorough analysis, absolutely NO tag in `allowed_tags` relates to the feedback topic\n- Generate up to **2 custom, descriptive tags** (short labels like \"UI Bug\", \"Pricing Question\").\n- Put these in `ai_tag_1` and `ai_tag_2`.\n- Use \"\" for empty AI tag fields.\n\n**Decision Flow:**\n1. Read the feedback carefully\n2. Review ALL allowed_tags thoroughly\n3. Can you match any tag semantically or thematically? → YES = Use allowed tags, set ai_tag_1=\"\", ai_tag_2=\"\"\n4. Still no match after careful review? → Use AI tags as fallback\n\nSentiment scale (choose one):\n[\"Very Negative\", \"Negative\", \"Neutral\", \"Positive\", \"Very Positive\"].\n\nEmotions:\n- primary_emotion: one clear emotional label (e.g., \"anger\", \"hope\", \"disappointment\", \"relief\", \"satisfaction\", \"gratitude\").\n- secondary_emotion: optional supporting emotional state (e.g., \"frustration\", \"trust\", \"curiosity\", \"anxiety\"). Use \"\" if none applies.\n\nResponse JSON schema (use exactly these keys):\n[\n  {\n    \"row_number\": <row_number from input>,\n    \"tags\": [\"tag_from_allowed_list_1\", \"tag_from_allowed_list_2\"],\n    \"ai_tag_1\": \"\",\n    \"ai_tag_2\": \"\",\n    \"sentiment\": \"Positive\",\n    \"primary_emotion\": \"Gratitude\",\n    \"secondary_emotion\": \"Relief\"\n  }\n]\n\nExamples of GOOD matching behavior:\n✅ Feedback: \"The app crashes constantly\" + allowed_tags: [\"Bug\", \"Stability\", \"Feature\"] → tags: [\"Bug\", \"Stability\"]\n✅ Feedback: \"Can't complete checkout\" + allowed_tags: [\"Payment\", \"Technical Issue\", \"UI\"] → tags: [\"Payment\", \"Technical Issue\"]\n✅ Feedback: \"Love the new design!\" + allowed_tags: [\"Design\", \"Positive Feedback\", \"UI\"] → tags: [\"Design\", \"Positive Feedback\"]\n✅ Feedback: \"Too expensive for what it offers\" + allowed_tags: [\"Pricing\", \"Value\", \"Feature Request\"] → tags: [\"Pricing\", \"Value\"]\n\nExamples of when to use AI tags:\n❌ Feedback: \"Bug in login\" + allowed_tags: [] → tags: [], ai_tag_1: \"Authentication Bug\", ai_tag_2: \"Login\"\n❌ Feedback: \"Need dark mode\" + allowed_tags: [\"Pricing\", \"Support\", \"Payment\"] → tags: [], ai_tag_1: \"Feature Request\", ai_tag_2: \"UI Customization\"\n\nConstraints:\n- **STRONGLY PREFER allowed_tags** - exhaust all matching possibilities first\n- Do **not** invent tags in the `tags` array — only use exact names from `allowed_tags`\n- Generate creative tags for `ai_tag_1` and `ai_tag_2` ONLY when truly necessary\n- Use ASCII keys exactly as shown. Values must be strings or arrays of strings\n- Do not include reasoning, markdown, or comments — **JSON array only**";

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
async function sheets(token, path, init = {}) {
  const res = await fetch(`${SHEETS}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Google Sheets HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const sheetId = (s) => (String(s).match(/\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || String(s);

// "Split Batch Results", the author's logic (with the JSON cut out of any extra text).
function splitResults(content) {
  const s = String(content).trim();
  let response;
  try { response = JSON.parse(s); } catch {
    const a = s.search(/[\[{]/);
    const b = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    response = JSON.parse(s.slice(a, b + 1));
  }
  const results = Array.isArray(response) ? response : response.results || [];
  return results.map((result) => ({
    row_number: result.row_number,
    tags: result.tags || [],
    sentiment: result.sentiment || '',
    ai_tag_1: result.ai_tag_1 || '',
    ai_tag_2: result.ai_tag_2 || '',
    primary_emotion: result.primary_emotion || '',
    secondary_emotion: result.secondary_emotion || '',
  }));
}

// "Update Google Sheet (Tagged)" column values.
const columns = (r) => ({
  'Tag 1': r.tags[0] || '', 'Tag 2': r.tags[1] || '', 'Tag 3': r.tags[2] || '',
  Status: r.tags && r.tags.length > 0 ? 'Updated' : 'Needs Review',
  'AI Tag 1': r.ai_tag_1, 'AI Tag 2': r.ai_tag_2, Sentiment: r.sentiment,
  'Primary Emotion': r.primary_emotion, 'Secondary Emotion': Array.isArray(r.secondary_emotion) ? r.secondary_emotion.join(', ') : r.secondary_emotion,
  'Updated Date (N8N)': new Date().toISOString().split('T')[0],
});

async function tagAll(model, items, tags) {
  const out = [];
  for (let i = 0; i < items.length; i += 10) {
    const feedbackBatch = items.slice(i, i + 10).map((it, index) => ({ id: index, row_number: it.row_number, text: it.text }));
    const user = JSON.stringify({ allowed_tags: tags, feedbacks: feedbackBatch });
    let results;
    for (let attempt = 0; attempt < 2 && !results; attempt++) {
      try { results = splitResults(await model.complete(`${SYSTEM}\n\n${user}`)); } catch { results = undefined; }
    }
    if (!results) throw new Error(`The model did not return valid JSON for rows ${feedbackBatch.map((f) => f.row_number).join(', ')}.`);
    out.push(...results);
  }
  return out;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { feedbacks: raw.split('\n').map((s) => s.trim()).filter(Boolean) };
  const model = getModelClient(providerConfig);

  try {
    if (p.google_access_token && p.sheet) {
      const token = p.google_access_token;
      const id = sheetId(p.sheet);
      const tagRows = (await sheets(token, `${encodeURIComponent(id)}/values/Tags`)).values || [];
      const tagCol = Math.max(0, (tagRows[0] || []).indexOf('Tags'));
      const tags = tagRows.slice(1).map((r) => r[tagCol]).filter(Boolean);
      const values = (await sheets(token, `${encodeURIComponent(id)}/values/Feedbacks`)).values || [];
      const header = values[0] || [];
      const fbCol = header.indexOf('Feedbacks');
      const stCol = header.indexOf('Status');
      if (fbCol < 0) return JSON.stringify({ error: 'The "Feedbacks" tab needs a "Feedbacks" column.' });
      const max = Math.max(1, Math.min(500, Number(p.max_rows) || 100));
      const items = values
        .map((r, i) => ({ row_number: i + 1, text: r[fbCol] || '', status: stCol >= 0 ? r[stCol] || '' : '' }))
        .filter((it, i) => i > 0 && it.text && !it.status)
        .slice(0, max);
      if (!items.length) return JSON.stringify({ tags: tags.length, rows_tagged: 0, note: 'No feedback rows with an empty Status.' });
      const results = await tagAll(model, items, tags);
      // Write each row's columns that exist in the header.
      const data = [];
      for (const r of results) {
        const row = Number(r.row_number);
        if (!items.some((it) => it.row_number === row)) continue;
        for (const [name, value] of Object.entries(columns(r))) {
          const c = header.indexOf(name);
          if (c >= 0) data.push({ range: `Feedbacks!${colLetter(c)}${row}`, values: [[value]] });
        }
      }
      if (data.length) await sheets(token, `${encodeURIComponent(id)}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
      return JSON.stringify({ tags: tags.length, rows_tagged: results.length, cells_written: data.length, results: results.map((r) => ({ row_number: r.row_number, ...columns(r) })) });
    }

    const list = (Array.isArray(p.feedbacks) ? p.feedbacks : []).map(String).filter((t) => t.trim());
    if (!list.length) return JSON.stringify({ error: 'Send {"feedbacks": [...], "allowed_tags": [...]} or {"google_access_token": "...", "sheet": "..."}. See the header of this file.' });
    const items = list.map((text, i) => ({ row_number: i + 1, text }));
    const results = await tagAll(model, items, Array.isArray(p.allowed_tags) ? p.allowed_tags : []);
    return JSON.stringify({ results: results.map((r) => ({ row_number: r.row_number, feedback: list[Number(r.row_number) - 1], ...columns(r) })) });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
