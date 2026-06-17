const { Groq } = require('groq-sdk');

const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3-32b';
const MAX_PROMPT_CHARS = Number(process.env.GROQ_PROMPT_MAX_CHARS || 12000);
const MAX_TEXT_CHARS = Number(process.env.GROQ_TEXT_MAX_CHARS || 240);
const MAX_METRIC_SNAPSHOT = Number(process.env.GROQ_MAX_METRIC_SNAPSHOT || 4);
const MAX_LOG_ENTRIES = Number(process.env.GROQ_MAX_LOG_ENTRIES || 3);
const MAX_TRACE_SUMMARIES = Number(process.env.GROQ_MAX_TRACE_SUMMARIES || 3);
const MAX_SPAN_DETAILS = Number(process.env.GROQ_MAX_SPAN_DETAILS || 4);
const MAX_ARRAY_ITEMS = Number(process.env.GROQ_MAX_ARRAY_ITEMS || 6);
const GROQ_MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS || 1024);
const GROQ_STRICT_JSON = process.env.GROQ_STRICT_JSON === 'true';

function limitText(value, maxChars = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') {
    return value ?? null;
  }

  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function limitArray(items = [], maxItems = MAX_ARRAY_ITEMS) {
  return Array.isArray(items) ? items.slice(0, maxItems) : [];
}

function pickMetricSnapshot(snapshot = []) {
  return limitArray(snapshot, MAX_METRIC_SNAPSHOT)
    .filter((item) => item && item.result && item.result.length > 0)
    .map((item) => ({
      name: limitText(item.name, 80),
      query: limitText(item.query, 120),
      value: item.result[0].value,
      labels: item.result[0].labels || {},
      timestamp: item.result[0].timestamp || null
    }));
}

function pickLogEntries(entries = []) {
  return limitArray(entries, MAX_LOG_ENTRIES)
    .filter(Boolean)
    .map((entry) => ({
      timestamp: entry.timestamp || null,
      level: entry.level || null,
      msg: limitText(entry.msg || entry.error || entry.reason || entry.raw || ''),
      status: entry.status || null,
      reason: limitText(entry.reason || null),
      duration_ms: entry.duration_ms ?? null,
      trace_id: limitText(entry.trace_id || null, 80)
    }));
}

function pickTraceSummaries(traces = []) {
  return limitArray(traces, MAX_TRACE_SUMMARIES)
    .filter(Boolean)
    .map((trace) => ({
      traceID: limitText(trace.traceID || null, 80),
      duration_ms: trace.duration_ms ?? null,
      spanCount: trace.spanCount ?? null,
      errorSpanCount: trace.errorSpanCount ?? null,
      operationNames: limitArray(trace.operationNames || [], MAX_ARRAY_ITEMS).map((name) => limitText(name, 80)),
      spanDetails: limitArray(trace.spanDetails || [], MAX_SPAN_DETAILS).map((span) => ({
        spanID: limitText(span.spanID || null, 80),
        parentSpanID: limitText(span.parentSpanID || null, 80),
        operationName: limitText(span.operationName || null, 120),
        serviceName: limitText(span.serviceName || null, 120),
        duration_ms: span.duration_ms ?? null
      }))
    }));
}

function compactAlertContext(alertContext = {}) {
  return {
    name: limitText(alertContext.name, 120),
    severity: limitText(alertContext.severity, 40),
    service: limitText(alertContext.service, 80),
    instance: limitText(alertContext.instance, 80),
    description: limitText(alertContext.description, 240),
    summary: limitText(alertContext.summary, 240),
    startsAt: alertContext.startsAt || null,
    endsAt: alertContext.endsAt || null
  };
}

