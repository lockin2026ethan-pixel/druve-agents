// Gemini Chat + Image Prompt Assistant: a Druve agent ported by hand from the
// n8n template "Conversational AI Chatbot with Google Gemini for Text & Image |
// Telegram" by Alan Bajaña Granizo (https://n8n.io/workflows/4365). Draft for
// Alan to check. Nothing is published.
//
// What it keeps, unchanged: the inputProcessor prompt (intention + data type,
// with the last exchange as context, built like the latestContext node), the
// three branch prompts (generatePrompt, chatPrompt, otherPrompt), the ChatCore
// system message and user message, the errorPreprocessor sentence and the
// textCleaner clean-up. ChatCore still answers text in Spanish, as written.
// What changes: Druve agents return text, so for an image request it returns
// the cleaned image prompt (the exact text the template sends to Gemini's
// image model) for the buyer to paste into an image tool.
// What it leaves out: Telegram in and out, and the memory store. Pass the
// conversation in as JSON to keep context.
//
// Input, either JSON with the conversation so far:
//   {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}, ...]}
// or plain text: a single message.
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// Author's prompts, verbatim.
const INPUT_PROCESSOR = "1. Context\nYou are an intelligent assistant designed to analyze user requests accurately by considering both the current user input and prior conversation history (if available). Use this context to improve classification and response relevance. Only classify as \"generate\" if the request clearly meets all criteria. Never assume without certainty.\n\n2. General instructions\n- Use prior conversation history, if available, to interpret references, refinements, or corrections in the user’s message. \n- Apply updates directly when a previous request is being modified (e.g., changing part of a generated image).\n- Maintain context continuity unless the user explicitly shifts the topic.\n- When evaluating intention, prioritize the most recent relevant message to avoid using outdated context.\n- If the message is vague, nonsensical, or overly brief (e.g., a single word), do not classify it as \"generate\". Even if image requests occurred earlier. Only proceed if the current input clearly meets all criteria. Default to \"other\" unless the message includes clear direction.\n\n3. User Request: \"{{ $('sessionData').item.json.Mensaje }}\"\n\n4. Conversation history:\n{{ $json.messages}}\n\n5. Intentions\nClassify the user's intention as exactly one of the following:\n- \"generate\": user requests the direct creation of new visual content (e.g., images or art) to be delivered. This includes implicit requests for physical or tangible objects (e.g., \"give me a pet\"), but only if the message contains clear intent or is supported by prior context. Single-word or vague inputs without clear directive or context should not be treated as generate.\n- \"chat\": user engages in meaningful conversational interaction, including requests to generate textual prompts, explanations, or dialogue that have clear context and intent.\n- \"other\": request does not fit into the above categories, or involves content that is restricted, inappropriate, irrelevant, nonsensical, or lacks clear context or intent distinct from conversational engagement.\n\n6. Data types\nWhen analyzing the user’s message, determine whether a request for a physical or tangible object should be interpreted as a visual content request. In general, treat requests for tangible items as image generation unless the context explicitly suggests otherwise. For intangible content, respond with text unless the user clearly asks for an image.\n\nBased on the intention and content of the request, select exactly one data type to return:\n\n- \"text\": a textual response such as an answer, explanation, dialogue, or prompt text.\n- \"image\": a visual response explicitly or implicitly requested as image generation.\n\nAssign \"image\" as typeData only if the intention is \"generate\". In all other cases, including when the intention is \"other\", assign \"text\".\n\n7. Output format\nRespond only with a JSON object in this exact format, with no additional text or explanation: {\"intention\": \"value\", \"typeData\": \"value\"}";
const PROMPTS = {
  generate: "1.  General instructions\nCreate a prompt that generates only one response with no comments and no line breaks. Based on the input provided, generate a detailed visual description of the request in a clear and coherent manner. Avoid using quotation marks, apostrophes, or any other punctuation marks.\n\n2. Visual specifications\n- Composition: maintain a balanced and harmonious layout where all elements (images, shapes, and text) work together seamlessly. Ensure that no part of the image feels overcrowded, and the design directs the viewer’s attention naturally. Use a minimalistic approach, avoiding excessive detail or distractions.\n\n- Color palette: choose a color scheme that complements the overall theme and enhances the mood. The colors should be visually pleasing and work together harmoniously. Use no more than 3-4 main colors to maintain simplicity and coherence, ensuring they do not overpower the design.\n\n- Visual clarity: the image should be crisp and clear, with all elements legible and easy to interpret. Avoid blurry or pixelated visuals. Maintain sharp contrasts between key elements for emphasis and visual clarity.\n\n- Image size and resolution: the image should be sized to fit standard display requirements (e.g., social media, web posts). Ensure the resolution is high enough for clarity on both desktop and mobile devices. The image must maintain visual quality without losing sharpness or details when viewed on different screens.\n\n- Aesthetic appeal: aim for a design that is not only functional but also visually appealing. The overall style should be modern, clean, and aesthetically pleasing, with a consistent look that aligns with the intended mood or message. Ensure the design is pleasing to the eye, evoking the intended response from the viewer.\n\n- Visual balance: ensure the elements in the image are well-spaced, with no part feeling too heavy or too light. Create a natural flow of focus, guiding the viewer’s eye through the composition without distraction.",
  chat: "1. Rules\n- Communicate formally, clearly, and respectfully at all times.\n- Be concise and precise, avoiding unnecessary details.\n- Maintain a positive, professional tone as a reliable and knowledgeable assistant.\n- Respect user boundaries and refrain from engaging in prohibited or inappropriate topics.\n- Keep the conversation engaging by encouraging user participation, but when requesting clarification or additional information, ask only one focused question at a time to avoid overwhelming the user. Avoid abrupt endings to the dialogue.\n- Follow user instructions precisely.\n- Do not include any additional text or explanations unless explicitly requested.\n\n2. Response instructions\n- Analyze the message and conversation history to maintain context and continuity.\n- If repetition is requested, return the message exactly as provided. Otherwise, respond clearly and appropriately based on intent and context.\n- If the message is vague, suggest an interpretation and ask for clarification while keeping the conversation active.",
  other: "1. Rules\n- Communicate formally, clearly, and respectfully at all times.\n- Be concise and precise, avoiding unnecessary details.\n- Maintain a positive, professional tone as a reliable and knowledgeable assistant.\n- Respect user boundaries and refrain from engaging in prohibited or inappropriate topics.\n- Keep the conversation engaging by encouraging user participation, but when requesting clarification or additional information, ask only one focused question at a time to avoid overwhelming the user. Avoid abrupt endings to the dialogue.\n- Follow user instructions precisely.\n- Do not include any additional text or explanations unless explicitly requested.\n\n2. General Instructions\n- If a message is unclear or lacks details, respond with your best understanding as a suggestion, and politely ask the user to confirm or provide more details if it is not what they meant.\n- If the request is inappropriate or irrelevant, respond politely and clearly refuse, maintaining respect and professionalism, and invite a valid request.\n- Always follow the established rules to maintain professionalism and accuracy.",
};
const CORE_SYSTEM = "You are a professional enterprise chatbot designed to assist users with clear, respectful, and accurate communication. You provide informative text responses and generate images only upon explicit user requests. Utilize available conversation history to maintain context and coherence. Adhere strictly to company rules to ensure appropriate and secure interactions.\n\nYou can chat with me to get answers and create custom images based on your instructions.\n\nPrioritize the most recent relevant message if multiple prior references exist. Always respond in Spanish when providing text-based chat replies. For image generation requests, respond in English. Keep responses as short as possible without compromising clarity or natural interaction. Do not force interaction with the user beyond what is necessary to respond clearly.";
const CORE_USER = "Input from user: {{ $('sessionData').item.json.Mensaje }}\n\n{{ $json.prompt }}\n\nRespond only with the exact text requested, strictly following the instructions above. ";
const IMAGE_SUFFIX = " It is mandatory to add a description of the image you are going to make.";
const HISTORY_WINDOW = 10; // conversationMemory contextWindowLength

