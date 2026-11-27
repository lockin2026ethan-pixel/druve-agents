// Article to Social Posts: a Druve agent ported by hand from the n8n template
// "Generate article-based posts for LinkedIn, Twitter (X), and Reddit with OpenAI"
// by Bhavy Shekhaliya (https://n8n.io/workflows/11386).
// Draft for Bhavy to check. Listed on Druve only by Bhavy, under his own name.
//
// What it keeps, unchanged: the four writing steps and their prompts word for
// word: "LinkedIn Post Strategist" (system + article layout, "Post Content"
// JSON), "LinkedIn Post Generator" (the strategist's output inside its system
// message, Article URL required), "LinkedIn Post Formatter" (Sans Serif Bold
// Unicode for key words, no em dashes, no markdown) and "Twitter Agent" (under
// 280 characters, Article Link required, "Post Content" JSON). The optional
// "Re-generate" step with the user's feedback uses the author's regeneration
// prompts word for word.
// What changes: no n8n forms, no posting to LinkedIn, X or Reddit, and no
// Supabase store of viral posts (that database is the author's own, so the
// strategist works without it). The article is read through r.jina.ai instead
// of Readability (title, text, site name), or the user pastes the text.
// The user gets the LinkedIn post and the tweet back, ready to post themselves.
//
// Input: an article URL, or pasted article text. Or JSON:
//   {"url": "https://..."} or {"text": "...", "title": "...", "url": "..."}
// Optional: "feedback_linkedin": "make it shorter", "feedback_tweet": "...".
//
// Data-fetch host to declare when publishing:
//   r.jina.ai
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "LinkedIn Post Strategist" system message, verbatim.
const STRATEGIST_SYSTEM = "# LinkedIn Viral Content Analyzer - System Prompt\n\nYou are an expert LinkedIn content strategist and analyst with access to a Supabase vector database containing thousands of viral LinkedIn posts. Your primary role is to help users create engaging, high-performing LinkedIn content by analyzing patterns, formats, and hooks from proven viral posts.\n\n## Your Capabilities\n\n1. **Pattern Analysis**: Search and analyze viral posts to identify successful patterns in:\n   - Content structure and flow\n   - Storytelling techniques\n   - Engagement triggers\n   - Tone and voice variations\n   - Post length and formatting\n\n2. **Hook Identification**: Extract and categorize powerful opening lines that:\n   - Grab attention in the first 1-2 lines\n   - Create curiosity or emotional resonance\n   - Compel readers to click \"see more\"\n   - Match specific industries or audiences\n\n3. **Format Recognition**: Identify effective formatting styles including:\n   - Line breaks and spacing patterns\n   - Emoji usage and placement\n   - Bullet points and lists\n   - Call-to-action placement\n   - Hashtag strategies\n\n4. **Content Strategy**: Provide actionable recommendations based on:\n   - Similar successful posts in the user's niche\n   - Trending topics and formats\n   - Audience engagement patterns\n   - Optimal posting frameworks\n\n## How to Use the Vector Database\n\nWhen a user asks for help, follow this process:\n\n1. **Query the Database**: Use semantic search to find relevant viral posts based on:\n   - Topic/theme keywords\n   - Industry or niche\n   - Content type (story, tip, announcement, etc.)\n   - Engagement metrics (minimum likes/comments)\n\n2. **Analyze Results**: Examine the retrieved posts for:\n   - Common structural elements\n   - Recurring hook patterns\n   - Formatting similarities\n   - Engagement drivers\n\n3. **Synthesize Insights**: Create clear, actionable recommendations:\n   - Show 2-3 specific examples from the database\n   - Explain WHY these posts performed well\n   - Extract reusable templates and formulas\n   - Adapt patterns to the user's specific context\n\n## Response Framework\n\nFor each user request:\n\n### 1. Understand the Context\n- What type of content are they creating?\n- Who is their target audience?\n- What's their goal (engagement, lead gen, authority building)?\n\n### 2. Search the Database\n- Query with relevant semantic search terms\n- Retrieve 5-10 most relevant viral posts\n\n### 3. Present Analysis\n```\n**Pattern Found**: [Name the pattern]\n**Why It Works**: [Psychology/mechanism]\n**Example from Database**: [Show snippet]\n**How to Apply**: [Specific steps]\n```\n\n## Writing Style Guidelines\n\nYour responses should sound like they're coming from a thoughtful, articulate human, not overly robotic, overly formal, or exaggeratedly casual. Use short, clear sentences that flow smoothly. Keep language grounded and confident.\n\n**Style Rules:**\n- Avoid filler phrases like \"in today's world\" or \"needless to say\"\n- Never use em dashes (—). Use commas, semicolons, or break sentences when needed\n- Maintain a balance between professionalism and relatability, like how a smart professional would write a LinkedIn post, personal article, or thoughtful email\n- Focus on insight and clarity, not just word count\n- Write with confidence but remain approachable\n- **For bold sections, use Sans Serif Bold Unicode characters** (𝗲𝘅𝗮𝗺𝗽𝗹𝗲: 𝗧𝗵𝗶𝘀 𝗶𝘀 𝗯𝗼𝗹𝗱 𝘁𝗲𝘅𝘁)\n\n## Tone and Style\n\n- Focus on empowering the user's unique voice";

const generatorSystem = (strategy) => `# Goal
Generate likedin post using given data

# Rule
- Must add Article URL in Linkedin Post

${strategy}`;

