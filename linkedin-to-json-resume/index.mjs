// LinkedIn Profile to JSON Resume: a Druve agent ported by hand from the n8n
// template "LinkedIn Profile Extract and Build JSON Resume with Bright Data &
// Google Gemini" by Ranjan Dailata (https://n8n.io/workflows/4653). Listed on Druve
// with the author's permission; all credit for the workflow and prompts to Ranjan.
//
// What it keeps, unchanged: the three AI steps and their prompts.
//   1. "Markdown to Textual Data Extractor" (system: "You are a markdown expert").
//   2. "Skill Extractor", with the author's schema (skill, desc).
//   3. "JSON Resume Extractor", with the author's full JSON Resume schema.
// Steps 2 and 3 run in parallel on the output of step 1, as in the template.
// n8n's Information Extractor node adds its own short system prompt and
// enforces the schema; here the same default text is sent and the schema is
// given in the prompt.
// Also kept: the "Perform Bright Data Web Request" step, with the same body
// (zone, url, format raw, data_format markdown). The buyer passes their own
// Bright Data token in the input; it is sent only to api.brightdata.com, in
// the Authorization header, and never to the model.
// What it leaves out: the disk writes and the webhook.
//
// Input, either JSON to scrape a profile through Bright Data:
//   {"url": "https://www.linkedin.com/in/...", "brightDataToken": "...", "zone": "web_unlocker1"}
// or the profile page / resume pasted as markdown or plain text.
//
// Data fetch target to declare: api.brightdata.com
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';


// Author's prompts, verbatim from the template.
const MD_SYSTEM = "You are a markdown expert";
const MD_TEXT = "You need to analyze the below markdown and convert to textual data. Please do not output with your own thoughts. Make sure to output with textual data only with no links, scripts, css etc.\n\n{{ $json.data }}";
const SKILL_TEXT = "Perform Data Mining and extract the skills from the provided resume\n\n {{ $json.text }}";
const SKILL_SCHEMA = "{\n\t\"type\": \"array\",\n\t\"properties\": {\n\t\t\"skill\": {\n\t\t\t\"type\": \"string\"\n\t\t},\n        \"desc\": {\n\t\t\t\"type\": \"string\"\n\t\t}\n\t}\n}";
const RESUME_TEXT = "Extract the resume in JSON format.\n {{ $json.text }}";
const RESUME_SCHEMA = "{\n  \"$schema\": \"http://json-schema.org/draft-07/schema#\",\n  \"title\": \"JSON Resume\",\n  \"type\": \"object\",\n  \"properties\": {\n    \"basics\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"name\": { \"type\": \"string\" },\n        \"label\": { \"type\": \"string\" },\n        \"image\": { \"type\": \"string\", \"format\": \"uri\" },\n        \"email\": { \"type\": \"string\", \"format\": \"email\" },\n        \"phone\": { \"type\": \"string\" },\n        \"url\": { \"type\": \"string\", \"format\": \"uri\" },\n        \"summary\": { \"type\": \"string\" },\n        \"location\": {\n          \"type\": \"object\",\n          \"properties\": {\n            \"address\": { \"type\": \"string\" },\n            \"postalCode\": { \"type\": \"string\" },\n            \"city\": { \"type\": \"string\" },\n            \"countryCode\": { \"type\": \"string\" },\n            \"region\": { \"type\": \"string\" }\n          }\n        },\n        \"profiles\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"type\": \"object\",\n            \"properties\": {\n              \"network\": { \"type\": \"string\" },\n              \"username\": { \"type\": \"string\" },\n              \"url\": { \"type\": \"string\", \"format\": \"uri\" }\n            }\n          }\n        }\n      }\n    },\n    \"work\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"name\": { \"type\": \"string\" },\n          \"position\": { \"type\": \"string\" },\n          \"url\": { \"type\": \"string\", \"format\": \"uri\" },\n          \"startDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"endDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"summary\": { \"type\": \"string\" },\n          \"highlights\": {\n            \"type\": \"array\",\n            \"items\": { \"type\": \"string\" }\n          }\n        }\n      }\n    },\n    \"volunteer\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"organization\": { \"type\": \"string\" },\n          \"position\": { \"type\": \"string\" },\n          \"url\": { \"type\": \"string\", \"format\": \"uri\" },\n          \"startDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"endDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"summary\": { \"type\": \"string\" },\n          \"highlights\": {\n            \"type\": \"array\",\n            \"items\": { \"type\": \"string\" }\n          }\n        }\n      }\n    },\n    \"education\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"institution\": { \"type\": \"string\" },\n          \"url\": { \"type\": \"string\", \"format\": \"uri\" },\n          \"area\": { \"type\": \"string\" },\n          \"studyType\": { \"type\": \"string\" },\n          \"startDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"endDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"score\": { \"type\": \"string\" },\n          \"courses\": {\n            \"type\": \"array\",\n            \"items\": { \"type\": \"string\" }\n          }\n        }\n      }\n    },\n    \"awards\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"title\": { \"type\": \"string\" },\n          \"date\": { \"type\": \"string\", \"format\": \"date\" },\n          \"awarder\": { \"type\": \"string\" },\n          \"summary\": { \"type\": \"string\" }\n        }\n      }\n    },\n    \"certificates\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"name\": { \"type\": \"string\" },\n          \"date\": { \"type\": \"string\", \"format\": \"date\" },\n          \"issuer\": { \"type\": \"string\" },\n          \"url\": { \"type\": \"string\", \"format\": \"uri\" }\n        }\n      }\n    },\n    \"publications\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"name\": { \"type\": \"string\" },\n          \"publisher\": { \"type\": \"string\" },\n          \"releaseDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"url\": { \"type\": \"string\", \"format\": \"uri\" },\n          \"summary\": { \"type\": \"string\" }\n        }\n      }\n    },\n    \"skills\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"name\": { \"type\": \"string\" },\n          \"level\": { \"type\": \"string\" },\n          \"keywords\": {\n            \"type\": \"array\",\n            \"items\": { \"type\": \"string\" }\n          }\n        }\n      }\n    },\n    \"languages\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"language\": { \"type\": \"string\" },\n          \"fluency\": { \"type\": \"string\" }\n        }\n      }\n    },\n    \"interests\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"name\": { \"type\": \"string\" },\n          \"keywords\": {\n            \"type\": \"array\",\n            \"items\": { \"type\": \"string\" }\n          }\n        }\n      }\n    },\n    \"references\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"name\": { \"type\": \"string\" },\n          \"reference\": { \"type\": \"string\" }\n        }\n      }\n    },\n    \"projects\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"name\": { \"type\": \"string\" },\n          \"startDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"endDate\": { \"type\": \"string\", \"format\": \"date\" },\n          \"description\": { \"type\": \"string\" },\n          \"highlights\": {\n            \"type\": \"array\",\n            \"items\": { \"type\": \"string\" }\n          },\n          \"url\": { \"type\": \"string\", \"format\": \"uri\" }\n        }\n      }\n    }\n  },\n  \"required\": [\"basics\"]\n}\n";

