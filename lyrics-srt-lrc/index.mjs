// Lyrics to SRT + LRC: a Druve agent ported from Václav Čikl's n8n workflow
// "LyricsTranscribe" (his paid template https://n8n.io/workflows/9589,
// "Create .SRT subtitles & .LRC lyrics from audio with Whisper AI and
// GPT-5-nano"). Built from the full workflow export Václav sent on 24 Nov 2026.
// Listed on Druve only by Václav, under his own name.
//
// What it keeps, unchanged: the WhisperTranscribe request (whisper-1,
// response_format verbose_json, timestamp_granularities[] word), the
// PostProcessing prompt word for word, and the code of TimestampMatching,
// SubtitlesPreparation and "DiffMatch + SrcPrep" as Václav wrote it (only the
// n8n $('...') lookups are replaced by plain variables). The QualityCheck
// choice works as in the workflow: NO goes straight to subtitles; YES returns
// the transcribed lyrics for review, and the corrected lyrics are then aligned
// to the Whisper word timestamps by DiffMatch.
// What changes: no n8n form. The buyer sends the audio as base64 with their own
// OpenAI key, or pastes a Whisper verbose_json they already have. Results come
// back as text (both files) instead of file downloads.
//
// Input (JSON), one of:
//   {"audio_base64": "...mp3 as base64...", "openai_api_key": "sk-...", "quality_check": "NO"}
//   {"whisper": {...Whisper verbose_json with "words"...}, "quality_check": "YES"}
// Second step after quality_check YES:
//   {"whisper": {...the "whisper" object returned by step one...}, "corrected_lyrics": "line one\nline two"}
//
// Data-fetch host to declare when publishing: api.openai.com
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", declare api.openai.com, and publish.
// Each buyer uses their own OpenAI key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// PostProcessing system message, verbatim.
const POST_PROCESSING = "You are helping with preparing song lyrics for musicians. Take the following transcription and split it into lyric-like lines. Keep lines short (2–8 words), natural for singing/rap phrasing, and do not change the wording.";

// WhisperTranscribe, as in the workflow (the file arrives as base64 instead of a form upload).
async function whisperTranscribe(audioBase64, apiKey, filename) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(audioBase64, 'base64')], { type: 'audio/mpeg' }), filename || 'audio.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// TimestampMatching, Václav's code.
function timestampMatching(WhisperTranscribe, postProcessedText) {
  const words = WhisperTranscribe["words"];
  const lyrics = postProcessedText;

  const minWordMatchRatio = 0.7; // tolerance (0-1) for fuzzy matching per line
  const segments = lyrics.split(/\r?\n/).filter(l => l.trim().length > 0);
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9']/g, " ").trim();
  const whisperWords = words.map(w => ({
    ...w,
    norm: normalize(w.word)
  }));

  const result = [];

  let currentIndex = 0;
  for (const line of segments) {
    const lineWords = normalize(line).split(/\s+/).filter(Boolean);

    // Try to match this line to consecutive words from Whisper
    let startIndex = -1;
    let endIndex = -1;
    let matchCount = 0;

    for (let i = currentIndex; i < whisperWords.length; i++) {
      if (lineWords.includes(whisperWords[i].norm)) {
        if (startIndex === -1) startIndex = i;
        endIndex = i;
        matchCount++;
        if (matchCount / lineWords.length >= minWordMatchRatio) break;
      }
    }

    if (startIndex !== -1 && endIndex !== -1) {
      const start = whisperWords[startIndex].start;
      const end = whisperWords[endIndex].end;
      result.push({ start, end, text: line });
      currentIndex = endIndex + 1;
    } else {
      // fallback: if not found, approximate based on previous
      const prevEnd = result.length ? result[result.length - 1].end : words[0].start;
      const approxEnd = prevEnd + 2.5; // arbitrary 2.5s window
      result.push({ start: prevEnd, end: approxEnd, text: line });
    }
  }

  return { timedSegments: result };
}

// SubtitlesPreparation, Václav's code.
function subtitlesPreparation(timed, postProcessedText) {
  const plainText = postProcessedText;
  const segments = timed.timedSegments;

  function toSrtTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec * 1000) % 1000);
    return `${h.toString().padStart(2, "0")}:${m
      .toString()
      .padStart(2, "0")}:${s.toString().padStart(2, "0")},${ms
      .toString()
      .padStart(3, "0")}`;
  }

  function toLrcTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.floor((sec % 1) * 100); // centiseconds
    return `[${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")}.${cs.toString().padStart(2, "0")}]`;
  }

  // --- generate SRT ---
  let srt = "";
  segments.forEach((seg, i) => {
    const start = toSrtTime(seg.start);
    const end = toSrtTime(seg.end);
    srt += `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}\n\n`;
  });

  // --- generate LRC ---
  let lrc = "";
  segments.forEach(seg => {
    const time = toLrcTime(seg.start);
    lrc += `${time}${seg.text.trim()}\n`;
  });

  // --- return both ---
  return {
        srtContent: srt.trim(),
        lrcContent: lrc.trim(),
        segmentCount: segments.length,
        plainText
      };
}