const FORMATTER_SYSTEM = `You are a helpful LinkedIn Post Formatter.

## Rule
- Delete content other than actual post (Don't remove Article URL)
- For important words, use Sans Serif Bold Unicode characters** (𝗲𝘅𝗮𝗺𝗽𝗹𝗲: 𝗧𝗵𝗶𝘀 𝗶𝘀 𝗯𝗼𝗹𝗱 𝘁𝗲𝘅𝘁) 
- Never use em dashes (—). Use commas, or break sentences when needed
- Never include markdown`;

const TWITTER_SYSTEM = `You are a helpful twitter tweet generator based on provided content

# Rule
- Tweet character length must be under 280 including spaces as well
- Must add Article Link in Tweet`;

const articleBlock = (a) => `# Article Content

- Title:  ${a.title}
- Author: ${a.author}
- Content Text: ${a.contentText}
- Site Name: ${a.siteName}
- Excerpt: ${a.excerpt}`;

const regenLinkedIn = (original, feedback) => `You are a LinkedIn post regeneration expert. The user wants to improve an existing LinkedIn post based on their specific feedback.

## Input Data

**Original Post**: ${original}
**User Feedback**: ${feedback}

## Your Task

Rewrite the LinkedIn post incorporating the user's requested changes while maintaining viral patterns and engagement principles.

# Rule
- Delete content other than actual post
- For important words, use Sans Serif Bold Unicode characters** (𝗲𝘅𝗮𝗺𝗽𝗹𝗲: 𝗧𝗵𝗶𝘀 𝗶𝘀 𝗯𝗼𝗹𝗱 𝘁𝗲𝘅𝘁) 
- Never use em dashes (—). Use commas, or break sentences when needed
- Never include markdown`;

const regenTweet = (original, feedback) => `You are a Twitter post regeneration expert. The user wants to improve an existing Tweet based on their specific feedback.

## Input Data

**Original Post**: ${original}
**User Feedback**: ${feedback}

## Your Task

Rewrite the Twitter post incorporating the user's requested changes while maintaining viral patterns and engagement principles.

# Rule
- Delete content other than actual post 
- Never use em dashes (—). Use commas, or break sentences when needed
- Never include markdown`;

function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// Like n8n's Structured Output Parser {"Post Content": "..."} with autoFix.
async function postContent(model, prompt) {
  const fmt = '\n\nReturn ONLY a JSON object: {"Post Content": "..."}';
  let o = parseJson(await model.complete(prompt + fmt));
  if (!o || typeof o['Post Content'] !== 'string') o = parseJson(await model.complete(`${prompt}${fmt}\nYour previous answer was not valid JSON.`));
  return o && typeof o['Post Content'] === 'string' ? o['Post Content'] : null;
}

// Reads the article through r.jina.ai (title + main text), in place of Readability.
async function readArticle(url) {
  const res = await fetch(`https://r.jina.ai/${url}`);
  if (!res.ok) throw new Error(`r.jina.ai HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text();
  const title = (t.match(/^Title:\s*(.+)$/m) || [])[1] || 'No title found';
  const body = t.includes('Markdown Content:') ? t.split('Markdown Content:').slice(1).join('Markdown Content:').trim() : t;
  return { title: title.trim(), contentText: body };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object') p = /^https?:\/\/\S+$/i.test(raw) ? { url: raw } : { text: raw };

  let article;
  try {
    if (p.text && String(p.text).trim()) {
      const text = String(p.text).trim();
      article = { title: p.title || text.split('\n')[0].slice(0, 120), contentText: text };
    } else if (p.url) {
      // "If": the Article Link must be a URL.
      try { new URL(p.url); } catch { return JSON.stringify({ error: 'Unable to Process Article. Please enter a different article.' }); }
      article = await readArticle(p.url);
    } else {
      return JSON.stringify({ error: 'Send an article URL or paste the article text.' });
    }
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
  if (!article.contentText.trim()) return JSON.stringify({ error: 'Unable to Process Article. Please enter a different article.' });

  const url = p.url || '';
  let siteName = '';
  try { siteName = url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch {}
  const a = {
    title: article.title, author: p.author || 'Unknown', contentText: article.contentText.slice(0, 30000),
    siteName, excerpt: article.contentText.replace(/\s+/g, ' ').slice(0, 200),
  };

  const model = getModelClient(providerConfig);

  // LinkedIn: Strategist -> Generator -> Formatter.
  const strategy = await postContent(model, `${STRATEGIST_SYSTEM}\n\n${articleBlock(a)}`);
  const generated = String(await model.complete(`${generatorSystem(strategy ?? '')}\n\nContent Text:\n\n${a.contentText}\n\nArticle URL: ${url}\n`)).trim();
  let linkedin = String(await model.complete(`${FORMATTER_SYSTEM}\n\n${generated}`)).trim();
  if (p.feedback_linkedin) linkedin = String(await model.complete(regenLinkedIn(linkedin, p.feedback_linkedin))).trim();

  // X: "Twitter Agent".
  let tweet = await postContent(model, `${TWITTER_SYSTEM}\n\n${articleBlock(a)}\n- Article URL: ${url}`);
  if (tweet && p.feedback_tweet) tweet = String(await model.complete(regenTweet(tweet, p.feedback_tweet))).trim();

  return JSON.stringify({
    title: a.title,
    linkedin_post: linkedin,
    tweet,
    tweet_length: tweet ? tweet.length : null,
  });
}
