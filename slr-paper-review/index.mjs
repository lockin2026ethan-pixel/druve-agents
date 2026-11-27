// SLR Paper Review: a Druve agent ported by hand from the n8n template
// "Automate systematic literature reviews with Google Drive, GPT-4, Gemini, Qdrant
// and Airtable" by Jannik Hiller (https://n8n.io/workflows/12827).
// Draft for Jannik to check. Listed on Druve only by Jannik, under his own name.
//
// What it keeps, unchanged: the "Cut of bibliography" code (cut at References /
// Bibliography / Works Cited / LITERATURVERZEICHNIS unless an Appendix follows),
// the "SLR Agent" system prompt word for word (4 inclusion and 4 exclusion
// criteria, PRISMA justification), the "If" rule (only Decision == "Included"
// goes on), the "Scoring Agent" system prompt word for word (mechanism class +
// 0-20 quality score), the routing of included papers to one of three
// collections by mechanism, and the Airtable rows exactly as the two Airtable
// nodes write them (same columns, Score 0 for excluded papers).
// What changes: no n8n credentials, no Google Drive download/move and no Qdrant
// embeddings. The buyer pastes the paper text (from the PDF) and gets the
// decision, score and the collection it belongs in back as JSON. Airtable
// logging runs only when an Airtable token, base and table are given.
// The criteria are the author's (LLM self-improvement and debate mechanisms);
// a buyer reviewing another topic can pass their own prompts (see Input).
//
// Input: plain text = one paper's full text. Or JSON:
//   {"text": "full paper text", "title": "...", "author": "...", "creator": "...", "metadata": {...}}
//   {"papers": [ {"text": "..."}, {"text": "..."} ]}
// Optional: "slr_prompt": "...", "scoring_prompt": "..." (replace the author's criteria),
//           "airtable_token": "pat...", "airtable_base": "app...", "airtable_table": "tbl... or table name".
//
// Data-fetch host to declare when publishing:
//   api.airtable.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare the host above, and
// publish. It runs on each buyer's own model key and accounts.

import { getModelClient } from '@druve/cli/providers';