// n8n Information Extractor's default system prompt.
const EXTRACTOR_SYSTEM = "You are an expert extraction algorithm.\nOnly extract relevant information from the text.\nIf you do not know the value of an attribute asked to extract, you may omit the attribute's value.";

function parseJson(text) {
  const s = String(text);
  const a = s.search(/[\[{]/);
  if (a === -1) return null;
  const close = s[a] === '[' ? ']' : '}';
  const b = s.lastIndexOf(close);
  if (b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// Exact string replace, so the author's text is never touched by a regex.
const sub = (tpl, key, val) => tpl.split(key).join(val);

function extractorPrompt(text, schema, shape) {
  return `${EXTRACTOR_SYSTEM}\n\n${text}\n\nReturn only ${shape} that follows this JSON schema:\n${schema}`;
}

async function extract(model, prompt, ok) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const o = parseJson(await model.complete(prompt));
    if (o && ok(o)) return o;
  }
  return null;
}

// Perform Bright Data Web Request: the author's request body.
async function brightData(url, token, zone) {
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}` },
    body: JSON.stringify({ zone, url, format: 'raw', data_format: 'markdown' }),
  });
  if (!res.ok) throw new Error(`Bright Data returned ${res.status}. Check the token and zone.`);
  return res.text();
}

export async function handleMessage(input, providerConfig) {
  let raw = String(input || '').trim();
  let req = null;
  try { req = JSON.parse(raw); } catch {}
  if (req && typeof req === 'object' && req.url) {
    if (!req.brightDataToken) return 'To scrape the profile, add your Bright Data token: {"url": "...", "brightDataToken": "...", "zone": "web_unlocker1"}. Or paste the profile text instead.';
    try {
      raw = String(await brightData(String(req.url), String(req.brightDataToken), String(req.zone || 'web_unlocker1'))).trim();
    } catch (e) {
      return String(e.message || e);
    }
    if (!raw) return 'Bright Data returned an empty page. Check the URL and zone.';
  }
  if (!raw) return 'Send {"url": "<LinkedIn profile URL>", "brightDataToken": "...", "zone": "web_unlocker1"}, or paste a profile page or resume, and you get back a JSON Resume and a skills list.';
  const model = getModelClient(providerConfig);

  // Step 1: Markdown to Textual Data Extractor.
  const text = String(await model.complete(`${MD_SYSTEM}\n\n${sub(MD_TEXT, '{{ $json.data }}', raw)}`)).trim();

  // Steps 2 and 3 in parallel, as in the template.
  const [skills, resume] = await Promise.all([
    extract(model, extractorPrompt(sub(SKILL_TEXT, '{{ $json.text }}', text), SKILL_SCHEMA, 'a JSON array of objects with "skill" and "desc"'),
      (o) => Array.isArray(o) || Array.isArray(o.skills)),
    extract(model, extractorPrompt(sub(RESUME_TEXT, '{{ $json.text }}', text), RESUME_SCHEMA, 'one JSON object'),
      (o) => o && typeof o === 'object' && !Array.isArray(o) && o.basics),
  ]);

  const list = Array.isArray(skills) ? skills : (skills && skills.skills) || [];
  const parts = [];
  if (resume) {
    const name = (resume.basics && resume.basics.name) || 'Profile';
    parts.push(`## ${name}: JSON Resume`, '```json\n' + JSON.stringify(resume, null, 2) + '\n```');
  } else {
    parts.push('## JSON Resume\nThe model did not return a usable JSON Resume. Try again.');
  }
  parts.push(`## Skills\n${list.length ? list.map((s) => `- **${s.skill || s.name || ''}**${s.desc ? `: ${s.desc}` : ''}`).join('\n') : '- none returned'}`);
  return parts.join('\n\n');
}
