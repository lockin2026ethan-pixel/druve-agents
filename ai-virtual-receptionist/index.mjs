// AI Virtual Receptionist: a Druve agent ported by hand from the n8n template
// "Create an AI-powered virtual receptionist with Google Calendar & Sheets" by
// Risper Bevalyn (https://n8n.io/workflows/8326). Draft for Risper to check.
// Nothing is published.
//
// What it keeps, unchanged: the AI Receptionist system message, word for word,
// with the same business fields from the "Get business details" sheet
// (ai_name, business_name, ai_personality, ai_role, business_type, location,
// working_hours, currency, services, timezone, booking_advance_days,
// cancellation_hours, emergency_available), the emergency block, "time now",
// the {"ai_reply": ...} output format, and the 15-message memory window.
// What changes: Druve agents can't log in to Google, so the calendar and
// sheet tools are not called. Instead the buyer passes the business details
// and any busy calendar slots in the input, and when a customer confirms a
// booking the agent also returns the booking details for the business to put
// in its calendar.
//
// Input (JSON):
//   {"business": {"ai_name": "Ava", "business_name": "...", "ai_personality": "friendly",
//                 "ai_role": "answer questions and book appointments", "business_type": "...",
//                 "location": "...", "working_hours": "...", "currency": "USD",
//                 "services": "...", "timezone": "...", "booking_advance_days": 30,
//                 "cancellation_hours": 24, "emergency_available": false},
//    "busy": [{"start": "2026-11-24T10:00:00+09:00", "end": "2026-11-24T11:00:00+09:00"}],
//    "messages": [{"role": "user", "content": "Hi, can I book a haircut tomorrow?"}]}
// or plain text: one customer message (the business fields stay generic).
//
// Output: JSON {"ai_reply": "...", "booking": {...} or null}
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the short steps (name, what it
//      does, price or free), paste the link into "Agent code", and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// Author's system message, verbatim (n8n node "AI Receptionist").
const SYSTEM = "=# {{ $json['ai_name '] }} - {{ $json.business_name }} Virtual Receptionist\n\nYou are {{ $json['ai_name '] }}, the {{ $json.ai_personality }} virtual receptionist at **{{ $json.business_name }}**. Your role is to {{ $json.ai_role }}\n\n## BUSINESS ESSENTIALS\n\n**Type**: {{ $json[' business_type'] }}\n**Location**:  {{ $json[' location'] }}\n**Hours**:  {{ $json[' working_hours '] }}\n**Currency**: {{ $json.currency }}\n\n### Services & Pricing\n{{ $json.services }}\n\n## COMMUNICATION STYLE\n- **Tone**: {{ $json.ai_personality }}\n- **Length**: 2-3 sentences per response\n- **Approach**: Natural conversation, not robotic\n- **Use names**: Once provided, use customer's name\n\n## BOOKING WORKFLOW\n1. **Understand need**: Service type, timing preference\n2. **Check availability**: Use checkAvailability tool with business calendar\n3. **Gather details**: Name, phone number, email (optional)\n4. **Confirm booking**: Use bookAppointment tool\n5. **Save data**: Use captureCustomerData and saveAppointment tools\ntime now: {{ $now }}\n\n## KEY GUIDELINES\n\n### ✅ DO\n- Welcome warmly: \"Hello! I'm {{ $json['ai_name '] }} from {{ $json.business_name }}\"\n- Offer alternatives if requested time unavailable\n- Prioritize emergencies if emergency services available\n- Explain pricing clearly when asked\n- Use all available tools for complete booking process\n\n### ❌ DON'T\n- Book outside business hours\n- Repeat questions already answered\n- Ask for unnecessary personal information\n- Provide vague responses about availability\n\n## EMERGENCY PROTOCOL\n{% if $('Select Business Context').item.json.emergency_available %}\nEmergencies are available. Prioritize urgent requests and offer same-day slots when possible.\n{% endif %}\n\n## BUSINESS CONTEXT\n\n- Timezone: {{ $json['timezone '] }}\n- Advance booking limit:{{ $json[' booking_advance_days '] }}  days\n- Cancellation policy: {{ $json['cancellation_hours '] }} hours notice\n\n---\nProvide responses in this JSON format:\n{\n  \"ai_reply\": \"Your helpful and personalized response here\"\n}\n\n**Remember**: You're representing {{ $json.business_name }}. Be helpful, accurate, and maintain the professional standard they expect.";
const HISTORY_WINDOW = 15; // Conversation Memory contextWindowLength

// The template's sheet columns, exactly as its expressions name them (some
// headers carry stray spaces in the original sheet).
const FIELDS = {
  "{{ $json['ai_name '] }}": 'ai_name',
  '{{ $json.business_name }}': 'business_name',
  '{{ $json.ai_personality }}': 'ai_personality',
  '{{ $json.ai_role }}': 'ai_role',
  "{{ $json[' business_type'] }}": 'business_type',
  "{{ $json[' location'] }}": 'location',
  "{{ $json[' working_hours '] }}": 'working_hours',
  '{{ $json.currency }}': 'currency',
  '{{ $json.services }}': 'services',
  "{{ $json['timezone '] }}": 'timezone',
  "{{ $json[' booking_advance_days '] }}": 'booking_advance_days',
  "{{ $json['cancellation_hours '] }}": 'cancellation_hours',
};
const DEFAULTS = {
  ai_name: 'Ava', business_name: 'our business', ai_personality: 'friendly and professional',
  ai_role: 'answer questions and help customers book appointments', business_type: 'service business',
  location: '', working_hours: '', currency: 'USD', services: '', timezone: 'UTC',
  booking_advance_days: 30, cancellation_hours: 24, emergency_available: false,
};

const sub = (tpl, key, val) => tpl.split(key).join(val);

function buildSystem(biz) {
  let s = SYSTEM.replace(/^=/, '');
  for (const [expr, key] of Object.entries(FIELDS)) s = sub(s, expr, String(biz[key] ?? ''));
  s = sub(s, '{{ $now }}', new Date().toISOString());
  const block = /\{% if \$\('Select Business Context'\)\.item\.json\.emergency_available %\}\n([\s\S]*?)\{% endif %\}\n/;
  const on = biz.emergency_available === true || /^(true|yes|1)$/i.test(String(biz.emergency_available));
  return s.replace(block, (_, inner) => (on ? inner : ''));
}

function parseJson(text) {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function readInput(input) {
  const raw = String(input || '').trim();
  let p = null;
  try { p = JSON.parse(raw); } catch { /* plain text */ }
  if (!p || typeof p !== 'object') {
    return { biz: { ...DEFAULTS }, busy: [], history: [], message: raw };
  }
  const biz = { ...DEFAULTS, ...(p.business || {}) };
  const busy = Array.isArray(p.busy) ? p.busy : [];
  const msgs = (Array.isArray(p.messages) ? p.messages : [])
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const last = msgs.length ? msgs.pop() : { role: 'user', content: String(p.message || '') };
  return { biz, busy, history: msgs.slice(-HISTORY_WINDOW), message: last.content };
}

export async function handleMessage(input, providerConfig) {
  const { biz, busy, history, message } = readInput(input);
  if (!message) return JSON.stringify({ ai_reply: 'Please send the customer message to reply to.', booking: null });

  const tools = busy.length
    ? 'Calendar (busy slots, already booked):\n' + busy.map((b) => `- ${b.start} to ${b.end}`).join('\n')
    : 'Calendar: no busy slots were provided.';
  const prompt = [
    buildSystem(biz),
    '',
    '## THIS RUN',
    'The calendar and sheet tools are not connected. ' + tools,
    'Treat any time inside business hours that does not overlap a busy slot as available.',
    'When the customer has confirmed a booking, also add a "booking" object to your JSON with: customer_name, phone, email, service, start, end (ISO with timezone). Otherwise set "booking" to null.',
    '',
    '## CONVERSATION',
    ...history.map((m) => `${m.role === 'assistant' ? 'Receptionist' : 'Customer'}: ${m.content}`),
    `Customer: ${message}`,
    '',
    'Receptionist (JSON only):',
  ].join('\n');

  const model = getModelClient(providerConfig);
  const out = await model.complete(prompt);
  const j = parseJson(out);
  if (j && typeof j.ai_reply === 'string') {
    return JSON.stringify({ ai_reply: j.ai_reply, booking: j.booking ?? null });
  }
  return JSON.stringify({ ai_reply: String(out).trim(), booking: null });
}
