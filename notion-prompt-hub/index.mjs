// Notion Prompt Hub: a Druve agent ported by hand from the n8n template
// "AI prompt hub (Notion + ChatGPT): auto-find the right prompt with
// embeddings" by Yahor Dubrouski (https://n8n.io/workflows/11194).
// Draft for Yahor to check. Listed on Druve only by Yahor, under his own name.
//
// What it keeps, unchanged: the AI Agent system message word for word, the
// "Search a Prompt" tool description, the Hugging Face embeddings
// (intfloat/multilingual-e5-small feature extraction), the "Find a prompt"
// cosine similarity with MIN_SCORE 0.4, the embeddings sync ("Generate
// Checksum" with the author's own SHA-256 function word for word, so stored
// checksums still match, then "Prepare Update Body" chunks of 1900 characters
// into the Notion "Embeddings" and "Checksum" properties), and chat memory of
// 10 messages.
// What changes: no chat trigger, no Notion polling triggers and no webhook.
// Each run takes one message, searches the hub first (as the agent's rule
// says), and returns the reply plus the memory to pass into the next run.
// "sync": true refreshes stale embeddings before searching.
//
// Input (JSON):
//   {"message": "Write a cold email for a SaaS", "notion_token": "secret_...",
//    "notion_database_id": "2b3041f0...", "hf_token": "hf_...", "sync": false, "memory": [...]}
// The Notion database needs the properties "Prompt", "Embeddings" and "Checksum" (text).
// Without Notion, pass "prompts": ["...", "..."] with "hf_token" to search a pasted list.
// Plain text input is a message with no prompt hub.
//
// Data-fetch hosts to declare when publishing:
//   api.notion.com, router.huggingface.co
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the hosts above, and
// publish. It runs on each buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

// AI Agent system message, verbatim.
const SYSTEM = "You are an assistant connected to a Prompt Hub.\n\nFor every user message, follow this workflow:\n\n1. **Always first** call the tool `Search a Prompt` with the entire user message as `query`.\n2. If the tool returns a matching prompt (`notFound = false`):\n   - Do NOT answer the user yet.\n   - Show the found prompt to the user.\n   - Ask:  \n     **\"I found a saved prompt that matches your request. Do you want to use it?\"**\n   - Then wait for the user's confirmation.\n3. If the tool returns no prompt (`notFound = true`):\n   - Continue normally and answer the user's request with the model.\n   - Do not call the tool again until the next user message.\n\nNever skip the prompt search step. The first step for **every** user message is always a call to `Search a Prompt`.";

// "Search a Prompt" tool description, verbatim.
const TOOL_DESCRIPTION = "Find the most relevant saved prompt for the user’s message.\n\nUse this tool **for every user message**, even if the user does not explicitly ask to search for prompts.\n\nInput: a natural language query (the user message).\n\nOutput:\n- the best matching saved prompt,\n- a similarity score,\n- and a `notFound` flag.\n\nAlways call this tool first before generating any answer.\n";

const HF_URL = 'https://router.huggingface.co/hf-inference/models/intfloat/multilingual-e5-small/pipeline/feature-extraction';
const MIN_SCORE = 0.4; // tweak if needed

// "Generate Checksum": the author's SHA-256, verbatim.
function sha256(ascii) {
    function rightRotate(value, amount) {
        return (value >>> amount) | (value << (32 - amount));
    }

    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    const lengthProperty = 'length';
    const words = [];
    const asciiBitLength = ascii[lengthProperty] * 8;

    let hash = sha256.h = sha256.h || [];
    let k = sha256.k = sha256.k || [];
    let primeCounter = k[lengthProperty];

    const isPrime = num => {
        for (let i = 2, sqrt = Math.sqrt(num); i <= sqrt; i++) {
            if (num % i === 0) return false;
        }
        return true;
    };

    if (!primeCounter) {
        let candidate = 2;
        while (primeCounter < 64) {
            if (isPrime(candidate)) {
                hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
                k[primeCounter++] = (mathPow(candidate, 1/3) * maxWord) | 0;
            }
            candidate++;
        }
    }

    ascii += '\x80'; // append Ƈ' bit
    while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
    for (let i = 0; i < ascii[lengthProperty]; i++) {
        const j = ascii.charCodeAt(i);
        words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
    words[words[lengthProperty]] = asciiBitLength;

    for (let j = 0; j < words[lengthProperty];) {
        const w = words.slice(j, j += 16);
        const oldHash = hash.slice(0);

        for (let i = 16; i < 64; i++) {
            const a = w[i - 15];
            const b = w[i - 2];
            w[i] = (
                ((a >>> 7) ^ (a >>> 18) ^ (a >>> 3) ^ (a << 25) ^ (a << 14))
                + ((b >>> 17) ^ (b >>> 19) ^ (b >>> 10) ^ (b << 15) ^ (b << 13))
                + w[i - 7] + w[i - 16]
            ) | 0;
        }

        for (let i = 0; i < 64; i++) {
            const temp = (
                hash[7]
                + ((hash[4] >>> 6) ^ (hash[4] >>> 11) ^ (hash[4] >>> 25) ^ (hash[4] << 26) ^ (hash[4] << 21) ^ (hash[4] << 7))
                + ((hash[4] & hash[5]) ^ (~hash[4] & hash[6]))
                + k[i] + w[i]
            ) | 0;

            const temp2 = (
                ((hash[0] >>> 2) ^ (hash[0] >>> 13) ^ (hash[0] >>> 22) ^ (hash[0] << 30) ^ (hash[0] << 19) ^ (hash[0] << 10))
                + ((hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]))
            ) | 0;

            hash = [
                (temp + temp2) | 0,
                hash[0],
                hash[1],
                hash[2],
                (hash[3] + temp) | 0,
                hash[4],
                hash[5],
                hash[6]
            ];
        }

        for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }

    return hash.map(h =>
        ('00000000' + (h >>> 0).toString(16)).slice(-8)
    ).join('');
}

