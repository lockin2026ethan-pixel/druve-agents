// Telegram E-commerce Support: a Druve agent ported by hand from the n8n
// template "Handle e-commerce support on Telegram with Gemini and Google Sheets"
// by Nirav Gajera (https://n8n.io/workflows/14550).
// Draft for Nirav to check. Listed on Druve only by Nirav, under his own name.
//
// What it keeps, unchanged: the "Customer Support AI Agent" system message word
// for word, the three Google Sheets tools and their descriptions (read all
// orders, update an order's Status by order_id, append a support ticket with
// ticket_id, name, order_id, query, summary, category, status "Pending",
// created_at and telegram_id), the /start welcome menu with its three buttons,
// "Extract Message" (text or button press, first name, chat id as the memory
// key) and "Prepare Reply" (the "Done!" fallback when the reply is empty).
// What changes: no always-on Telegram trigger. Each run either answers one
// message, or reads the bot's pending updates once and answers each of them,
// so the buyer runs it on their own schedule with the Druve CLI. Tool calls are
// made through a short JSON protocol instead of native function calling, and
// the chat memory is returned so it can be passed into the next run.
//
// Input (JSON):
//   One message: {"text": "Track my order", "first_name": "Sam", "chat_id": "123", "memory": {...}}
//   Bot inbox:   {"telegram_bot_token": "123:ABC", "offset": 0, "memory": {...}}
// Sheets (both modes): "google_access_token", "orders_sheet_id", optional "orders_tab" (default
//   "Sheet1"), "tickets_sheet_id" and "tickets_tab" (default "Sheet1") for the support sheet; without
//   them, tickets are returned in the output instead of written.
//   Without Google, pass "orders": [{order_id, customer_name, email, product, Status, date}] to try it;
//   changes and tickets are then returned instead of written.
// Plain text input is treated as one message.
//
// Data-fetch hosts to declare when publishing:
//   sheets.googleapis.com, api.telegram.org
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key and accounts.

import { getModelClient } from '@druve/cli/providers';

// "Customer Support AI Agent" system message, verbatim.
const systemMessage = (firstName, chatId) => `You are a friendly e-commerce customer support bot. The customer's name is ${firstName} and their Telegram chat ID is ${chatId}.

You have 3 tools available:
- **Tool: Read Orders Sheet** — reads ALL order rows. Use to find an order by order_id or email.
- **Tool: Update Order Status** — updates an order's Status column. Use to cancel orders.
- **Tool: Create Support Ticket** — appends a new ticket row to the support sheet.

---

## HOW TO HANDLE EACH INTENT

### "Track my order" / "order status":
1. Ask: "Please provide your Order ID or email address."
2. Call **Tool: Read Orders Sheet** — it returns all rows.
3. Filter rows to find where order_id or email matches what the user gave.
4. Reply with:
\`\`\`
📦 *Order Details*

🆔 Order ID: [order_id]
👤 Customer: [customer_name]
🛍 Product: [product]
⏳ Status: [Status]
📅 Date: [date]
\`\`\`
If not found: "❌ No order found. Please check your Order ID or email."

### "Cancel my order":
1. Ask for Order ID or email if not provided.
2. Call **Tool: Read Orders Sheet** to find the order.
3. Check the Status:
   - "Shipped" → "⚠️ Cannot cancel — order already shipped. Please contact support."
   - "Cancelled" → "ℹ️ This order is already cancelled."
   - Any other status → Ask: "⚠️ Are you sure you want to cancel Order [order_id] (Status: [Status])? Reply YES to confirm or NO to keep it."
4. On YES: Call **Tool: Update Order Status** with order_id and Status = "Cancelled". Then reply: "✅ Order [order_id] has been cancelled successfully."
5. On NO: "👍 No problem! Your order has not been cancelled."

### "Talk to support" / "I have an issue":
1. Ask for: Name, and their query/issue. Also ask for Order ID if relevant.
2. Once you have name + query, call **Tool: Create Support Ticket**.
3. After the tool call, YOU MUST reply with this message (replace the values):
   "🎫 *Support Ticket Created!*

✅ Thank you, [name]!

📋 *Your issue:* [one sentence summary]
🏷 *Category:* [Payment/Shipping/Product Issue/Other]

🎟 *Ticket ID:* [the ticket_id you used]

Our team will contact you soon. Type /start to go back to the menu."

---

## CRITICAL RULES
- After calling any tool, ALWAYS send a text reply to the user. Never end without a message.
- Never say "I have submitted" without also telling the user their ticket ID.
- Keep replies concise and friendly.
- Use Markdown formatting (*bold*, _italic_).
- If user greets or types something unclear, list the 3 options they can choose from.`;