// DiffMatch + SrcPrep, Václav's code (after the QualityCheck review).
function diffMatch(WhisperTranscribe, correctedLyrics) {
  // Načtení dat
  const words = WhisperTranscribe["words"];

  // Načtení upravených lyrics
  let lyricsText = correctedLyrics;

  // CLEANUP: Odstranění garbage na konci textu
  lyricsText = lyricsText.replace(/\t\d+\s*$/, '').trim();

  // Funkce pro normalizaci textu
  function normalizeWord(word) {
    return word
      .toLowerCase()
      .replace(/[.,!?;:"""''—-]/g, '')
      .trim();
  }

  // Funkce pro tokenizaci textu na slova
  function tokenize(text) {
    return text
      .replace(/\\n/g, ' ')
      .replace(/\n/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);
  }

  // Získání původního textu z words
  const originalText = words.map(w => w.word).join(' ');
  const originalWords = tokenize(originalText);
  const correctedWords = tokenize(lyricsText);

  // Levenshtein distance
  function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  // Alignment
  function alignWords(original, corrected, timestamps) {
    const m = original.length;
    const n = corrected.length;
  
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    const backtrack = Array(m + 1).fill(null).map(() => Array(n + 1).fill(null));
  
    for (let i = 0; i <= m; i++) dp[i][0] = i * -1;
    for (let j = 0; j <= n; j++) dp[0][j] = j * -1;
  
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const origNorm = normalizeWord(original[i - 1]);
        const corrNorm = normalizeWord(corrected[j - 1]);
      
        let matchScore = 0;
        if (origNorm === corrNorm) {
          matchScore = 2;
        } else {
          const dist = levenshtein(origNorm, corrNorm);
          const maxLen = Math.max(origNorm.length, corrNorm.length);
          if (maxLen > 0 && dist / maxLen < 0.3) {
            matchScore = 1;
          } else {
            matchScore = -1;
          }
        }
      
        const match = dp[i - 1][j - 1] + matchScore;
        const del = dp[i - 1][j] - 1;
        const ins = dp[i][j - 1] - 1;
      
        dp[i][j] = Math.max(match, del, ins);
      
        if (dp[i][j] === match) backtrack[i][j] = 'match';
        else if (dp[i][j] === del) backtrack[i][j] = 'delete';
        else backtrack[i][j] = 'insert';
      }
    }
  
    const alignment = [];
    let i = m, j = n;
  
    while (i > 0 || j > 0) {
      if (i === 0) {
        alignment.unshift({
          correctedWord: corrected[j - 1],
          originalIndex: null,
          timestamp: null,
          type: 'inserted'
        });
        j--;
      } else if (j === 0) {
        i--;
      } else {
        const action = backtrack[i][j];
      
        if (action === 'match') {
          alignment.unshift({
            correctedWord: corrected[j - 1],
            originalIndex: i - 1,
            timestamp: timestamps[i - 1],
            type: normalizeWord(original[i - 1]) === normalizeWord(corrected[j - 1]) ? 'match' : 'modified'
          });
          i--; j--;
        } else if (action === 'delete') {
          i--;
        } else {
          let interpolatedTimestamp = null;
          if (i > 0 && i < m) {
            const prevTimestamp = timestamps[i - 1];
            const nextTimestamp = timestamps[i];
            interpolatedTimestamp = {
              start: prevTimestamp.end,
              end: nextTimestamp.start
            };
          }
        
          alignment.unshift({
            correctedWord: corrected[j - 1],
            originalIndex: null,
            timestamp: interpolatedTimestamp,
            type: 'inserted'
          });
          j--;
        }
      }
    }
  
    return alignment;
  }

  const alignment = alignWords(originalWords, correctedWords, words);

  const alignedWords = alignment.map((item, index) => {
    return {
      word: item.correctedWord,
      start: item.timestamp?.start || null,
      end: item.timestamp?.end || null,
      type: item.type,
      originalIndex: item.originalIndex
    };
  });

  // ====================
  // GENEROVÁNÍ .LRC SOUBORU
  // ====================

  function formatLRCTime(seconds) {
    if (seconds === null || isNaN(seconds)) return '[00:00.00]';
    const minutes = Math.floor(seconds / 60);
    const secs = (seconds % 60);
    const secsStr = secs.toFixed(2).padStart(5, '0');
    return `[${String(minutes).padStart(2, '0')}:${secsStr}]`;
  }

  const lyricsLines = lyricsText
    .replace(/\\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const lrcLines = [];
  let wordIndex = 0;

  for (const line of lyricsLines) {
    const lineWords = tokenize(line);
  
    if (lineWords.length === 0) continue;
  
    let lineStart = null;
    let matchedWords = 0;
    const startWordIndex = wordIndex;
  
    for (let i = wordIndex; i < alignedWords.length && matchedWords < lineWords.length; i++) {
      const alignedWord = alignedWords[i];
      const normalizedAligned = normalizeWord(alignedWord.word);
      const normalizedLine = normalizeWord(lineWords[matchedWords]);
    
      if (normalizedAligned === normalizedLine) {
        if (lineStart === null && alignedWord.start !== null) {
          lineStart = alignedWord.start;
        }
        matchedWords++;
        wordIndex = i + 1;
      }
    }
  
    // Fallback pro missing timestamps
    if (lineStart === null) {
      if (lrcLines.length > 0) {
        const lastTime = lrcLines[lrcLines.length - 1].time;
        lineStart = lastTime + 2;
      } else {
        lineStart = 0;
      }
    }
  
    lrcLines.push({
      time: lineStart,
      text: line
    });
  }

  // Deduplikace timestampů v LRC
  const lrcLinesDeduped = [];
  const usedTimestamps = new Set();

  for (const line of lrcLines) {
    let adjustedTime = line.time;
    let offset = 0;
  
    while (usedTimestamps.has(adjustedTime.toFixed(2))) {
      offset += 0.01;
      adjustedTime = line.time + offset;
    }
  
    usedTimestamps.add(adjustedTime.toFixed(2));
    lrcLinesDeduped.push({
      time: adjustedTime,
      text: line.text
    });
  }

  lrcLinesDeduped.sort((a, b) => a.time - b.time);
  const lrcContent = lrcLinesDeduped
    .map(line => `${formatLRCTime(line.time)}${line.text}`)
    .join('\n');

  // ====================
  // GENEROVÁNÍ .SRT SOUBORU (VYLEPŠENO)
  // ====================

  function formatSRTTime(seconds) {
    if (seconds === null || isNaN(seconds)) return '00:00:00,000';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
  
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  const srtEntries = [];
  const MIN_DURATION = 0.8;  // Minimální délka titulku
  const MAX_DURATION = 5.0;  // Maximální délka titulku
  const CHARS_PER_SECOND = 20; // Rychlost čtení

  wordIndex = 0;

  for (let lineIdx = 0; lineIdx < lyricsLines.length; lineIdx++) {
    const line = lyricsLines[lineIdx];
    const lineWords = tokenize(line);
  
    if (lineWords.length === 0) continue;
  
    let lineStart = null;
    let lineEnd = null;
    let matchedWords = 0;
    let firstMatchIdx = null;
    let lastMatchIdx = null;
  
    // Najdeme všechna slova pro tento řádek
    for (let i = wordIndex; i < alignedWords.length && matchedWords < lineWords.length; i++) {
      const alignedWord = alignedWords[i];
      const normalizedAligned = normalizeWord(alignedWord.word);
      const normalizedLine = normalizeWord(lineWords[matchedWords]);
    
      if (normalizedAligned === normalizedLine) {
        if (firstMatchIdx === null) {
          firstMatchIdx = i;
        }
        lastMatchIdx = i;
      
        if (lineStart === null && alignedWord.start !== null) {
          lineStart = alignedWord.start;
        }
        if (alignedWord.end !== null) {
          lineEnd = alignedWord.end;
        }
        matchedWords++;
      }
    }
  
    // Posuneme wordIndex na konec matchů
    if (lastMatchIdx !== null) {
      wordIndex = lastMatchIdx + 1;
    }
  
    // Validace a úprava časů
    if (lineStart !== null && lineEnd !== null) {
      // Zajistíme že end > start
      if (lineEnd <= lineStart) {
        lineEnd = lineStart + MIN_DURATION;
      }
    
      let duration = lineEnd - lineStart;
      const textLength = line.length;
    
      // Výpočet ideální délky podle textu
      const idealDuration = Math.max(MIN_DURATION, textLength / CHARS_PER_SECOND);
    
      // Pokud je duration příliš krátká, prodloužíme
      if (duration < idealDuration) {
        lineEnd = lineStart + idealDuration;
        duration = idealDuration;
      }
    
      // Pokud je příliš dlouhá, zkrátíme
      if (duration > MAX_DURATION) {
        lineEnd = lineStart + MAX_DURATION;
        duration = MAX_DURATION;
      }
    
      // Kontrola překryvu s následujícím titulkem
      if (lineIdx < lyricsLines.length - 1) {
        // Najdeme start dalšího řádku
        let nextStart = null;
        const nextLine = lyricsLines[lineIdx + 1];
        const nextLineWords = tokenize(nextLine);
        let tempMatched = 0;
      
        for (let i = wordIndex; i < alignedWords.length && tempMatched < nextLineWords.length; i++) {
          const alignedWord = alignedWords[i];
          const normalizedAligned = normalizeWord(alignedWord.word);
          const normalizedNext = normalizeWord(nextLineWords[tempMatched]);
        
          if (normalizedAligned === normalizedNext) {
            if (nextStart === null && alignedWord.start !== null) {
              nextStart = alignedWord.start;
              break;
            }
          }
        }
      
        // Pokud by se překrýval s dalším, zkrátíme s malou mezerou
        if (nextStart !== null && lineEnd > nextStart - 0.1) {
          lineEnd = Math.max(lineStart + MIN_DURATION, nextStart - 0.1);
        }
      }
    
      // Finální validace
      if (lineEnd > lineStart && (lineEnd - lineStart) >= 0.1) {
        srtEntries.push({
          start: lineStart,
          end: lineEnd,
          text: line
        });
      }
    }
  }

  // Vytvoření SRT formátu
  const srtContent = srtEntries
    .map((entry, index) => {
      return `${index + 1}\n${formatSRTTime(entry.start)} --> ${formatSRTTime(entry.end)}\n${entry.text}\n`;
    })
    .join('\n');

  // ====================
  // STATISTIKY
  // ====================

  const stats = {
    totalOriginal: originalWords.length,
    totalCorrected: correctedWords.length,
    matched: alignment.filter(a => a.type === 'match').length,
    modified: alignment.filter(a => a.type === 'modified').length,
    inserted: alignment.filter(a => a.type === 'inserted').length,
    lrcLinesGenerated: lrcLinesDeduped.length,
    srtEntriesGenerated: srtEntries.length
  };

  return {
      alignedWords: alignedWords,
      stats: stats,
      correctedLyrics: lyricsText,
      lrcContent: lrcContent,
      srtContent: srtContent
    };
}

function files(srt, lrc, extra) {
  return [
    extra || '',
    '**lyrics.srt**', '```srt\n' + srt + '\n```',
    '**lyrics.lrc**', '```text\n' + lrc + '\n```',
  ].filter(Boolean).join('\n\n');
}

export async function handleMessage(input, providerConfig) {
  let p = null;
  try { p = JSON.parse(String(input || '')); } catch {}
  if (!p || typeof p !== 'object') {
    return 'Send JSON: {"audio_base64": "...", "openai_api_key": "...", "quality_check": "NO"} or {"whisper": {...verbose_json...}}. See the header of this file.';
  }

  let whisper = p.whisper || (Array.isArray(p.words) ? p : null);
  if (!whisper && p.audio_base64) {
    const key = p.openai_api_key || providerConfig?.apiKey;
    if (!key) return 'An OpenAI key is needed for Whisper: pass "openai_api_key".';
    try { whisper = await whisperTranscribe(p.audio_base64, key, p.filename); } catch (e) { return e.message; }
  }
  if (!whisper || !Array.isArray(whisper.words) || !whisper.words.length) {
    return 'No Whisper word timestamps found. Send the audio as "audio_base64", or a Whisper verbose_json with "words".';
  }

  // After the QualityCheck review: corrected lyrics go through DiffMatch.
  if (typeof p.corrected_lyrics === 'string' && p.corrected_lyrics.trim()) {
    const r = diffMatch(whisper, p.corrected_lyrics);
    const s = r.stats;
    return files(r.srtContent, r.lrcContent,
      `## Aligned your corrected lyrics: ${s.matched} words matched, ${s.modified} modified, ${s.inserted} inserted; ${s.srtEntriesGenerated} subtitles, ${s.lrcLinesGenerated} LRC lines.`);
  }

  // PostProcessing
  const model = getModelClient(providerConfig);
  const postProcessedText = String(await model.complete(`${POST_PROCESSING}\n\n${whisper.text || ''}`)).trim();

  // RoutingQualityCheck: YES returns the lyrics for review first.
  if (String(p.quality_check || 'NO').toUpperCase() === 'YES') {
    return [
      '## Transcribed lyrics, ready for your review',
      '```text\n' + postProcessedText + '\n```',
      'Correct anything you like, then send it back as "corrected_lyrics" together with this "whisper" object, and the subtitles are aligned to your text:',
      '```json\n' + JSON.stringify({ whisper: { text: whisper.text, words: whisper.words } }) + '\n```',
    ].join('\n\n');
  }

  const timed = timestampMatching(whisper, postProcessedText);
  const out = subtitlesPreparation(timed, postProcessedText);
  return files(out.srtContent, out.lrcContent, `## ${out.segmentCount} lines`);
}