function buildEvidenceSection(evidence) {
  if (!evidence) {
    return 'No additional evidence was collected.';
  }

  const cleanEvidence = {
    alert: compactAlertContext(evidence.alert || {}),
    metrics: {
      focus: limitText(evidence.metrics?.focus || null, 80),
      snapshot: pickMetricSnapshot(evidence.metrics?.snapshot || []),
      trend: evidence.metrics?.trend?.result
        ? limitArray(evidence.metrics.trend.result, MAX_ARRAY_ITEMS).map((item) => ({
            labels: item.labels || {},
            points: item.points ?? null,
            first: item.first ?? null,
            last: item.last ?? null,
            min: item.min ?? null,
            max: item.max ?? null
          }))
        : null
    },
    logs: {
      totalLines: evidence.logs?.totalLines ?? 0,
      errorCount: evidence.logs?.errorCount ?? 0,
      warningCount: evidence.logs?.warningCount ?? 0,
      topErrors: pickLogEntries(evidence.logs?.topErrors || []),
      topWarnings: pickLogEntries(evidence.logs?.topWarnings || []),
      traceIds: limitArray(evidence.logs?.traceIds || [], MAX_ARRAY_ITEMS).map((traceId) => limitText(traceId, 80))
    },
    traces: {
      totalTraces: evidence.traces?.totalTraces ?? 0,
      traceIds: limitArray(evidence.traces?.traceIds || [], MAX_ARRAY_ITEMS).map((traceId) => limitText(traceId, 80)),
      linkedTraces: pickTraceSummaries(evidence.traces?.linkedTraces || []),
      slowestTraces: pickTraceSummaries(evidence.traces?.slowestTraces || [])
    },
    correlation: {
      service: limitText(evidence.correlation?.service || null, 80),
      alertname: limitText(evidence.correlation?.alertname || null, 120),
      timeWindow: evidence.correlation?.timeWindow || null,
      signals: limitArray(evidence.correlation?.signals || [], MAX_ARRAY_ITEMS).map((signal) => limitText(signal, 180))
    },
    missingSignals: limitArray(evidence.missingSignals || [], MAX_ARRAY_ITEMS).map((signal) => limitText(signal, 180))
  };

  return JSON.stringify(cleanEvidence);
}

function clampPrompt(prompt) {
  if (prompt.length <= MAX_PROMPT_CHARS) {
    return prompt;
  }

  const marker = '\n\n[Evidence truncated to fit prompt budget]\n';
  const keep = Math.max(0, MAX_PROMPT_CHARS - marker.length);
  return `${prompt.slice(0, keep)}${marker}`;
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.trim().length > 0);
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function isMissingLikeSignal(signal) {
  if (typeof signal !== 'string') {
    return true;
  }

  const text = signal.trim();
  if (!text) {
    return true;
  }

  const blockedPatterns = [
    /unavailable/i,
    /missing/i,
    /no trace_id/i,
    /trend unavailable/i,
    /logs unavailable/i,
    /trace unavailable/i,
    /unable to/i,
    /not found/i,
    /failed to collect/i,
    /still ongoing/i,
    /service was not functioning/i
  ];

  return blockedPatterns.some((pattern) => pattern.test(text));
}

function splitSignals(values) {
  const items = asStringArray(values);
  return {
    kept: items.filter((item) => !isMissingLikeSignal(item)),
    missing: items.filter((item) => isMissingLikeSignal(item))
  };
}

function normalizeAnalysisResponse(analysis, evidence) {
  const evidenceUsed = analysis.evidenceUsed || {};
  const metricSignals = splitSignals(evidenceUsed.metrics || analysis.metrics);
  const logSignals = splitSignals(evidenceUsed.logs || analysis.logs);
  const traceSignals = splitSignals(evidenceUsed.traces || analysis.traces);
  const correlatedFromAnalysis = splitSignals([
    ...asStringArray(analysis.correlatedSignals),
    ...asStringArray(analysis.correlation),
    ...asStringArray(evidenceUsed.correlation)
  ]);
  const missingSignals = [
    ...asStringArray(analysis.missingSignals),
    ...asStringArray(evidenceUsed.missingSignals),
    ...asStringArray(evidence?.missingSignals),
    ...metricSignals.missing,
    ...logSignals.missing,
    ...traceSignals.missing,
    ...correlatedFromAnalysis.missing
  ];
  const traceIds = asStringArray(analysis.traceIds)
    .concat(asStringArray(evidence?.traces?.traceIds))
    .filter((item) => typeof item === 'string' && item.trim().length > 0);

  return {
    rootCause: analysis.rootCause || 'Unable to determine root cause',
    confidence: Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : 0,
    evidenceUsed: {
      metrics: metricSignals.kept,
      logs: logSignals.kept,
      traces: traceSignals.kept
    },
    traceIds: [...new Set(traceIds)],
    correlatedSignals: [...new Set(correlatedFromAnalysis.kept)],
    recommendedActions: Array.isArray(analysis.actions) ? analysis.actions : [],
    missingSignals: [...new Set(missingSignals)]
  };
}

function parseGroqJsonResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    throw new Error('Empty Groq response');
  }

  const withoutReasoning = responseText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<think>[\s\S]*?(?=\{)/gi, '')
    .replace(/<analysis>[\s\S]*?(?=\{)/gi, '')
    .trim();
  const withoutFence = withoutReasoning
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch (firstError) {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const maybeJson = withoutFence.slice(firstBrace, lastBrace + 1);
      return JSON.parse(maybeJson);
    }

    throw firstError;
  }
}

async function createGroqCompletion(groq, request) {
  if (!GROQ_STRICT_JSON) {
    return groq.chat.completions.create(request);
  }

  try {
    return await groq.chat.completions.create({
      ...request,
      response_format: { type: 'json_object' }
    });
  } catch (error) {
    const message = String(error?.message || '');
    const shouldRetryWithoutStrictJson =
      error?.status === 400 &&
      /response_format|json_object|unsupported|not supported|json_validate_failed|failed to validate json/i.test(message);

    if (!shouldRetryWithoutStrictJson) {
      throw error;
    }

    console.warn('Groq strict JSON response failed. Retrying without response_format and parsing JSON locally.');
    return groq.chat.completions.create(request);
  }
}

async function analyzeAlert(alertContext, evidence = null) {
  try {
    if (!process.env.GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY environment variable is not set');
    }
    
    const groq = new Groq({
        apiKey: process.env.GROQ_API_KEY
    });

    const prompt = clampPrompt(`
You are an expert SRE (Site Reliability Engineer) analyzing a production incident using multiple evidence sources.
Your analysis must be highly pragmatic, action-oriented, and technically accurate.

Incident Context:
- Name: ${limitText(alertContext.name, 120)}
- Severity: ${limitText(alertContext.severity, 40)}
- Service: ${limitText(alertContext.service, 80)}
- Instance: ${limitText(alertContext.instance, 80)}
- Description: ${limitText(alertContext.description, 240)}
- Summary: ${limitText(alertContext.summary, 240)}
- Started At: ${alertContext.startsAt}
- Ends At: ${alertContext.endsAt || 'unknown'}

Evidence Bundle:
${buildEvidenceSection(evidence)}

CRITICAL RUNBOOK RULES (Strictly Enforce):
1. Distinguish System vs. Business Errors: If the root cause is a user-initiated/business error (e.g., Insufficient funds, bad request payload, invalid credentials), DO NOT recommend infrastructure changes like restarting services, scaling pods, or failing over. Instead, recommend checking upstream clients, business logic configs, or external gateway/third-party statuses.
2. Actionable & Specific Remediation: Every action must be concrete. Avoid generic placeholders like "check logs" or "monitor metrics" unless you specify EXACTLY which log pattern or metric query to look at based on the evidence.
3. Logical Progression: Priority 1 action must immediately mitigate the ongoing incident or pinpoint the exact technical root cause. Priority 2 and 3 should follow up with deep-dive investigation or long-term remediation.

Task:
1. Identify the most likely root cause.
2. Explain which evidence supports the conclusion.
3. Assign a confidence score from 0 to 100 (Be conservative if evidence is sparse).
4. Suggest 3 remediation actions in order of priority (Rank 1 to 3).
5. List any missing or conflicting signals.
6. Do not treat query/fetch errors as incident evidence unless they are clearly part of the service incident.
7. If logs or traces are missing, say that evidence is missing instead of inventing a cause from the missing data.
8. The action field MUST be one of these exact allowlisted values only:
   - "check_logs" for reading recent service logs.
   - "view_metrics" for reading Prometheus metrics.
   - "restart_service" for restarting a Docker Compose service.
9. Use "restart_service" only when evidence indicates the service is unhealthy, wedged, down, or likely recoverable by restart. Do not use "restart_service" for business declines such as insufficient funds.
10. If the best next step is investigation, use either "check_logs" or "view_metrics"; do not invent action names like "investigate_payment_failures".

Return ONLY a single valid JSON object matching this shape. Do not include markdown, comments, angle-bracket placeholders, trailing commas, or text outside the JSON.
Use concrete strings, not placeholder text.
{
  "rootCause": "payment-service is not accepting charge requests, causing order creation to fail downstream.",
  "confidence": 85,
  "evidenceUsed": {
    "metrics": ["charges_per_min is 0 for payment-service during the incident window"],
    "logs": ["order-service reports payment request failed while calling payment-service"],
    "traces": ["trace spans show errors around payment-service charge calls"]
  },
  "traceIds": [],
  "correlatedSignals": ["PaymentServiceDown alert is firing", "orders fail when payment-service is unavailable"],
  "actions": [
    {
      "priority": 1,
      "action": "restart_service",
      "description": "Restart payment-service using the Docker Compose remediation tool.",
      "reason": "The alert indicates payment-service is down or not processing charge traffic.",
      "service": "${alertContext.service}"
    },
    {
      "priority": 2,
      "action": "check_logs",
      "description": "Check recent payment-service logs for startup, connection, or runtime errors.",
      "reason": "Logs can confirm whether the restart resolved the failure or whether the service crashes again.",
      "service": "${alertContext.service}"
    },
    {
      "priority": 3,
      "action": "view_metrics",
      "description": "Review payment-service charge rate and failed charge rate after remediation.",
      "reason": "Metrics confirm whether charge traffic recovered after the restart.",
      "service": "${alertContext.service}"
    }
  ],
  "missingSignals": []
}

Important Architecture Rules:
- Do not put correlation or missingSignals inside evidenceUsed.
- Keep evidenceUsed limited to metrics, logs, and traces.
- Do not use phrases like "unavailable" or "missing" as correlated signals; those belong in missingSignals only.
`);

    console.log(`🔍 Sending prompt to Groq model ${GROQ_MODEL}...`);
    
    const message = await createGroqCompletion(groq, {
      model: GROQ_MODEL,
      max_tokens: GROQ_MAX_TOKENS,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are a production SRE incident analysis engine.',
            'Return only one valid JSON object.',
            'Do not include markdown, prose, chain-of-thought, reasoning tags, or text before or after the JSON.',
            'If you need to reason, do it internally and only emit the final JSON.'
          ].join(' ')
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const responseText = message.choices[0].message.content;
    console.log('📝 Groq Response:', responseText);
    
    const analysis = parseGroqJsonResponse(responseText);
    const normalizedAnalysis = normalizeAnalysisResponse(analysis, evidence);

    return normalizedAnalysis;
  } catch (error) {
    console.error('❌ Error analyzing alert with Groq:');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error status:', error.status);
    console.error('Full error:', JSON.stringify(error, null, 2));
    
    const isServiceDown = /down|unavailable|no traffic/i.test(`${alertContext.name} ${alertContext.summary} ${alertContext.description}`);
    const fallbackPrimaryAction = isServiceDown ? {
      priority: 1,
      action: 'restart_service',
      description: `Restart ${alertContext.service} because the service-down alert is firing.`,
      reason: 'The alert indicates the service is down or not processing traffic, and restart is the lab-approved high-risk remediation.',
      service: alertContext.service
    } : {
      priority: 1,
      action: 'check_logs',
      description: `Check recent logs for ${alertContext.service}.`,
      reason: 'Groq analysis failed, so use read-only evidence collection before taking mutating action.',
      service: alertContext.service
    };

    // Fallback response if Groq fails
    return {
      rootCause: 'Unable to analyze (Groq service unavailable)',
      confidence: 0,
      evidenceUsed: {},
      traceIds: [],
      correlatedSignals: [],
      recommendedActions: [
        fallbackPrimaryAction,
        {
          priority: 2,
          action: 'check_logs',
          description: 'Check recent error logs',
          reason: 'Identify error patterns',
          service: alertContext.service
        }
      ],
      missingSignals: ['Groq analysis unavailable'],
      error: error.message
    };
  }
}

module.exports = { analyzeAlert };
