// CV Screener: a Druve agent built for Aayushman Sharma from the public
// outline of his n8n template "Save time hiring with AI: automate screening,
// assessments & interviews" (https://n8n.io/workflows/4813). Draft for
// Aayushman to check. Nothing is published.
//
// The template is paid, so its prompts are not public. The prompts below were
// written by Druve to follow the template's AI steps as its description lists
// them. Send your n8n export and your own prompts replace them word for word.
//
// What it keeps, in the same order as the template:
//   1. Applicant's Details: city, education, job history, skills.
//   2. Summarize Applicant's Profile (about 100 words).
//   3. Summarize Job Role Description.
//   4. Semantic Fit & Evaluation by HR Expert: fit 0 to 100%, key matches,
//      skill gaps, soft skills, red flags, final score 1 to 10 with rationale.
//   5. The shortlist or rejection email, as a draft instead of being sent.
// What it leaves out: the form, Google Drive, Google Sheets, the TA approval
// email, the assessment, Typeform, Calendly and Slack steps. The buyer pastes a
// job description and a CV as text and gets the evaluation back.
//
// One addition, which you can remove: the evaluation is told to ignore
// protected characteristics and to treat a career gap as a question rather
// than a mark against the candidate. Hiring tools are judged on this, and the
// result is framed as a recommendation for a person to review.
//
// Input, either JSON:
//   {"jobDescription": "...", "cv": "..."}
// or plain text with two labelled sections:
//   JOB DESCRIPTION:
//   ...
//   CV:
//   ...
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

const MAX_CHARS = 30000;

function readInput(input) {
  const raw = String(input || '').trim();
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') {
      return {
        jd: String(p.jobDescription || p.jd || p.job || '').trim(),
        cv: String(p.cv || p.resume || p.CV || '').trim(),
      };
    }
  } catch {}
  // Only distinctive labels: a CV often has its own "Role:" or "Job:" lines.
  const jdLabel = '(?:JOB DESCRIPTION|JD)';
  const cvLabel = '(?:CV|RESUME|RÉSUMÉ)';
  const grab = (label, next) => {
    const re = new RegExp(`(?:^|\\n)#*\\s*${label}\\s*:\\s*([\\s\\S]*?)(?=\\n#*\\s*${next}\\s*:|$)`, 'i');
    const m = raw.match(re);
    return m ? m[1].trim() : '';
  };
  return { jd: grab(jdLabel, cvLabel), cv: grab(cvLabel, jdLabel) };
}

function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

async function json(model, prompt, ok) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const o = parseJson(await model.complete(prompt));
    if (o && ok(o)) return o;
  }
  return null;
}

const list = (a) => (Array.isArray(a) && a.length ? a.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '- none');

export async function handleMessage(input, providerConfig) {
  const v = readInput(input);
  if (!v.jd || !v.cv) {
    return 'Send two labelled sections:\nJOB DESCRIPTION:\n(the job description)\nCV:\n(the candidate\'s CV as text)\n\nOr JSON like {"jobDescription": "...", "cv": "..."}.';
  }
  const cv = v.cv.slice(0, MAX_CHARS);
  const jd = v.jd.slice(0, MAX_CHARS);
  const model = getModelClient(providerConfig);

  // Steps 1 to 3 run in parallel, as in the template.
  const [details, profile, role] = await Promise.all([
    json(model, `Extract the applicant's details from the CV below. Use only what the CV says. Leave a field empty if the CV does not say it.

Return only a JSON object with the keys:
"name" (string), "city" (string), "education" (array of strings, one per degree or course, with the school and year if given), "jobHistory" (array of objects with "title", "company", "from", "to"), "skills" (array of strings).

CV:
${cv}`, (o) => typeof o === 'object'),
    model.complete(`Summarize this candidate's profile in about 100 words: current role, years of experience, main skills, notable achievements and education. Use only what the CV says.

CV:
${cv}`),
    model.complete(`Summarize this job description in under 120 words: the role, seniority, must-have skills and experience, nice-to-have skills, and location or work arrangement if given.

Job description:
${jd}`),
  ]);

  // Step 4: the evaluation.
  const evaluation = await json(model, `You are an experienced HR expert screening a candidate for a role. Compare the candidate with the job and give an honest, evidence-based evaluation.

Rules:
- Judge only job-related evidence: skills, experience, results, education and certifications the job asks for.
- Do not consider or guess age, gender, race, ethnicity, nationality, religion, disability, marital or family status, or appearance.
- A gap in employment is not a red flag on its own. List it under redFlags only as a question to ask, and do not lower the score for it.
- Red flags are job-related concerns to check: missing information the job requires, very short tenures in a row, dates or titles that do not add up.
- If the CV does not show something, say it is not shown. Do not assume.

Return only a JSON object with the keys:
"fitPercent" (number 0 to 100, semantic fit with the job),
"keyMatches" (array of strings),
"gaps" (array of strings, skills or experience the job needs that the CV does not show),
"softSkills" (array of strings, only those the CV gives evidence for),
"redFlags" (array of strings),
"score" (number 1 to 10),
"rationale" (two or three sentences),
"recommendation" ("shortlist", "review" or "reject").

Job summary:
${role}

Full job description:
${jd}

Candidate profile:
${profile}

Candidate details:
${JSON.stringify(details || {})}`, (o) => typeof o.score !== 'undefined' && typeof o.recommendation === 'string');

  if (!evaluation) return 'The model did not return a usable evaluation. Try again.';

  const name = (details && details.name) || 'the candidate';
  const rec = String(evaluation.recommendation).toLowerCase();

  // Step 5: the email the template would send, as a draft.
  let email = '';
  if (rec === 'shortlist' || rec === 'reject') {
    email = await model.complete(rec === 'shortlist'
      ? `Write a short, warm email to ${name} saying their application has been shortlisted and inviting them to book an interview. Put the booking link as [scheduling link]. Mention the role from this job summary. No more than 120 words. Plain text, with a subject line first.

Job summary:
${role}`
      : `Write a short, respectful email to ${name} saying they have not been selected for this role this time. Thank them, do not give scoring details, and wish them well. No more than 100 words. Plain text, with a subject line first.

Job summary:
${role}`);
  }

  const d = details || {};
  const history = Array.isArray(d.jobHistory) ? d.jobHistory.map((j) => `- ${[j.title, j.company].filter(Boolean).join(', ')}${j.from || j.to ? ` (${j.from || '?'} to ${j.to || '?'})` : ''}`).join('\n') : '';

  return [
    `## ${name}: ${evaluation.score}/10, fit ${evaluation.fitPercent}%. Recommendation: ${rec}`,
    `**Why:** ${evaluation.rationale || ''}`,
    `### Key matches\n${list(evaluation.keyMatches)}`,
    `### Gaps\n${list(evaluation.gaps)}`,
    `### Soft skills\n${list(evaluation.softSkills)}`,
    `### Red flags to check\n${list(evaluation.redFlags)}`,
    `### Candidate profile\n${String(profile).trim()}`,
    `### Job summary\n${String(role).trim()}`,
    `### Details from the CV\nCity: ${d.city || 'not shown'}\nEducation:\n${list(d.education)}\nJob history:\n${history || '- not shown'}\nSkills: ${Array.isArray(d.skills) && d.skills.length ? d.skills.join(', ') : 'not shown'}`,
    email ? `### Draft email to ${name}\n${String(email).trim()}` : '',
    '_This is a recommendation for a person to review, not a hiring decision._',
  ].filter(Boolean).join('\n\n');
}
