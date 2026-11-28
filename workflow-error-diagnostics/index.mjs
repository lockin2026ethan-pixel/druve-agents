// Workflow Error Diagnostics: a Druve agent ported by hand from the n8n template
// "Automated error notifications with optional GPT-4o diagnostics via email"
// by Chandan Singh (https://n8n.io/workflows/11507).
// Draft for Chandan to check. Listed on Druve only by Chandan, under his own name.
//
// What it keeps, unchanged: the "Analyze Error with AI" system and user messages
// word for word (severity_level Low/Medium/High/Critical, a quick_resolution of at
// most 100 words), the "Use AI Analysis?" switch, and the author's HTML alert email
// with the same rows (workflow name and ID, node, run ID, severity, error message,
// quick resolution, "Open Workflow" button) and subject line.
// What changes: no n8n Error Trigger and no SMTP node. The user pastes the error
// (or sends its fields as JSON) and gets the diagnosis plus the ready email HTML
// and subject back, to send from any mail tool.
//
// Input: plain text = the error message. Or JSON:
//   {"workflow_name": "...", "workflow_id": "...", "node": "...", "run_id": "...",
//    "error_message": "...", "execution_url": "https://...", "analyze": true}
//
// Data-fetch hosts: none.
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", and publish. It runs on each
// buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// "Analyze Error with AI" system message, verbatim.
const SYSTEM = "You are an expert automation engineer. \nAlways respond with a RAW JSON object without wrapping it in quotes. \nNever escape characters, never add \\n, never format JSON as a string.\nNever include explanations, markdown, commentary, or prose.\nreturn ONLY valid JSON that includes:\n- severity level\n- a detailed (not more than 100 words) suggested configuration/change\nDo NOT include explanations, prose, markdown, commentary, or any text before or after the JSON.";

// "Analyze Error with AI" user message, verbatim (the Error Trigger fields substituted).
const userMessage = (e) => `Analyze the following workflow error and return ONLY a valid JSON object (do not include \\n etc...) with this exact structure:

{
  "severity_level": "",
  "quick_resolution": ""
}

### Context:
Workflow Name: ${e.workflow_name || 'Unknown'}
Workflow ID: ${e.workflow_id || 'N/A'}
Node Name: ${e.node || 'Unknown'}
Run ID: ${e.run_id || 'N/A'}
Error Message: ${e.error_message}



### Requirements:
1. "severity_level" must be one of: Low, Medium, High, Critical.
2. "quick_resolution" must be a  detailed (not more than 100 words), practical fix the user can apply.
3. The response MUST be valid JSON and nothing else.

Return the JSON object directly, not as a string. Do not escape characters.
`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "Format Email Body", the author's HTML (AI rows empty when analysis is off, as in n8n).
const emailBody = (e, a) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Workflow Error Alert</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background-color: #f4f6f8;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      background: #ffffff;
      margin: 30px auto;
      padding: 20px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
    }
    .header {
      background-color: #dc3545;
      color: white;
      padding: 15px 0px;
      border-radius: 8px 8px 0 0;
      font-size: 18px;
      font-weight: bold;
      text-align: center;
    }
    .content {
      padding: 15px;
      color: #333333;
      line-height: 1.5;
    border: 0.5px solid #cfcfcf
     
    }
    .label {
      font-weight: bold;
      color: #555555;
    }
    .footer {
      margin-top: 25px;
      font-size: 12px;
      color: #888888;
      text-align: center;
    }
    a.button {
      display: inline-block;
      background-color: #dc3545;
      color: white !important;
      padding: 10px 20px;
      border-radius: 5px;
      text-decoration: none;
      margin-top: 15px;
    }
    a.button:hover {
      background-color: #c82333;
    }
  </style>
</head>
<body>
  
  <div class="container">
    <div class="header">
      Workflow Error Notification
    </div>
    <div class="content">
      <p>Dear User,</p>
      <p>An error occurred in one of your n8n workflows. Please review the details below:</p>

      <!-- Table for Workflow Details -->
      <center>
      <table  style="width:95%; table-layout: fixed; border-collapse: collapse;" border="1" cellpadding="8" cellspacing="0">
        <tr>
          <td class="label"><nobr>Workflow Name:</nobr></td>
          <td>${esc(e.workflow_name || 'Unknown')}</td>
        </tr>
        <tr>
          <td class="label"><nobr>Workflow ID:</nobr></td>
          <td>${esc(e.workflow_id || 'N/A')}</td>
        </tr>
        <tr>
          <td class="label"><nobr>Node Name:</nobr></td>
          <td>${esc(e.node || 'Unknown')}</td>
        </tr>
        <tr>
          <td class="label"><nobr>Run ID:</nobr></td>
          <td>${esc(e.run_id || 'N/A')}</td>
        </tr>
        <tr>
          <td class="label"><nobr>Severity Level:</nobr></td>
          <td>${esc(a.severity_level || '')}</td>
        </tr>
        <tr>
          <td class="label"><nobr>Error Message:</nobr></td>
          <td>${esc(e.error_message || '')}</td>
        </tr>
        <tr>
          <td class="label"><nobr>Quick Resolution:</nobr></td>
          <td>${esc(a.quick_resolution || '')}</td>
        </tr>
      </table>
      </center>

      <a href="${esc(e.execution_url || '#')}" target="_blank" class="button">Open Workflow</a>
    </div>
    <div class="footer">
      This is an automated message from your n8n automation system.
    </div>
  </div>
</body>
</html>
`;

function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let e;
  try { e = JSON.parse(raw); } catch { e = null; }
  if (!e || typeof e !== 'object') e = { error_message: raw };
  if (!e.error_message || !String(e.error_message).trim()) return JSON.stringify({ error: 'Paste the error message, or send {"error_message": "...", "workflow_name": "..."}.' });

  // "Use AI Analysis?" (the template's switch; on by default here, since that is the point of the agent).
  let analysis = { severity_level: '', quick_resolution: '' };
  if (e.analyze !== false) {
    const model = getModelClient(providerConfig);
    const out = parseJson(await model.complete(`${SYSTEM}\n\n${userMessage(e)}`));
    if (out) analysis = { severity_level: out.severity_level ?? '', quick_resolution: out.quick_resolution ?? '' };
    else analysis.error = 'The model did not return valid JSON.';
  }
  return JSON.stringify({
    ...analysis,
    // "Config - Set Fields" emailSubject.
    email_subject: `\u{1F916} N8N Workflow Error Alert: ${e.workflow_name || ''}`,
    email_html: emailBody(e, analysis),
  });
}
