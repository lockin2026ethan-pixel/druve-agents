// PII-Safe AI Chat: a Druve agent ported by hand from the n8n template
// "AI privacy-minded router: PII detection for privacy, security, & compliance"
// by Charles Oh (https://n8n.io/workflows/5874).
// Draft for Charles to check. Listed on Druve only by Charles, under his own name.
//
// What it keeps, unchanged: the "Enhanced PII Pattern Analyzer" word for word
// (all ten PII patterns with their confidence, severity and mask settings, the
// four context patterns, the masking function, the risk score, highest
// severity, routing rules and reasons, data classification and compliance
// flags), and the audit entry of the "Compliance & Audit Logger" (no PII in it).
// The model only ever sees the masked message when PII is found, as the
// template's "AI Agent [Private]" does.
// What changes: Druve gives the agent one model, the buyer's own. The template
// sends PII messages to a local Ollama model and clean ones to the cloud. Here,
// clean messages go to the buyer's model as they are; PII messages go masked;
// and messages with critical PII (SSN, card number, medical id) are not sent at
// all unless the buyer says their model runs locally ("model_is_local": true).
// No chat memory and no monitoring dashboard.
//
// Input: the message as plain text, or JSON
//   {"message": "...", "model_is_local": false, "analyze_only": false}
//
// Data-fetch hosts: none (it only uses the buyer's model provider).
//
// To publish it under your name on druve.ai: open druve.ai/build/new, paste
// this file's GitHub link into "Agent code", and publish. It runs on each
// buyer's own model key.

import { getModelClient } from '@druve/cli/providers';