const TOOL_DESCRIPTIONS = {
  "Tool: Read Orders Sheet": "Reads ALL rows from the orders Google Sheet. Returns all order data including order_id, customer_name, email, product, Status, date. Use this whenever you need to look up an order by order_id or email address.",
  "Tool: Update Order Status": "Updates the Status of an order in the orders sheet. Use this to cancel an order after user confirms. Provide the order_id and set Status to 'Cancelled'.",
  "Tool: Create Support Ticket": "Creates a new support ticket by appending a row to the support sheet. Use this after collecting customer name and query. Generate a unique ticket_id like TKT-XXXX (random 4 digits). Fill summary with a 1-sentence description. Set category to one of: Payment, Shipping, Product Issue, Other. Set status to Pending."
};

// How tools are called here (the template uses native tool calling).
const PROTOCOL = `TOOLS PROTOCOL
To call a tool, reply with ONLY one JSON object and nothing else:
{"tool": "Read Orders Sheet"}
{"tool": "Update Order Status", "order_id": "...", "Status": "Cancelled"}
{"tool": "Create Support Ticket", "ticket_id": "TKT-1234", "name": "...", "order_id": "", "query": "...", "summary": "...", "category": "Payment | Shipping | Product Issue | Other"}
You will then get the tool result and can call another tool or answer. When you answer the customer, reply with the message text only, not JSON.
Tool descriptions:
${Object.entries(TOOL_DESCRIPTIONS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;

// "Send Welcome Menu", verbatim.
const welcomeText = (firstName) => '👋 Hello *' + firstName + '*! Welcome to our Support Bot.\n\nHow can I help you today?';
const MENU = [
  [{ text: '📦 Track My Order', callback_data: 'Track my order' }],
  [{ text: '❌ Cancel My Order', callback_data: 'I want to cancel my order' }],
  [{ text: '🎫 Talk to Support', callback_data: 'I need to talk to support' }],
];
const DONE = '✅ Done! Is there anything else I can help you with? Type /start to see the main menu.';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
async function sheets(token, path, init = {}) {
  const res = await fetch(`${SHEETS}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Google Sheets HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function makeStore(p) {
  const token = p.google_access_token;
  const ordersId = p.orders_sheet_id;
  const ordersTab = p.orders_tab || 'Sheet1';
  const ticketsId = p.tickets_sheet_id;
  const ticketsTab = p.tickets_tab || 'Sheet1';
  const live = Boolean(token && ordersId);
  const local = { orders: (p.orders || []).map((o) => ({ ...o })), tickets: [], updates: [] };
  const readValues = async (id, tab) => (await sheets(token, `${encodeURIComponent(id)}/values/${encodeURIComponent(tab)}`)).values || [];
  return {
    live,
    local,
    async readOrders() {
      if (!live) return local.orders;
      const [header = [], ...rows] = await readValues(ordersId, ordersTab);
      return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
    },
    async updateStatus(orderId, status) {
      if (!live) {
        const o = local.orders.find((x) => String(x.order_id) === String(orderId));
        if (!o) return { updated: false, reason: 'order_id not found' };
        o.Status = status;
        local.updates.push({ order_id: orderId, Status: status });
        return { updated: true, order_id: orderId, Status: status };
      }
      const values = await readValues(ordersId, ordersTab);
      const header = values[0] || [];
      const idCol = header.indexOf('order_id');
      const stCol = header.indexOf('Status');
      if (idCol < 0 || stCol < 0) return { updated: false, reason: 'The sheet needs order_id and Status columns' };
      const rowIdx = values.findIndex((r, i) => i > 0 && String(r[idCol]) === String(orderId));
      if (rowIdx < 0) return { updated: false, reason: 'order_id not found' };
      const range = `${ordersTab}!${colLetter(stCol)}${rowIdx + 1}`;
      await sheets(token, `${encodeURIComponent(ordersId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [[status]] }) });
      return { updated: true, order_id: orderId, Status: status };
    },
    async createTicket(t) {
      if (!token || !ticketsId) { local.tickets.push(t); return { created: true, ...t }; }
      const existing = (await readValues(ticketsId, ticketsTab))[0] || [];
      const keys = Object.keys(t);
      if (existing.length && !existing.some((h) => keys.includes(h))) {
        return { created: false, reason: `The tickets sheet has none of the ticket columns (${keys.join(', ')}). Set "tickets_sheet_id" / "tickets_tab" to the support sheet.` };
      }
      const header = existing.length ? existing : keys;
      const rows = existing.length ? [header.map((h) => t[h] ?? '')] : [header, header.map((h) => t[h] ?? '')];
      await sheets(token, `${encodeURIComponent(ticketsId)}/values/${encodeURIComponent(ticketsTab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values: rows }) });
      return { created: true, ...t };
    },
  };
}

const extras = (store) => ({ ...(store.local.updates.length ? { order_changes: store.local.updates } : {}), ...(store.local.tickets.length ? { tickets: store.local.tickets } : {}) });

function parseTool(text) {
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (!s.startsWith('{')) return null;
  try { const j = JSON.parse(s); return j && typeof j.tool === 'string' ? j : null; } catch { return null; }
}