// "SLR Agent" system message, verbatim.
const SLR_SYSTEM = "### ROLE You are a strict academic reviewer conducting a Systematic Literature Review (SLR) on \"LLM Self-Improvement and Debate Mechanisms\". Your ONLY task is to strictly filter the provided paper based on the defined Inclusion Criteria (IC) and Exclusion Criteria (EC).  \n\n### INCLUSION CRITERIA (IC) - Reject if ANY are missing or incomplete: - **IC 1: Technisches Protokoll & Transparenz:** Das Paper muss nicht nur das Base LLM nennen, sondern auch dessen spezifische Version (z. B. GPT-4-Turbo-1106-preview) sowie mindestens einen zentralen Hyperparameter wie die Temperatur angeben. Ohne diese Angaben ist die Validität für einen methodischen Vergleich nicht gegeben. - **IC 2: Spezifikation der Verbesserungsschleife (Intervention):** Die Studie muss die Architektur des Self-Improvement-Mechanismus (z. B. Feedback-Zyklus, Prompt-Chaining oder Multi-Agent-Interaktion) so detailliert beschreiben, dass der Prozess methodisch nachvollziehbar ist. - **IC 3: Komparative Evidenz gegen Baselines (Comparison):** Das Paper muss die Ergebnisse des Self-Improvement-Mechanismus explizit gegen eine definierte Baseline (z. B. Standard Zero-Shot oder Single-Agent Chain-of-Thought) vergleichen. Rein isolierte Leistungswerte ohne Vergleichsbasis reichen nicht aus. - **IC 4: Verwendung anerkannter Benchmarks (Outcomes):** Die Evaluation muss auf standardisierten Datensätzen (z. B. GSM8K, MMLU, QuALITY) oder wissenschaftlich fundierten Metriken (z. B. Elo-Rating, Accuracy, Performance Gap Recovered) basieren. \n\n ### EXCLUSION CRITERIA (EC) - Reject if ANY are met: - **EC 1: Mangelnde Bias-Kontrolle:** Studien, die bekannte KI-Verzerrungen wie den Positional Bias (Antwortreihenfolge) oder Verbosity Bias (bevorzugt längere Antworten) ignorieren oder keine Gegenmaßnahmen (z. B. Swapping Answers, Word Limits) dokumentieren, werden aufgrund mangelnder Qualität ausgeschlossen. - **EC 2: Fehlender Fokus auf die interne Iteration:** Schließe Paper aus, die LLMs lediglich als statische Werkzeuge nutzen, ohne eine interne Feedback- oder Reflexionsschleife zu implementieren, in der das Modell seine eigene Ausgabe bewertet oder modifiziert. - **EC 3: Unzureichende Datenextraktion (Ambiguity):** Studien, deren Ergebnisse zu vage dargestellt sind oder bei denen die Datenextraktion zu zweideutig ist, um den tatsächlichen Effekt der Intervention zu bestimmen, müssen ausgeschlossen werden. - **EC 4: Redundante Publikationen:** Sollten mehrere Versionen derselben Studie vorliegen, wird nur die vollständigste Version (i. d. R. das Journal-Paper) eingeschlossen.  ### TASK 1. Analyze the full paper text thoroughly. 2. Evaluate against every single IC and EC. 3. Check ICs: If ANY IC is not fully met -> EXCLUDE (State exactly which IC failed). 4. Check ECs: If ANY EC is met -> EXCLUDE (State exactly which EC was triggered). 5. Final Decision: Only if ALL ICs are met AND NO ECs are met -> INCLUDE. 6. PRISMA Documentation: For every excluded paper, provide a one-sentence justification based on the criteria (e.g., \"Excluded based on IC 4: No specific Base LLM mentioned\").  ### OUTPUT FORMAT Return ONLY a valid JSON object.  {   \"DOI\": \"Extracted DOI or 'Not Found'\",   \"Author\": \"Extracted Authors\",   \"Titel\": \"Extracted Title\",   \"Decision\": \"Included\" OR \"Excluded\",   \"Decision Reasoning\": \"Strict PRISMA justification. MUST start with the criteria ID if excluded (e.g., 'Excluded based on IC 1: ...' or 'Excluded based on EC 2: ...'). If Included, write 'Passed all criteria'.\" }";

