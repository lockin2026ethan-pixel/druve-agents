// Sheet Outbound Caller (Vapi): a Druve agent ported by hand from the n8n
// template "Make outbound sales calls from Google Sheets using a VAPI voice
// agent" by Marcus Taylor (https://n8n.io/workflows/13114, @intellagents,
// voiceai.guide). Draft for Marcus to check. Listed on Druve only by Marcus,
// under his own name.
//
// What it keeps, unchanged: the phone clean-up (strip every non-digit), the
// "already called" filter (needs a phone number and Status "Not Called"), the
// "Get lead's timezone" code word for word (the same country-code map, longest
// code first, Europe/London as the fallback, Intl in en-GB), the 8am-5pm check
// (local hour >= 8 and <= 17), the Vapi POST /call body (assistantId,
// phoneNumberId, customer.number), and the poll: GET /call/{id} once a minute
// until status is "ended", then the row is marked "Called" with the summary,
// transcript and the other call details.
// What changes: no n8n credentials and no Google Sheets trigger. The buyer
// pastes the sheet rows (or CSV) with their own Vapi key, assistant id and
// phone number id, and gets the updated rows back as JSON and CSV to paste
// into the sheet. A lead outside 8am-5pm is returned as "Outside calling
// hours" instead of waiting 2 hours, so the buyer can run the agent again
// later. One extra, optional field: "timezones" adds country codes to the map
// (for example {"234": "Africa/Lagos"}) without editing the author's code.
// "Not Called" is matched without caring about case, because the template's
// own setup note says "Not called". The cleaned digits are sent to Vapi with a
// leading "+", since Vapi expects E.164; numbers must include their country code.
//
// Input (JSON):
//   {"vapi_api_key": "...", "assistant_id": "...", "phone_number_id": "...",
//    "rows": [{"Name": "Ada", "Phone Number": "+44 7700 900123", "Status": "Not Called"}],
//    "max_calls": 10, "max_wait_minutes": 15}
// or "csv": "Name,Phone Number,Status\nAda,+44 7700 900123,Not Called" instead of rows.
// To collect results of calls placed earlier:
//   {"vapi_api_key": "...", "call_ids": ["..."]}
//
// Data-fetch host to declare when publishing: api.vapi.ai
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare api.vapi.ai, and publish.
// Each buyer uses their own Vapi key and number, so it costs you nothing to run.

const VAPI = 'https://api.vapi.ai';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Get lead's timezone", kept as the author wrote it (plus optional extra codes).
function leadTimezone(row, extra) {
  const rawPhone = row['Phone Number'];
  const phoneNumber = String(rawPhone || '');
  const cleaned = phoneNumber.replace(/\D/g, '');

  // Country code to timezone mapping
  const timezoneMap = {
    '44': 'Europe/London',
    '1': 'America/New_York',
    '61': 'Australia/Sydney',
    '33': 'Europe/Paris',
    '49': 'Europe/Berlin',
    '34': 'Europe/Madrid',
    '39': 'Europe/Rome',
    '31': 'Europe/Amsterdam',
    '353': 'Europe/Dublin',
    '91': 'Asia/Kolkata',
    '971': 'Asia/Dubai',
    '65': 'Asia/Singapore',
    '81': 'Asia/Tokyo',
    ...extra,
  };

  // Find matching country code (check longer codes first)
  let timezone = 'Europe/London';
  let countryCode = '44';

  const sortedCodes = Object.keys(timezoneMap).sort((a, b) => b.length - a.length);
  for (const code of sortedCodes) {
    if (cleaned.startsWith(code)) {
      timezone = timezoneMap[code];
      countryCode = code;
      break;
    }
  }

  // Get current time in the lead's timezone using Intl API
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'long',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const localHour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const localMinute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  const weekdayName = parts.find((p) => p.type === 'weekday').value;

  const weekdayMap = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
  const dayOfWeek = weekdayMap[weekdayName];

  return {
    ...row,
    timezone,
    countryCode,
    localHour,
    localMinute,
    dayOfWeek,
    localTimeFormatted: `${weekdayName} ${String(localHour).padStart(2, '0')}:${String(localMinute).padStart(2, '0')}`,
  };
}

function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [])
    .map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']).filter(([h]) => h));
  });
}

