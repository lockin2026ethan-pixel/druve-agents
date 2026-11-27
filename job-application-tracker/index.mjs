// Job Application Tracker + Interview Prep: a Druve agent ported by hand from the
// n8n template "Track job applications and prep interviews with Notion and
// GPT-5-mini" by Diego Parrás (https://n8n.io/workflows/13104).
// Draft for Diego to check. Listed on Druve only by Diego, under his own name.
//
// What it keeps, unchanged: the two input routes (a job posting URL read through
// r.jina.ai, or the pasted text of a posting or application confirmation email),
// the "Extract Job Details with AI" system and user prompts word for word, the
// "Parse and Structure Job Data" code (code fences stripped, follow-up date = today
// + 7 days, status "Applied", jobUrl or "From email"), the "Generate Interview Prep
// Materials" prompts word for word (5 sections), and the success summary text.
// What changes: no n8n credentials, no webhook, Gmail trigger, Notion, Slack or
// daily schedule. The user sends a link or pasted text and gets the structured
// application plus the interview prep back. The template's "Research Company
// Online" step is not in the published workflow, so the prep uses the author's
// own fallback text ("No additional research available").
//
// Input: a job posting URL, or the pasted text of a posting / confirmation email.
// Or JSON: {"jobUrl": "https://..."} or {"text": "..."}; optional "days_until_followup": 7.
//
// Data-fetch host to declare when publishing:
//   r.jina.ai
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "Scrape Job Posting URL": POST https://r.jina.ai/{{ jobUrl }}, response as text.
async function scrape(jobUrl) {
  const res = await fetch(`https://r.jina.ai/${jobUrl}`, { method: 'POST' });
  if (!res.ok) throw new Error(`r.jina.ai HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

// "Extract Job Details with AI", system message verbatim ({{ scraped data }} substituted).
const extractSystem = (scraped) => `You are a job application data extractor. Extract structured information from job postings or application confirmation emails. This is your source ${scraped ?? ''}

Always respond with valid JSON only, no markdown or explanation. `;

// "Extract Job Details with AI", user message verbatim ({{ $json.data || $json.textPlain }}).
const extractUser = (content) => `Extract the following information from this content:

${content}

---

Respond with this exact JSON structure:
{
  "company": "Company name",
  "role": "Job title",
  "location": "City, State or Remote",
  "salaryRange": "Salary range if mentioned, or 'Not specified'",
  "jobType": "Full-time/Part-time/Contract",
  "requirements": ["Key requirement 1", "Key requirement 2", "Key requirement 3"],
  "responsibilities": ["Main responsibility 1", "Main responsibility 2"],
  "benefits": ["Benefit 1", "Benefit 2"],
  "applicationDeadline": "Date if mentioned, or null",
  "companyDescription": "Brief company description from posting"
}`;

// "Generate Interview Prep Materials", system + user verbatim.
const PREP_SYSTEM = 'You are a career coach helping job seekers prepare for interviews. Provide actionable, specific insights.';
const prepUser = (j, research) => `Based on this job posting and company research, prepare interview materials.

## Job Details
- Company: ${j.company}
- Role: ${j.role}
- Requirements: ${Array.isArray(j.requirements) ? j.requirements.join(', ') : 'Not specified'}
- Responsibilities: ${Array.isArray(j.responsibilities) ? j.responsibilities.join(', ') : 'Not specified'}

## Company Research
${research?.substring(0, 3000) || 'No additional research available'}

---

Provide:

### 1. LIKELY INTERVIEW QUESTIONS (5-7 questions)
Based on the role requirements, what questions will they probably ask?

### 2. SUGGESTED TALKING POINTS
What specific experiences or skills should the candidate emphasize?

### 3. QUESTIONS TO ASK THEM
3-5 thoughtful questions that show genuine interest and research.

### 4. COMPANY CULTURE INSIGHTS
Based on the research, what's the company culture like? Any red flags or positives?

### 5. SALARY NEGOTIATION NOTES
Any insights on compensation, benefits, or negotiation leverage?

Be specific and actionable. Avoid generic advice.`;

// "Parse and Structure Job Data", the author's code.
function parseJob(content, jobUrl, days) {
  const DAYS_UNTIL_FOLLOWUP = days;
  let jobData;
  try {
    const cleanJson = String(content)
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    jobData = JSON.parse(cleanJson);
  } catch {
    return { error: true, message: 'Failed to parse AI response', rawResponse: content };
  }
  const today = new Date();
  const followUpDate = new Date(today);
  followUpDate.setDate(followUpDate.getDate() + DAYS_UNTIL_FOLLOWUP);
  return {
    ...jobData,
    appliedDate: today.toISOString().split('T')[0],
    followUpDate: followUpDate.toISOString().split('T')[0],
    status: 'Applied',
    jobUrl: jobUrl || 'From email',
  };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object') p = /^https?:\/\/\S+$/i.test(raw) ? { jobUrl: raw } : { text: raw };
  const days = Number.isFinite(Number(p.days_until_followup)) && p.days_until_followup !== undefined ? Number(p.days_until_followup) : 7;

  // "Route by Input Source": jobUrl (form) or pasted text (email).
  let scraped;
  let content;
  if (p.jobUrl) {
    try { scraped = await scrape(p.jobUrl); } catch (e) { return JSON.stringify({ error: e.message }); }
    content = scraped;
  } else if (p.text && String(p.text).trim()) {
    content = String(p.text);
  } else {
    return JSON.stringify({ error: 'Send a job posting URL, or paste the posting or confirmation email text.' });
  }

  const model = getModelClient(providerConfig);
  const extracted = await model.complete(`${extractSystem(scraped)}\n\n${extractUser(content)}`);
  const job = parseJob(extracted, p.jobUrl, days);
  if (job.error) return JSON.stringify(job);

  const prep = String(await model.complete(`${PREP_SYSTEM}\n\n${prepUser(job, undefined)}`)).trim();

  // "Prepare Success Response" text (the Notion line left out, since nothing is saved to Notion here).
  const summary = `✅ Application tracked!\n\n**${job.company}** - ${job.role}\n\n📍 ${job.location}\n💰 ${job.salaryRange}\n📅 Follow up: ${job.followUpDate}`;
  return JSON.stringify({ summary, application: job, interview_prep: prep });
}