// "Scoring Agent" system message, verbatim.
const SCORING_SYSTEM = "### ROLE You are an expert academic reviewer. The provided paper has already passed the strict inclusion criteria. Your task is now to perform a \"Full Text Review\", classify the mechanism used, and calculate a quality score (0-20 points).  ### MECHANISM CLASSIFICATION Analyze which of the following three categories best describes the core mechanism of the paper. Choose the ONE that fits best:  1. **Self-Referential Prompting**    (Definition: Models autonomously generate new prompts or modify existing inputs based on their own outputs.) 2. **Reflective Evaluation**    (Definition: Models evaluate and critique their own answers, typically through explicit \"Reflection Prompts\" or external feedback loops.) 3. **Iterative Self-Correction / Debate Mechanismen**    (Definition: Models use dialogue-based structures, e.g., Multi-Agent Debates, to generate competing answers, compare them, and converge on a better result.)  ### SCORING RULES Evaluate the paper against the 10 criteria below. Rate each criterion on a scale of **0 to 2**: - **2 Points:** Vollständig erfüllt / klar dokumentiert. - **1 Point:** Teilweise erfüllt / unklar dargestellt. - **0 Points:** Nicht vorhanden / unzureichend.  ### QUALITY CHECKLIST (Criteria)  **Teil A: Methodische Validität (Grundlagen)** 1. **Klarheit des Mechanismus:** Beschreibt das Paper den Self-Improvement-Prozess (z. B. Feedback-Schleife, Rollen im Debate) so detailliert, dass er theoretisch replizierbar ist? 2. **Angemessenheit der Baseline:** Wird die Methode gegen anerkannte Baselines (z. B. Zero-shot, Standard CoT) verglichen, um den tatsächlichen Mehrwert zu belegen? 3. **Güte der Validierung:** Wurde die Methode an mehr als einem Datensatz oder mit verschiedenen Modell-Familien (z. B. GPT-4 und Llama) getestet?  **Teil B: Technische Präzision (KI-Spezifika)** 4. **Modell-Transparenz (Kern-Parameter):** Wird nicht nur das Basis-Modell, sondern auch die spezifische Version (z. B. GPT-4-1106-preview) genannt? 5. **Hyperparameter-Dokumentation:** Werden sekundäre Parameter wie Temperatur, Top-P oder der Seed angegeben, um die Varianz der Ergebnisse einzuordnen? 6. **Iterations-Protokoll:** Wird die Anzahl der Verbesserungsschritte (N) oder das Abbruchkriterium der Schleife exakt definiert?  **Teil C: Bias-Kontrolle & Ergebnisqualität** 7. **Minderung von Richter-Bias:** Wurden Maßnahmen gegen Positional Bias (z. B. durch Swapping Answers) oder Verbosity Bias (z. B. durch strikte Wortlimits) ergriffen? 8. **Metrische Präzision:** Werden präzise und vergleichbare Metriken wie Accuracy, Performance Gap Recovered (PGR) oder Elo-Ratings verwendet? 9. **Statistische Belastbarkeit:** Gibt das Paper Konfidenzintervalle, Standardabweichungen oder Ergebnisse über mehrere Testläufe an? 10. **Praktischer Mehrwert:** Bietet die Studie konkrete „Best Practices“ oder Empfehlungen für die Entwicklung autonomer, agentischer Systeme?  ### TASK 1. Analyze the full text deeply. 2. Extract the meta-data (DOI, Author, Title). 3. **Classify the paper** into exactly one of the 3 defined Mechanisms. 4. Generate a concise Abstract (max 3 sentences). 5. Score the paper on all 10 criteria (Sum = 0-20). 6. Formulate a \"Decision Reasoning\": Summarize strengths/weaknesses.  ### OUTPUT FORMAT Return ONLY a valid JSON object matching this schema exactly:  {   \"DOI\": \"Extracted DOI string or 'Not Found'\",   \"Author\": \"Extracted Authors\",   \"Titel\": \"Extracted Title\",   \"Mechanism\": \"Strictly one of: 'Self-Referential Prompting', 'Reflective Evaluation', or 'Iterative Self-Correction / Debate Mechanismen'\",   \"Abstract\": \"Summary of content (max 3 sentences)\",   \"Decision\": \"Included\",   \"Decision Reasoning\": \"Detailed summary of strengths/weaknesses based on the checklist scores.\",   \"Score\": Integer between 0 and 20,   \"Additional notes\": \"Optional observations or empty string\" }";

const MECHANISMS = [
  'Self-Referential Prompting',
  'Reflective Evaluation',
  'Iterative Self-Correction / Debate Mechanismen',
];

// n8n renders an object inside {{ }} as JSON text.
const show = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// "Cut of bibliography", the author's code for one item.
function cutBibliography(json) {
  const inputFieldName = 'text';
  if (!json.info) json.info = {};
  if (!json.info.Custom) json.info.Custom = {};
  if (!json.metadata) json.metadata = {};
  let content = '';
  if (json[inputFieldName]) {
    content = json[inputFieldName];
    const cutOffWords = ['References', 'Bibliography', 'Works Cited', 'LITERATURVERZEICHNIS'];
    const protectedWords = ['Appendix', 'Appendices', 'Anhang'];
    let cutIndex = -1;
    let foundWord = '';
    for (const word of cutOffWords) {
      const regex = new RegExp(`\\n\\s*${word}`, 'i');
      const match = content.match(regex);
      if (match) {
        if (cutIndex === -1 || match.index < cutIndex) {
          cutIndex = match.index;
          foundWord = word;
        }
      }
    }
    let isSafeToCut = true;
    if (cutIndex > -1) {
      const textAfterCut = content.substring(cutIndex);
      for (const safeWord of protectedWords) {
        const safeRegex = new RegExp(`\\n\\s*${safeWord}`, 'i');
        if (textAfterCut.match(safeRegex)) {
          isSafeToCut = false;
          break;
        }
      }
      if (isSafeToCut) content = content.substring(0, cutIndex);
    }
    json.cleaning_status = cutIndex > -1
      ? (isSafeToCut ? `Cut at ${foundWord}` : 'Kept References because Appendix was found')
      : 'Nothing to cut found';
  } else {
    json.cleaning_status = 'No text content available';
  }
  json.text_cleaned = content;
  return json;
}