async function vapi(key, path, init = {}) {
  const res = await fetch(`${VAPI}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// What the template writes back to the sheet once the call has ended.
function callInfo(call) {
  const a = call.analysis || {};
  const started = call.startedAt ? new Date(call.startedAt) : null;
  const ended = call.endedAt ? new Date(call.endedAt) : null;
  return {
    Status: 'Called',
    'Call ID': call.id,
    'Ended Reason': call.endedReason || '',
    Summary: a.summary || call.summary || '',
    'Success Evaluation': a.successEvaluation ?? '',
    'Structured Data': a.structuredData ? JSON.stringify(a.structuredData) : '',
    Transcript: call.transcript || call.artifact?.transcript || '',
    'Recording URL': call.recordingUrl || call.artifact?.recordingUrl || '',
    'Duration (s)': started && ended ? Math.round((ended - started) / 1000) : '',
    Cost: call.cost ?? '',
  };
}

// "Wait 1 minute" -> "Get Call Status" -> "Call has finished", until ended.
async function waitForEnd(key, id, maxMinutes) {
  for (let i = 0; i < maxMinutes; i++) {
    await sleep(60_000);
    const call = await vapi(key, `/call/${id}`);
    if (call.status === 'ended') return call;
  }
  return null;
}

const csvCell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
function toCsv(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
}

export async function handleMessage(input, providerConfig) {
  let p;
  try { p = JSON.parse(String(input || '')); } catch { p = null; }
  if (!p || typeof p !== 'object') {
    return JSON.stringify({ error: 'Send JSON with vapi_api_key, assistant_id, phone_number_id and rows (or csv). See the header of this file.' });
  }
  const key = String(p.vapi_api_key || providerConfig?.vapiApiKey || '').trim();
  if (!key) return JSON.stringify({ error: 'A Vapi API key is needed: pass "vapi_api_key".' });

  // Collect results of calls placed in an earlier run.
  if (Array.isArray(p.call_ids)) {
    const rows = [];
    for (const id of p.call_ids) {
      try {
        const call = await vapi(key, `/call/${encodeURIComponent(id)}`);
        rows.push(call.status === 'ended' ? callInfo(call) : { 'Call ID': id, Status: `In progress (${call.status})` });
      } catch (e) { rows.push({ 'Call ID': id, Status: `Error: ${e.message}` }); }
    }
    return JSON.stringify({ rows, csv: toCsv(rows) });
  }

  if (!p.assistant_id || !p.phone_number_id) {
    return JSON.stringify({ error: 'Pass "assistant_id" and "phone_number_id" from your Vapi dashboard.' });
  }
  let rows = Array.isArray(p.rows) ? p.rows : p.csv ? parseCsv(p.csv) : [];
  if (!rows.length) return JSON.stringify({ error: 'No rows found. Columns needed: Phone Number, Name, Status.' });

  const extra = p.timezones && typeof p.timezones === 'object' ? p.timezones : {};
  const maxCalls = Math.max(1, Math.min(50, Number(p.max_calls) || 10));
  const maxWait = Math.max(0, Math.min(60, Number(p.max_wait_minutes ?? 15)));
  let placed = 0;
  const out = [];

  for (const original of rows) {
    // "Cleanse phone numbers"
    const row = { ...original, 'Phone Number': String(original['Phone Number'] ?? '').replace(/\D/g, '') };
    // "Filter numbers we've already called"
    const status = row.Status == null ? 'Not Called' : String(row.Status);
    if (!row['Phone Number'] || status.trim().toLowerCase() !== 'not called') { out.push(original); continue; }
    if (placed >= maxCalls) { out.push(original); continue; }

    // "Get lead's timezone" + "Is it between 8am-5pm for them?"
    const t = leadTimezone(row, extra);
    if (!(t.localHour >= 8 && t.localHour <= 17)) {
      out.push({ ...original, Status: original.Status ?? 'Not Called', Note: `Outside calling hours (${t.localTimeFormatted}, ${t.timezone}). Run again later.` });
      continue;
    }

    // "Make phone call"
    try {
      const call = await vapi(key, '/call', {
        method: 'POST',
        body: JSON.stringify({
          assistantId: p.assistant_id,
          phoneNumberId: p.phone_number_id,
          customer: { number: `+${row['Phone Number']}` },
        }),
      });
      placed++;
      const ended = maxWait ? await waitForEnd(key, call.id, maxWait) : null;
      out.push(ended
        ? { ...original, ...callInfo(ended) }
        : { ...original, Status: 'Call placed', 'Call ID': call.id, Note: 'Still running. Send {"call_ids": [...]} later for the results.' });
    } catch (e) {
      out.push({ ...original, Note: `Call failed: ${e.message}` });
    }
  }

  return JSON.stringify({ calls_placed: placed, rows: out, csv: toCsv(out) });
}
