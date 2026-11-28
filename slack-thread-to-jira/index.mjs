// Slack Thread to Jira Ticket: a Druve agent ported by hand from the n8n template
// "Summarize Slack threads into Jira tickets with OpenRouter and Slack approval"
// by Salim Brahmi (https://n8n.io/workflows/16893).
// Draft for Salim to check. Listed on Druve only by Salim, under his own name.
//
// What it keeps, unchanged: the "Get conversation history" call (Slack
// conversations.history, the last MESSAGE_COUNT messages, 5 by default), the
// "Format Thread Code" cleaning (chronological order, bot/join messages and empty
// text dropped, "<@user>: text" lines, the same error guards), the "Ticket Drafter
// Agent" system message and prompt word for word, the "Parse Draft Code" (code
// fences stripped, JSON parsed, error object on failure), and the Jira issue
// fields of "Create an issue" (summary, description with the acceptance criteria
// and the author's French footer, project key, issue type).
// What changes: no Slack slash command, no approval buttons and no Jira call. The
// user pastes a conversation or gives a Slack token and channel, and gets the
// ticket draft back plus the Jira issue payload, ready to review and create.
//
// Input: plain text = a pasted conversation. Or JSON:
//   {"conversation": "..."} or {"messages": [{"user": "U1", "text": "..."}]}
//   {"slack_token": "xoxb-...", "channel_id": "C123", "message_count": 5}
// Optional: "jira_project_key": "ABC", "jira_issue_type": "Task".
//
// Data-fetch host to declare when publishing:
//   slack.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "Ticket Drafter Agent" system message, verbatim.
const SYSTEM = "You are a product manager assistant that turns messy Slack conversations \ninto clean, actionable Jira tickets.\n\nYou receive a channel conversation transcript. Your job is to extract the \ncore issue, request, or idea being discussed and format it as a well-structured \nticket that a developer could pick up without needing to read the original thread.\n\nGuidelines:\n- Identify the single most important actionable item in the conversation.\n- Write a clear, specific title (action-oriented, not vague).\n- Write a description that captures the context, the problem, and the desired outcome.\n- Extract acceptance criteria if the conversation implies any.\n- Infer a sensible ticket type: \"Bug\" if something is broken, \"Story\" if it's a \n  user-facing feature, \"Task\" for everything else.\n- Infer priority from urgency signals in the conversation (words like \"urgent\", \n  \"blocking\", \"prod down\" → High; casual ideas → Low; default Medium).\n- If the conversation is too vague or has no actionable item, set \"actionable\": false \n  and explain why in the description.\n- Never invent details that aren't supported by the conversation.\n\nOutput a JSON object with this exact structure:\n{\n  \"actionable\": true,\n  \"title\": \"concise, specific ticket title\",\n  \"type\": \"Bug\" | \"Story\" | \"Task\",\n  \"priority\": \"High\" | \"Medium\" | \"Low\",\n  \"description\": \"clear description with context and desired outcome\",\n  \"acceptance_criteria\": [\"criterion 1\", \"criterion 2\"],\n  \"source_summary\": \"1-sentence summary of what was discussed in Slack\"\n}\n\nReturn only the JSON object. No preamble, no markdown fences.";

// "Ticket Drafter Agent" prompt, verbatim ({{ $json.formatted_thread }} substituted).
const prompt = (thread) => `Turn this Slack conversation into a Jira ticket draft.

<conversation>
${thread}
</conversation>

Return the ticket draft JSON.`;

// "Format Thread Code", the author's code (data = the Slack API answer).
function formatThread(data) {
  if (data.ok === false) {
    return { error: true, error_reason: data.error || 'Unknown Slack API error', formatted_thread: '' };
  }
  const messages = data.messages ?? [];
  const ordered = [...messages].reverse();
  const cleaned = ordered.filter((m) => m.type === 'message' && !m.subtype && m.text && m.text.trim().length > 0);
  if (cleaned.length === 0) {
    return { error: true, error_reason: 'No usable messages found in the channel.', formatted_thread: '' };
  }
  const transcript = cleaned.map((m) => `<@${m.user}>: ${m.text}`).join('\n');
  return { error: false, message_count: cleaned.length, formatted_thread: transcript };
}

// "Parse Draft Code", the author's code.
function parseDraft(response) {
  const cleaned = String(response ?? '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    return { error: true, actionable: false, title: '', description: `Draft parsing failed: ${error.message}` };
  }
}

async function slackHistory(token, channel, limit) {
  const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=${limit}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
  return res.json();
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object') p = { conversation: raw };

  let formatted;
  try {
    if (p.slack_token && p.channel_id) {
      const limit = Math.max(1, Math.min(200, Number(p.message_count) || 5));
      formatted = formatThread(await slackHistory(p.slack_token, p.channel_id, limit));
    } else if (Array.isArray(p.messages)) {
      // Pasted messages, oldest first: run them through the same cleaning.
      formatted = formatThread({ ok: true, messages: [...p.messages].map((m) => ({ type: 'message', ...m })).reverse() });
    } else if (p.conversation && String(p.conversation).trim()) {
      formatted = { error: false, formatted_thread: String(p.conversation).trim() };
    } else {
      return JSON.stringify({ error: 'Paste a Slack conversation, or send {"slack_token": "...", "channel_id": "..."}.' });
    }
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
  if (formatted.error) return JSON.stringify(formatted);

  const model = getModelClient(providerConfig);
  const draft = parseDraft(await model.complete(`${SYSTEM}\n\n${prompt(formatted.formatted_thread)}`));
  const out = { message_count: formatted.message_count, draft };

  if (!draft.error && draft.actionable !== false) {
    // "Create an issue" fields, ready to send to Jira.
    const criteria = (draft.acceptance_criteria || []).map((c) => `- ${c}`).join('\n');
    out.jira_issue = {
      fields: {
        project: { key: p.jira_project_key || 'YOUR JIRA PROJECT KEY' },
        issuetype: { name: p.jira_issue_type || 'Task' },
        summary: draft.title,
        description: `${draft.description}  \n\n*Critères d'acceptance:* \n${criteria}  \n\n_Créé automatiquement depuis Slack._`,
      },
    };
  }
  return JSON.stringify(out);
}
