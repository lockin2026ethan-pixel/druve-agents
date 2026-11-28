// Daily Calendar SMS Summary: a Druve agent ported by hand from the n8n
// template "Get daily calendar summaries via SMS with Google Calendar, Twilio
// and Claude AI" by Anne (https://n8n.io/workflows/10134).
// Draft for Anne to check. Listed on Druve only by Anne, under her own name.
//
// What it keeps, unchanged: the "Basic LLM Chain" system prompt (Riley) and
// user prompt word for word, the event list format of the "Format list of
// events" code node ("• <summary> at <hh:mm>" in the event's own time zone,
// "No events today." when empty), the Google Calendar window (today to
// tomorrow), the "skip when there are no events" check, and the Twilio SMS.
// What changes: no n8n credentials and no 7 AM trigger. The buyer runs it when
// they want the summary (or on their own schedule with the Druve CLI) and gets
// the SMS text back. The SMS is sent only when Twilio details are given.
//
// Input (JSON), one of:
//   {"name": "Anne", "events": ["Dentist appointment at 02:00 PM", "Yoga at 04:00 PM"]}
//   {"name": "Anne", "google_access_token": "...", "calendar_id": "primary"}
// Optional: "timezone": "Europe/Paris" (for the Google Calendar day window),
//           "always_send": true (send even when there are no events),
//           "twilio": {"account_sid": "AC...", "auth_token": "...", "from": "+1...", "to": "+1..."}.
// Plain text input is treated as one event per line.
//
// Data-fetch hosts to declare when publishing:
//   www.googleapis.com, api.twilio.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key and accounts.

import { getModelClient } from '@druve/cli/providers';

// "Basic LLM Chain" system message, verbatim ({{$json.calendar}} is the name).
const systemPrompt = (calendar) => `You are Riley, an AI personal assistant designed to send daily SMS summaries to ${calendar}. Your task is to create a concise, informative, and friendly message summarizing the day's events for the family.

The list of the day's events is enclosed in <daily_events />, which may include appointments, activities, reminders, or other important information.  When summarizing the daily events, follow these guidelines:

1. Prioritize the most important events
2. Group similar events together
3. Use concise language to keep the message brief
4. Include specific times for scheduled events
5. Mention which family members are involved in each event, if specified.

Format the SMS in a friendly, conversational tone. Feel free to use emojis. Start with a greeting and end with a positive closing remark, signed in a new line "-Riley from RalleyReminders.com".

Keep the entire message under 200 characters to ensure it fits in a single SMS. Format it with line breaks. If there is more than one event, number the events to make it easily readable. Here's an example of how your output should be structured:

<example_sms_one_event>
Hello ${calendar}! Today: Dentist appointment @2pm
Remember to brush your teeth before you go. Have a great day! 😊
-Riley from RalleyReminders.com
</example_sms_one_event>

<example_sms_many_events>
Hello ${calendar}! Today:
1. Dentist appointment @2pm
2. Yoga @4pm

Remember to thank God for this day. Have a great day! 😊
-Riley from RalleyReminders.com
</example_sms_many_events>`;

// "Basic LLM Chain" user text, verbatim.
const userPrompt = (calendar, eventsList) => `Today’s calendar items for ${calendar}:
<daily_events>
${eventsList}
</daily_events>

Now, generate an SMS summary following the guidelines.`;

// "Format list of events": one line per event, time in the event's own zone.
function formatEvents(items) {
  return items
    .map((evt) => {
      const start = evt.start || {};
      let time;
      if (start.dateTime) {
        time = new Date(start.dateTime).toLocaleTimeString('en-US', {
          timeZone: start.timeZone || undefined,
          hour: '2-digit',
          minute: '2-digit',
        });
      } else {
        return `• ${evt.summary || '(no title)'} (all day)`;
      }
      return `• ${evt.summary || '(no title)'} at ${time}`;
    })
    .join('\n');
}

// Today 00:00 to tomorrow 00:00 in the given time zone (n8n: $today to $today.plus(1, 'day')).
function dayWindow(timeZone) {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const asUtc = new Date(`${ymd}T00:00:00Z`);
  // Offset of the zone at that moment, so midnight is local midnight.
  const zoned = new Date(asUtc.toLocaleString('en-US', { timeZone: timeZone || undefined }));
  const utc = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  const start = new Date(asUtc.getTime() - (zoned.getTime() - utc.getTime()));
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

async function fetchEvents(p) {
  const cal = encodeURIComponent(p.calendar_id || 'primary');
  const { timeMin, timeMax } = dayWindow(p.timezone);
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events?${q}`, {
      headers: { Authorization: `Bearer ${p.google_access_token}` },
    });
    if (!res.ok) throw new Error(`Google Calendar HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    items.push(...(data.items || []).filter((e) => e.status !== 'cancelled'));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

async function sendSms(t, body) {
  const auth = Buffer.from(`${t.account_sid}:${t.auth_token}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(t.account_sid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: t.to, From: t.from, Body: body }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${data.message || ''}`.trim());
  return data.sid;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    p = { events: raw ? raw.split('\n').map((s) => s.trim()).filter(Boolean) : [] };
  }
  const calendar = String(p.name || p.calendar || 'there');

  let eventsList;
  let count;
  try {
    if (p.google_access_token) {
      const items = await fetchEvents(p);
      count = items.length;
      eventsList = formatEvents(items);
    } else if (Array.isArray(p.events)) {
      const lines = p.events.map(String).map((s) => s.trim()).filter(Boolean);
      count = lines.length;
      eventsList = lines.map((s) => (s.startsWith('•') ? s : `• ${s}`)).join('\n');
    } else {
      return JSON.stringify({ error: 'Send {"name": "...", "events": [...]} or {"name": "...", "google_access_token": "..."}. See the header of this file.' });
    }
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }

  // "Check if there are any events": the template stops here when the day is empty.
  if (!count && !p.always_send) {
    return JSON.stringify({ name: calendar, events_found: 0, note: 'No events today, so no SMS was written (set "always_send": true to send one anyway).' });
  }

  const model = getModelClient(providerConfig);
  const sms = String(await model.complete(`${systemPrompt(calendar)}\n\n${userPrompt(calendar, eventsList || 'No events today.')}`)).trim();

  const out = { name: calendar, events_found: count, events_list: eventsList || 'No events today.', sms, characters: [...sms].length };
  const t = p.twilio;
  if (t && t.account_sid && t.auth_token && t.from && t.to) {
    try { out.twilio_sid = await sendSms(t, sms); } catch (e) { out.twilio_error = e.message; }
  }
  return JSON.stringify(out);
}
