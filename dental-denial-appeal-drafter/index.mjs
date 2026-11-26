// Dental Denial Appeal Drafter: a Druve agent ported by hand from the n8n
// template "Draft dental denial appeal packets from Gmail EOBs with OpenAI and
// Google Drive" by Swapnil Mandloi, Swapnil AI Labs (https://n8n.io/workflows/19460).
// Draft for Swapnil AI Labs to check. Listed on Druve only by Swapnil AI Labs, under its own name.
//
// What it keeps, unchanged: the "Normalize Denial Payload" defaults, the
// "Extract Denial Line Items" system prompt and JSON schema word for word, the
// "Score Appeal Strategy & Deadline" code (the reason-code map, the 21-day
// default, urgent at 5 days or less), the appealable / non-appealable split
// and the priority / standard queues, the "Draft Appeal Letter" system message
// and prompt word for word, and the packet layout (letters joined by ---).
// What changes: no Gmail trigger, Drive, data tables or practice-management
// call. The buyer pastes the EOB or denial email text and gets the packet,
// the per-line decisions and the non-appealable list back to file themselves.
// One fix: in the n8n flow, "Split Out Denied CPT Lines" keeps only the line
// item, so claimNumber and payerName reach the letter prompt empty. Here each
// line keeps the claim number and payer from the email.
//
// Input: the EOB / denial email text, or JSON
//   {"email": "...", "from": "Delta Dental <claims@...>", "claimNumber": "...", "patientName": "..."}
//
// No data-fetch hosts. It runs on each buyer's own model key.
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", and publish.

import { getModelClient } from '@druve/cli/providers';

// "Extract Denial Line Items", verbatim.
const EXTRACT_SYSTEM = "You are a dental billing coding specialist. Extract every denied CPT/ADA procedure code line from this EOB text, its denial reason code (e.g. CO-11, CO-16, CO-197), denial reason text, denied dollar amount, and the payer's stated appeal filing deadline. Return strict JSON matching the schema. Never invent codes that are not present in the text.";
const EXTRACT_SCHEMA = '{"type":"object","properties":{"lineItems":{"type":"array","items":{"type":"object","properties":{"cptCode":{"type":"string"},"deniedAmount":{"type":"number"},"denialReasonCode":{"type":"string"},"denialReasonText":{"type":"string"},"filingDeadline":{"type":"string"}}}}}}';

// "Draft Appeal Letter", verbatim.
const APPEAL_SYSTEM = 'You are a dental insurance appeals specialist. Write concise, evidence-based appeal letters that reference the specific denial reason code and the ADA procedure code. Never fabricate clinical findings not provided.';
const appealPrompt = (j) => `Draft a formal dental insurance appeal letter for claim ${j.claimNumber}, CPT ${j.cptCode}, denial reason ${j.denialReasonText} (${j.denialReasonCode}). Strategy: ${j.appealStrategy}. Required supporting docs: ${j.requiredDocs.join(', ')}. Cite clinical necessity where applicable. Keep to one page, professional tone, addressed to ${j.payerName}.`;

// "Score Appeal Strategy & Deadline", the author's code.
function score(item) {
  const reasonMap = {
    'CO-11': { appealable: true, strategy: 'coding_correction', docs: ['corrected_claim_form'] },
    'CO-16': { appealable: true, strategy: 'missing_info_resubmit', docs: ['x_rays', 'perio_chart'] },
    'CO-50': { appealable: true, strategy: 'clinical_necessity', docs: ['clinical_narrative', 'x_rays'] },
    'CO-197': { appealable: true, strategy: 'auth_retro_request', docs: ['pre_auth_reference'] },
    'CO-29': { appealable: false, strategy: 'timely_filing_expired', docs: [] },
    'CO-A1': { appealable: false, strategy: 'benefit_exhausted', docs: [] },
  };
  const code = (item.denialReasonCode || '').toUpperCase().trim();
  const rule = reasonMap[code] || { appealable: true, strategy: 'clinical_necessity', docs: ['clinical_narrative'] };
  let daysUntilDeadline = 21;
  if (item.filingDeadline) {
    const d = new Date(item.filingDeadline);
    if (!isNaN(d.getTime())) {
      daysUntilDeadline = Math.ceil((d.getTime() - Date.now()) / 86400000);
    }
  }
  return {
    ...item,
    appealable: rule.appealable,
    appealStrategy: rule.strategy,
    requiredDocs: rule.docs,
    daysUntilDeadline,
    urgent: daysUntilDeadline <= 5,
  };
}

function parseJson(text) {
  const s = String(text);
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/) || s.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? (m[1] || m[0]) : s); } catch { return null; }
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object') p = { email: raw };
  if (!String(p.email || p.text || '').trim()) {
    return JSON.stringify({ error: 'Paste the EOB or claim denial email text.' });
  }

  // "Normalize Denial Payload"
  const base = {
    patientName: p.patientName ?? 'Unknown Patient',
    payerName: p.from ?? p.payerName ?? 'Unknown Payer',
    claimNumber: p.claimNumber ?? '',
    rawEmailBody: p.email ?? p.text ?? '',
    receivedAt: p.date ?? new Date().toISOString(),
  };

  const model = getModelClient(providerConfig);
  const extracted = parseJson(await model.complete(
    `${EXTRACT_SYSTEM}\n\nJSON schema:\n${EXTRACT_SCHEMA}\n\nReturn only the JSON.\n\nEOB text:\n${base.rawEmailBody}`,
  ));
  const lineItems = Array.isArray(extracted?.lineItems) ? extracted.lineItems : [];
  if (!lineItems.length) {
    return JSON.stringify({ ...base, rawEmailBody: undefined, lineItems: [], note: 'No denied procedure lines were found in the text.' });
  }

  const decisions = [];
  const nonAppealable = [];
  const letters = [];
  for (const line of lineItems) {
    const j = score({ ...line, claimNumber: base.claimNumber, payerName: base.payerName });
    if (!j.appealable) {
      // "Tag Non-Appealable Reason" + the billing manager note
      const tagged = { ...j, closeReason: j.appealStrategy, status: 'non_appealable' };
      nonAppealable.push({ ...tagged, note: `CPT ${j.cptCode} denied (reason ${j.appealStrategy}) is not appealable. No action beyond write-off review.` });
      decisions.push(tagged);
      continue;
    }
    // "Check Filing Deadline Urgency" -> priority or standard queue
    const tagged = { ...j, reviewQueue: j.urgent ? 'priority' : 'standard', status: 'appealable' };
    const output = String(await model.complete(`${APPEAL_SYSTEM}\n\n${appealPrompt(tagged)}`)).trim();
    letters.push(output);
    decisions.push({ ...tagged, output });
  }

  // "Shape Appeal Record"
  const appealable = decisions.filter((d) => d.status === 'appealable');
  return JSON.stringify({
    claimNumber: base.claimNumber,
    payerName: base.payerName,
    patientName: base.patientName,
    lineCount: appealable.length,
    priorityLines: appealable.filter((d) => d.reviewQueue === 'priority').map((d) => d.cptCode),
    appealPacketText: letters.join('\n\n---\n\n'),
    decisions,
    nonAppealable,
    frontDeskNote: appealable.length
      ? `A ${appealable.length}-line appeal packet for ${base.payerName} is drafted. Please review, attach supporting X-rays, and submit within the payer deadline.`
      : '',
  });
}