const sub = (tpl, key, val) => tpl.split(key).join(val);

function parseJson(text) {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function readInput(input) {
  const raw = String(input || '').trim();
  try {
    const p = JSON.parse(raw);
    if (p && Array.isArray(p.messages) && p.messages.length) {
      const msgs = p.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
      const last = msgs.pop();
      return { message: last.content, history: msgs };
    }
  } catch {}
  return { message: raw, history: [] };
}

// latestContext: the author's logic, on the last human/ai pair.
function latestContext(history) {
  const pairs = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') pairs.push({ human: history[i].content, ai: (history[i + 1] && history[i + 1].role === 'assistant') ? history[i + 1].content : '' });
  }
  if (!pairs.length) return '';
  const selected = pairs.length === 1 ? [pairs[0]] : pairs.slice(-1);
  return selected.map((msg, idx) => `Message ${idx + 1}:\nhuman: ${msg.human.split('\n')[0]}\nai: ${msg.ai.replace(/\n+$/, '')}`).join('\n\n');
}

// textCleaner: the author's code.
const clean = (s) => s.replace(/[\n\r\t]/g, ' ').replace(/['"\\]/g, '').replace(/\s+/g, ' ').trim();

export async function handleMessage(input, providerConfig) {
  const v = readInput(input);
  if (!v.message) return 'Send a message, or JSON like {"messages": [{"role": "user", "content": "..."}]} to keep the conversation going.';
  const model = getModelClient(providerConfig);

  // inputProcessor -> intentHandler
  const ip = sub(sub(INPUT_PROCESSOR, "{{ $('sessionData').item.json.Mensaje }}", v.message), '{{ $json.messages}}', latestContext(v.history));
  let route = null;
  for (let attempt = 0; attempt < 2 && !route; attempt++) {
    const o = parseJson(await model.complete(ip));
    if (o && typeof o.intention === 'string') route = o;
  }
  const intention = route && ['generate', 'chat', 'other'].find((k) => route.intention.includes(k)) || 'other';
  const typeData = intention === 'generate' && route && String(route.typeData).includes('image') ? 'image' : 'text';

  // buildPrompt -> ChatCore (with conversation memory)
  const history = v.history.slice(-HISTORY_WINDOW).map((m) => `${m.role === 'user' ? 'Human' : 'AI'}: ${m.content}`).join('\n');
  const user = sub(sub(CORE_USER, "{{ $('sessionData').item.json.Mensaje }}", v.message), '{{ $json.prompt }}', PROMPTS[intention]);
  const core = String(await model.complete(`${CORE_SYSTEM}\n\n${history ? `Conversation history:\n${history}\n\n` : ''}---\n\n${user}`)).trim();

  if (typeData !== 'image') return core;
  // contentType = image -> errorPreprocessor -> textCleaner
  const imagePrompt = clean(core + IMAGE_SUFFIX);
  return `**Image prompt** (paste into Gemini or any image model):\n\n\`\`\`text\n${imagePrompt}\n\`\`\``;
}