// One customer message through the agent, with memory (Simple Memory keyed by chat id).
async function answer(model, store, { chatId, text, firstName }, history) {
  const transcript = history.map((m) => `${m.role === 'user' ? 'Customer' : 'You'}: ${m.content}`).join('\n');
  let scratch = '';
  let output = '';
  for (let step = 0; step < 6; step++) {
    const prompt = `${systemMessage(firstName, chatId)}\n\n${PROTOCOL}\n\n${transcript ? `Conversation so far:\n${transcript}\n\n` : ''}Customer: ${text}${scratch}`;
    const reply = String(await model.complete(prompt)).trim();
    const call = parseTool(reply);
    if (!call) { output = reply; break; }
    let result;
    try {
      if (call.tool === 'Read Orders Sheet') result = await store.readOrders();
      else if (call.tool === 'Update Order Status') result = await store.updateStatus(call.order_id, call.Status || 'Cancelled');
      else if (call.tool === 'Create Support Ticket') {
        result = await store.createTicket({
          ticket_id: call.ticket_id || `TKT-${String(Math.floor(1000 + Math.random() * 9000))}`,
          name: call.name || firstName, order_id: call.order_id || '', query: call.query || text,
          summary: call.summary || '', category: call.category || 'Other', status: 'Pending',
          created_at: new Date().toISOString(), telegram_id: chatId,
        });
      } else result = { error: `Unknown tool ${call.tool}` };
    } catch (e) {
      result = { error: e.message };
    }
    scratch += `\n\nYou called: ${JSON.stringify(call)}\nTool result: ${JSON.stringify(result).slice(0, 12000)}`;
  }
  // "Prepare Reply".
  return output && output.trim() ? output : DONE;
}

async function telegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`Telegram ${method} HTTP ${res.status}: ${data.description || ''}`.trim());
  return data.result;
}

// "Extract Message".
function extract(u) {
  if (u.callback_query) return { chatId: String(u.callback_query.message.chat.id), text: String(u.callback_query.data || '').trim(), firstName: u.callback_query.from.first_name || 'there', callbackId: u.callback_query.id };
  if (u.message) return { chatId: String(u.message.chat.id), text: String(u.message.text || '').trim(), firstName: u.message.from.first_name || 'there' };
  return null;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { text: raw };
  const memory = p.memory && typeof p.memory === 'object' ? p.memory : {};
  const store = makeStore(p);
  const model = getModelClient(providerConfig);
  const remember = (chatId, user, bot) => {
    const h = (memory[chatId] = memory[chatId] || []);
    h.push({ role: 'user', content: user }, { role: 'assistant', content: bot });
    memory[chatId] = h.slice(-10); // n8n Simple Memory's default window: 5 exchanges
  };

  try {
    if (p.telegram_bot_token) {
      const updates = await telegram(p.telegram_bot_token, 'getUpdates', { offset: Number(p.offset) || 0, timeout: 0, allowed_updates: ['message', 'callback_query'] });
      const handled = [];
      let nextOffset = Number(p.offset) || 0;
      for (const u of updates) {
        nextOffset = Math.max(nextOffset, u.update_id + 1);
        const m = extract(u);
        if (!m || !m.text) continue;
        if (m.callbackId) { try { await telegram(p.telegram_bot_token, 'answerCallbackQuery', { callback_query_id: m.callbackId }); } catch { /* not needed for the reply */ } }
        if (m.text === '/start') {
          await telegram(p.telegram_bot_token, 'sendMessage', { chat_id: m.chatId, text: welcomeText(m.firstName), parse_mode: 'Markdown', reply_markup: { inline_keyboard: MENU } });
          handled.push({ chat_id: m.chatId, text: m.text, reply: 'welcome menu' });
          continue;
        }
        const reply = await answer(model, store, m, memory[m.chatId] || []);
        remember(m.chatId, m.text, reply);
        try {
          await telegram(p.telegram_bot_token, 'sendMessage', { chat_id: m.chatId, text: reply, parse_mode: 'Markdown' });
        } catch {
          // Markdown the model wrote can be rejected by Telegram; send it as plain text instead.
          await telegram(p.telegram_bot_token, 'sendMessage', { chat_id: m.chatId, text: reply });
        }
        handled.push({ chat_id: m.chatId, text: m.text, reply });
      }
      // Confirm the handled updates so the next run starts after them.
      if (updates.length) await telegram(p.telegram_bot_token, 'getUpdates', { offset: nextOffset, timeout: 0 });
      return JSON.stringify({ handled: handled.length, results: handled, next_offset: nextOffset, memory, ...extras(store) });
    }

    const m = { chatId: String(p.chat_id || 'local'), text: String(p.text || '').trim(), firstName: p.first_name || 'there' };
    if (!m.text) return JSON.stringify({ error: 'Send {"text": "..."} or {"telegram_bot_token": "..."}. See the header of this file.' });
    if (m.text === '/start') return JSON.stringify({ reply: welcomeText(m.firstName), buttons: MENU.map((r) => r[0].text) });
    const reply = await answer(model, store, m, memory[m.chatId] || []);
    remember(m.chatId, m.text, reply);
    return JSON.stringify({ reply, memory, ...extras(store) });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