// Cosine similarity, as in "Find a prompt".
function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedText(hfToken, text) {
  const res = await fetch(HF_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Hugging Face HTTP ${res.status}: ${body.slice(0, 200)}`);
  return body; // kept as the raw string, as the template stores it
}

const plain = (prop) => (prop ? (prop.rich_text || prop.title || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('') : '');

async function notion(token, path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Notion HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function allPages(token, db) {
  const pages = [];
  let cursor;
  do {
    const data = await notion(token, `databases/${db}/query`, { method: 'POST', body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }) });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages.map((pg) => ({ id: pg.id, prompt: plain(pg.properties?.Prompt), embeddings: plain(pg.properties?.Embeddings), checksum: plain(pg.properties?.Checksum) }));
}

// "Generate Checksum" -> "If Embeddings Update Needed" -> "Get Embeddings" -> "Prepare Update Body" -> save.
async function sync(p, pages) {
  let updated = 0;
  for (const pg of pages) {
    if (!pg.prompt) continue;
    const newChecksum = sha256(pg.prompt);
    if (pg.checksum && pg.checksum === newChecksum && pg.embeddings) continue;
    const embeddingString = await embedText(p.hf_token, pg.prompt);
    const maxLen = 1900;
    const richText = [];
    for (let i = 0; i < embeddingString.length; i += maxLen) richText.push({ text: { content: embeddingString.slice(i, i + maxLen) } });
    await notion(p.notion_token, `pages/${pg.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { Embeddings: { rich_text: richText }, Checksum: { rich_text: [{ text: { content: newChecksum } }] } } }) });
    pg.embeddings = embeddingString;
    pg.checksum = newChecksum;
    updated++;
  }
  return updated;
}

// "Search a Prompt" -> "Find a prompt".
async function searchPrompt(p, query, pages) {
  const queryEmbedding = JSON.parse(await embedText(p.hf_token, query));
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) throw new Error('queryEmbedding is missing or empty');
  let best = null;
  for (const page of pages) {
    if (!page.prompt || !page.embeddings) continue;
    let embedding;
    try { embedding = JSON.parse(page.embeddings); } catch { continue; }
    if (!Array.isArray(embedding) || embedding.length === 0) continue;
    const score = cosineSimilarity(queryEmbedding, embedding);
    if (!best || score > best.score) best = { pageId: page.id, promptText: page.prompt, score };
  }
  if (!best || best.score < MIN_SCORE) return { prompt: null, notFound: true, score: best ? best.score : null };
  return { prompt: best.promptText, notFound: false, score: best.score, pageId: best.pageId };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { message: raw };
  const message = String(p.message || '').trim();
  if (!message) return JSON.stringify({ reply: 'Hi there! 👋\nMy name is JARVIS. How can I assist you today?' });
  const memory = Array.isArray(p.memory) ? p.memory : [];

  let search = { prompt: null, notFound: true, score: null, note: 'No prompt hub was given.' };
  let synced;
  try {
    let pages = null;
    if (p.notion_token && p.notion_database_id && p.hf_token) {
      pages = await allPages(p.notion_token, p.notion_database_id);
      if (p.sync) synced = await sync(p, pages);
    } else if (Array.isArray(p.prompts) && p.hf_token) {
      pages = [];
      for (const [i, text] of p.prompts.map(String).entries()) pages.push({ id: `pasted-${i + 1}`, prompt: text, embeddings: await embedText(p.hf_token, text) });
    }
    if (pages) search = await searchPrompt(p, message, pages);
  } catch (e) {
    search = { prompt: null, notFound: true, score: null, error: e.message };
  }

  const history = memory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const model = getModelClient(providerConfig);
  const reply = String(await model.complete(`${SYSTEM}\n\nTool "Search a Prompt" (${TOOL_DESCRIPTION.trim()})\nwas called with query = the user's message. Result: ${JSON.stringify({ prompt: search.prompt, notFound: search.notFound, score: search.score })}\n\n${history ? `Conversation so far:\n${history}\n\n` : ''}User: ${message}`)).trim();
  const nextMemory = [...memory, { role: 'user', content: message }, { role: 'assistant', content: reply }].slice(-10);
  return JSON.stringify({ reply, search, ...(synced !== undefined ? { embeddings_updated: synced } : {}), memory: nextMemory });
}