const randomHex = (bytes) => [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Enhanced PII patterns with confidence scoring
const piiPatterns = {
  // High confidence patterns
  ssn: {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.95,
    severity: 'critical',
    mask: true
  },
  creditCard: {
    pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
    confidence: 0.90,
    severity: 'critical', 
    mask: true
  },
  
  // Medium confidence patterns
  email: {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    confidence: 0.85,
    severity: 'high',
    mask: false
  },
  phone: {
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    confidence: 0.80,
    severity: 'medium',
    mask: true
  },
  
  // Context-aware patterns
  ipAddress: {
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    confidence: 0.70,
    severity: 'medium',
    mask: false
  },
  zipCode: {
    pattern: /\b\d{5}(?:-\d{4})?\b/g,
    confidence: 0.60,
    severity: 'low',
    mask: false
  },
  
  // Enhanced patterns
  driversLicense: {
    pattern: /\b[A-Z]{1,2}\d{6,8}\b/g,
    confidence: 0.75,
    severity: 'high',
    mask: true
  },
  dateOfBirth: {
    pattern: /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b/g,
    confidence: 0.70,
    severity: 'medium',
    mask: true
  },
  
  // New patterns
  accountNumber: {
    pattern: /\b(?:account|acct)[\s#:]*\d{6,12}\b/gi,
    confidence: 0.85,
    severity: 'high',
    mask: true
  },
  medicalId: {
    pattern: /\b(?:patient|medical)[\s#:]*\d{6,10}\b/gi,
    confidence: 0.90,
    severity: 'critical',
    mask: true
  }
};

// Enhanced context detection
const contextPatterns = {
  financial: /\b(?:bank|credit|loan|mortgage|investment|portfolio)\b/gi,
  medical: /\b(?:patient|doctor|hospital|diagnosis|medication|treatment)\b/gi,
  legal: /\b(?:attorney|lawyer|case|litigation|settlement|contract)\b/gi,
  personal: /\b(?:family|spouse|children|address|home|personal)\b/gi
};

// Masking functions
function maskPII(text, pattern, maskChar = '*') {
  return text.replace(pattern, (match) => {
    if (match.length <= 4) return maskChar.repeat(match.length);
    return match.substring(0, 2) + maskChar.repeat(match.length - 4) + match.substring(match.length - 2);
  });
}


// The analyzer's per-message logic, verbatim apart from reading one message.
function analyze(chatInput) {
  const timestamp = new Date().toISOString();
  const sessionId = randomHex(16);
  const detectedPatterns = [];
  let maskedContent = chatInput;
  let hasPII = false;
  let totalRiskScore = 0;
  let highestSeverity = 'low';

  // Detect context
  let detectedContext = 'general';
  for (const [contextType, pattern] of Object.entries(contextPatterns)) {
    pattern.lastIndex = 0;
    if (pattern.test(chatInput)) {
      detectedContext = contextType;
      break;
    }
  }

  // Enhanced PII detection with scoring
  for (const [patternName, config] of Object.entries(piiPatterns)) {
    const matches = chatInput.match(config.pattern);
    if (matches && matches.length > 0) {
      hasPII = true;
      const patternRisk = config.confidence * matches.length;
      totalRiskScore += patternRisk;
      const severityLevels = { low: 1, medium: 2, high: 3, critical: 4 };
      if (severityLevels[config.severity] > severityLevels[highestSeverity]) {
        highestSeverity = config.severity;
      }
      if (config.mask) {
        maskedContent = maskPII(maskedContent, config.pattern);
      }
      detectedPatterns.push({
        type: patternName,
        count: matches.length,
        confidence: config.confidence,
        severity: config.severity,
        examples: config.mask ? matches.slice(0, 1).map((m) => maskPII(m, config.pattern)) : matches.slice(0, 1),
        masked: config.mask,
      });
    }
  }

  // Determine routing with enhanced logic
  let routeToOrchestrator;
  let routingReason;
  if (!hasPII) {
    routeToOrchestrator = 2;
    routingReason = 'No PII detected - using cloud model';
  } else if (highestSeverity === 'critical' || totalRiskScore > 2.0) {
    routeToOrchestrator = 1;
    routingReason = 'Critical PII or high risk score - using local model';
  } else if (detectedContext === 'medical' || detectedContext === 'financial') {
    routeToOrchestrator = 1;
    routingReason = 'Sensitive context detected - using local model';
  } else {
    routeToOrchestrator = 1;
    routingReason = 'PII detected - using local model';
  }

  return {
    maskedMessage: maskedContent,
    piiDetected: hasPII,
    detectedPatterns,
    routeToOrchestrator,
    routingReason,
    riskScore: Math.round(totalRiskScore * 100) / 100,
    highestSeverity,
    context: detectedContext,
    sessionId,
    timestamp,
    processingMetrics: { processingTime: Date.now(), inputLength: chatInput.length, patternsChecked: Object.keys(piiPatterns).length, patternsDetected: detectedPatterns.length },
    dataClassification: highestSeverity === 'critical' ? 'confidential' : highestSeverity === 'high' ? 'internal' : 'public',
    complianceFlags: {
      gdpr: detectedContext === 'personal' || hasPII,
      hipaa: detectedContext === 'medical',
      pci: detectedPatterns.some((p) => p.type === 'creditCard'),
      sox: detectedContext === 'financial',
    },
  };
}

// "Compliance & Audit Logger" entry, without any PII content.
function auditEntry(a, chatInput, responseGenerated) {
  return {
    timestamp: a.timestamp,
    sessionId: a.sessionId,
    messageId: randomHex(8),
    processingRoute: a.routeToOrchestrator === 1 ? 'local' : 'cloud',
    routingReason: a.routingReason,
    piiDetected: a.piiDetected || false,
    riskScore: a.riskScore || 0,
    highestSeverity: a.highestSeverity || 'none',
    context: a.context || 'general',
    patternsSummary: {
      totalPatterns: a.detectedPatterns?.length || 0,
      patternTypes: a.detectedPatterns?.map((p) => p.type) || [],
      severityLevels: a.detectedPatterns?.map((p) => p.severity) || [],
    },
    complianceFlags: a.complianceFlags || {},
    dataClassification: a.dataClassification || 'public',
    processingMetrics: a.processingMetrics || {},
    userMetadata: { inputLength: chatInput.length || 0, responseGenerated, errorOccurred: false },
  };
}

export async function handleMessage(input, providerConfig) {
  const raw = String(input || '').trim();
  let p;
  try { p = JSON.parse(raw); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { message: raw };
  const chatInput = String(p.message ?? p.chatInput ?? '');
  if (!chatInput.trim()) return JSON.stringify({ error: 'No chat input found' });

  const a = analyze(chatInput);
  const analysis = {
    pii_detected: a.piiDetected,
    risk_score: a.riskScore,
    highest_severity: a.piiDetected ? a.highestSeverity : 'none',
    context: a.context,
    route: a.routeToOrchestrator === 1 ? 'local' : 'cloud',
    routing_reason: a.routingReason,
    data_classification: a.dataClassification,
    compliance_flags: a.complianceFlags,
    detected_patterns: a.detectedPatterns,
    masked_message: a.maskedMessage,
  };

  const critical = a.piiDetected && a.highestSeverity === 'critical';
  if (p.analyze_only || (critical && !p.model_is_local)) {
    return JSON.stringify({
      ...analysis,
      sent_to_model: false,
      note: p.analyze_only ? 'Analysis only, nothing was sent to a model.' : 'Critical PII found, so nothing was sent to a model. Run it with a local model and "model_is_local": true, or remove the data and try again.',
      audit: auditEntry(a, chatInput, false),
    });
  }

  // Clean messages go as they are; any PII message goes masked (the template's private agent gets maskedMessage).
  const toModel = a.piiDetected ? a.maskedMessage : chatInput;
  const model = getModelClient(providerConfig);
  const reply = String(await model.complete(toModel)).trim();
  return JSON.stringify({ reply, ...analysis, sent_to_model: a.piiDetected ? 'masked message' : 'original message', audit: auditEntry(a, chatInput, true) });
}