function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// Like n8n's Structured Output Parser with autoFix: ask once more for valid JSON.
async function structured(model, prompt) {
  const first = await model.complete(prompt);
  let o = parseJson(first);
  if (!o) o = parseJson(await model.complete(`${prompt}\n\nYour previous answer was not valid JSON. Return ONLY the JSON object.`));
  return o || { error: 'The model did not return valid JSON.', raw: String(first).slice(0, 500) };
}

async function airtableCreate(p, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${encodeURIComponent(p.airtable_base)}/${encodeURIComponent(p.airtable_table)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.airtable_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return 'logged';
}

async function reviewOne(model, p, paper) {
  const json = cutBibliography({
    text: String(paper.text || ''),
    info: { Author: paper.author, Creator: paper.creator, Title: paper.title, Custom: paper.custom },
    metadata: paper.metadata,
  });
  if (!json.text_cleaned.trim()) return { error: 'No paper text given.', cleaning_status: json.cleaning_status };

  // "SLR Agent" text, verbatim layout.
  const slrText = `This is the paper: \n ${show(json.info.Author)}\n${show(json.info.Creator)}\n${show(json.info.Title)}\n${show(json.metadata)}\n${json.text_cleaned}\n\n\n`;
  const slr = await structured(model, `${p.slr_prompt || SLR_SYSTEM}\n\n${slrText}`);
  const out = { cleaning_status: json.cleaning_status, screening: slr };

  if (slr.error) return { ...out, decision: null, error: 'Screening failed: the model did not return valid JSON. Try again or use a stronger model.' };

  const log = p.airtable_token && p.airtable_base && p.airtable_table;

  // "If": Decision equals "Included" (case-sensitive).
  if (slr.Decision !== 'Included') {
    out.decision = 'Excluded';
    if (log) {
      // "Log Excluded Paper" columns.
      try {
        out.airtable = await airtableCreate(p, {
          DOI: slr.DOI, Score: 0, Titel: slr.Titel, Author: slr.Author,
          Abstract: slr.Abstract, Decision: slr.Decision,
          'Additional notes': slr['Additional notes'], 'Decision Reasoning': slr['Decision Reasoning'],
        });
      } catch (e) { out.airtable = `error: ${e.message}`; }
    }
    return out;
  }

  // "Scoring Agent" text, verbatim layout.
  const scoreText = `This is the Paper:  ${show(json.info.Custom)}\n${show(json.metadata)}\n${json.text_cleaned}\n`;
  const scored = await structured(model, `${p.scoring_prompt || SCORING_SYSTEM}\n\n${scoreText}`);
  out.decision = 'Included';
  out.scoring = scored;
  // "Route to sub topic": one collection per mechanism (exact match, as in n8n).
  const idx = MECHANISMS.indexOf(scored.Mechanism);
  out.collection = idx === -1 ? null : { number: idx + 1, mechanism: MECHANISMS[idx] };
  if (log) {
    // "Log Included folder" columns.
    try {
      out.airtable = await airtableCreate(p, {
        DOI: scored.DOI, Score: scored.Score, Titel: scored.Titel, Author: scored.Author,
        Abstract: scored.Abstract, Decision: 'Included', Mechanism: scored.Mechanism,
        'Score Reasoning': scored['Decision Reasoning'],
        'Additional notes': slr['Additional notes'], 'Decision Reasoning': slr['Decision Reasoning'],
      });
    } catch (e) { out.airtable = `error: ${e.message}`; }
  }
  return out;
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object') p = raw ? { text: raw } : {};
  const papers = Array.isArray(p.papers) ? p.papers : p.text ? [p] : [];
  if (!papers.length) return JSON.stringify({ error: 'Paste a paper\'s full text, or send {"papers": [{"text": "..."}]}. See the header of this file.' });

  const model = getModelClient(providerConfig);
  const results = [];
  for (const paper of papers.slice(0, 20)) results.push(await reviewOne(model, p, paper));
  return JSON.stringify(papers.length === 1 ? results[0] : { reviewed: results.length, results });
}
