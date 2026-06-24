const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
require('dotenv').config();

const {
    enqueueAlerts,
    startIncidentWorker,
    listIncidents
} = require('./incident-queue');
const { initSlackBot, sendSlackApproval } = require('./slack-bot');
const { analyzeAlert } = require('./groq-analyzer');
const {
    handleRecommendedAction,
    approveAction,
    rejectAction
} = require('./action-orchestrator')
const { listActions, listAuditEvents } = require('./approval-store')

const app = express();
const PORT = process.env.PORT || 3003;
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3-32b';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100';
const JAEGER_URL = process.env.JAEGER_URL || 'http://jaeger:16686';
const EVIDENCE_LOOKBACK_MINUTES = Number(process.env.EVIDENCE_LOOKBACK_MINUTES || 10);
const PROM_QUERY_TIMEOUT_MS = Number(process.env.PROM_QUERY_TIMEOUT_MS || 3000);
const LOKI_QUERY_TIMEOUT_MS = Number(process.env.LOKI_QUERY_TIMEOUT_MS || 3000);
const JAEGER_QUERY_TIMEOUT_MS = Number(process.env.JAEGER_QUERY_TIMEOUT_MS || 3000);

app.use(bodyParser.json());

const bolt = initSlackBot();

function resolveServiceFromAlert(alert) {
    const labels = alert.labels || {};

    if (labels.service) {
        return labels.service;
    }

    const alertname = labels.alertname || '';
    const team = labels.team || '';

    if (alertname.includes('Payment') || team === 'payments') {
        return 'payment-service';
    }

    if (alertname.includes('Order') || team === 'orders') {
        return 'order-service';
    }

    if (alertname.includes('API') || team === 'platform') {
        return 'api-gateway';
    }

    return 'unknown';
}

function toIso(date) {
    return new Date(date).toISOString();
}

function toUnixNano(date) {
    return String(new Date(date).getTime() * 1_000_000);
}

function getIncidentWindow(alert) {
    const startedAt = alert.startsAt ? new Date(alert.startsAt) : new Date();
    const rawEndsAt = alert.endsAt ? new Date(alert.endsAt) : null;
    const to = rawEndsAt && !Number.isNaN(rawEndsAt.getTime()) && rawEndsAt.getUTCFullYear() >= 2000
        ? rawEndsAt
        : new Date();
    const from = new Date(startedAt.getTime() - EVIDENCE_LOOKBACK_MINUTES * 60 * 1000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        const fallbackTo = new Date();
        return {
            from: new Date(fallbackTo.getTime() - EVIDENCE_LOOKBACK_MINUTES * 60 * 1000),
            to: fallbackTo
        };
    }

    return { from, to };
}

function getMetricProfile(service, alertname) {
    if (service === 'payment-service') {
        return {
            snapshotQueries: [
                { name: 'payment_target_up', query: 'up{job="payment-service"}' },
                { name: 'charges_per_min', query: 'rate(aiops_lab_charges_total[5m]) * 60' },
                { name: 'failed_charge_rate_pct', query: 'rate(aiops_lab_charges_total{status="failed"}[5m]) / rate(aiops_lab_charges_total[5m]) * 100' },
                { name: 'charge_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_charge_duration_milliseconds_bucket[5m]))' },
                { name: 'revenue_total_thb', query: 'aiops_lab_revenue_THB_total' }
            ],
            trendQuery: 'rate(aiops_lab_charges_total{status="failed"}[5m]) / rate(aiops_lab_charges_total[5m]) * 100',
            focus: 'payment-service'
        };
    }

    if (service === 'api-gateway') {
        return {
            snapshotQueries: [
                { name: 'api_gateway_target_up', query: 'up{job="api-gateway"}' },
                { name: 'api_requests_per_min', query: 'rate(aiops_lab_api_requests_total[5m]) * 60' },
                { name: 'orders_created_per_min', query: 'rate(aiops_lab_orders_created_total[5m]) * 60' },
                { name: 'api_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_api_request_duration_milliseconds_bucket[5m]))' }
            ],
            trendQuery: 'histogram_quantile(0.99, rate(aiops_lab_api_request_duration_milliseconds_bucket[5m]))',
            focus: 'api-gateway'
        };
    }

    if (service === 'order-service') {
        return {
            snapshotQueries: [
                { name: 'order_target_up', query: 'up{job="order-service"}' },
                { name: 'payments_attempted_per_min', query: 'rate(aiops_lab_payments_attempted_total[5m]) * 60' },
                { name: 'order_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_order_processing_duration_milliseconds_bucket[5m]))' }
            ],
            trendQuery: 'histogram_quantile(0.99, rate(aiops_lab_order_processing_duration_milliseconds_bucket[5m]))',
            focus: 'order-service'
        };
    }

    return {
        snapshotQueries: [
            { name: 'api_requests_per_min', query: 'rate(aiops_lab_api_requests_total[5m]) * 60' },
            { name: 'orders_created_per_min', query: 'rate(aiops_lab_orders_created_total[5m]) * 60' },
            { name: 'charges_per_min', query: 'rate(aiops_lab_charges_total[5m]) * 60' }
        ],
        trendQuery: 'rate(aiops_lab_api_requests_total[5m]) * 60',
        focus: alertname || 'unknown'
    };
}

function summarizePrometheusResult(result) {
    return (result || []).map((item) => ({
        labels: item.metric || {},
        value: Number(item.value?.[1]),
        timestamp: item.value?.[0]
    }));
}

function summarizeRangeResult(result) {
    return (result || []).map((item) => {
        const points = item.values || [];
        const values = points.map((point) => Number(point[1])).filter((value) => Number.isFinite(value));

        return {
            labels: item.metric || {},
            points: points.length,
            first: values.length ? values[0] : null,
            last: values.length ? values[values.length - 1] : null,
            min: values.length ? Math.min(...values) : null,
            max: values.length ? Math.max(...values) : null
        };
    });
}

async function queryPrometheus(query, time) {
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
        params: { query, time: toIso(time) },
        timeout: PROM_QUERY_TIMEOUT_MS
    });

    return response.data?.data?.result || [];
}

async function queryPrometheusRange(query, from, to) {
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query_range`, {
        params: {
            query,
            start: toIso(from),
            end: toIso(to),
            step: '30s'
        },
        timeout: PROM_QUERY_TIMEOUT_MS
    });

    return response.data?.data?.result || [];
}

function parseLogLine(entry) {
    if (!entry || typeof entry.line !== 'string') {
        return null;
    }

    try {
        const parsed = JSON.parse(entry.line);
        return {
            timestamp: entry.timestamp || parsed.timestamp || null,
            service: parsed.service || null,
            level: parsed.level || null,
            msg: parsed.msg || null,
            trace_id: parsed.trace_id || parsed.traceId || null,
            span_id: parsed.span_id || parsed.spanId || null,
            error: parsed.error || null,
            reason: parsed.reason || null,
            status: parsed.status || null,
            duration_ms: parsed.duration_ms ?? null,
            route: parsed.route || null,
            method: parsed.method || null,
            raw: entry.line
        };
    } catch {
        const traceIdMatch = entry.line.match(/"trace_id"\s*:\s*"([^"]+)"/i) || entry.line.match(/trace_id=([a-zA-Z0-9]+)/i);
        return {
            timestamp: entry.timestamp || null,
            service: null,
            level: null,
            msg: entry.line,
            trace_id: traceIdMatch ? traceIdMatch[1] : null,
            span_id: null,
            error: null,
            reason: null,
            status: null,
            duration_ms: null,
            route: null,
            method: null,
            raw: entry.line
        };
    }
}

function collectTraceIdsFromLogs(logs) {
    const traceIds = [...(logs.traceIds || [])];

    for (const entry of logs.samples || []) {
        if (entry.trace_id) {
            traceIds.push(entry.trace_id);
        }
    }

    for (const entry of logs.topErrors || []) {
        if (entry.trace_id) {
            traceIds.push(entry.trace_id);
        }
    }

    return [...new Set(traceIds)].filter(Boolean);
}

function normalizeJaegerTraces(payload) {
    if (!payload) {
        return [];
    }

    if (Array.isArray(payload)) {
        return payload;
    }

    if (Array.isArray(payload.data)) {
        return payload.data;
    }

    if (Array.isArray(payload.traces)) {
        return payload.traces;
    }

    return [];
}

function summarizeLogs(entries) {
    const parsed = entries.map(parseLogLine).filter(Boolean);
    const errorPattern = /(error|failed|exception|timeout|declined|panic)/i;
    const warnPattern = /(warn|retry|slow|latency)/i;

    const errors = parsed.filter((entry) => {
        const haystack = JSON.stringify(entry);
        return entry.level === 'error' || errorPattern.test(haystack);
    });

    const warnings = parsed.filter((entry) => {
        const haystack = JSON.stringify(entry);
        return entry.level === 'warn' || warnPattern.test(haystack);
    });

    return {
        totalLines: parsed.length,
        errorCount: errors.length,
        warningCount: warnings.length,
        topErrors: errors.slice(0, 5),
        topWarnings: warnings.slice(0, 5),
        samples: parsed.slice(0, 10),
        traceIds: [...new Set(parsed.map((entry) => entry.trace_id).filter(Boolean))]
    };
}

async function queryLoki(service, from, to) {
    const response = await axios.get(`${LOKI_URL}/loki/api/v1/query_range`, {
        params: {
            query: `{service="${service}"}`,
            start: toUnixNano(from),
            end: toUnixNano(to),
            limit: 200,
            direction: 'BACKWARD'
        },
        timeout: LOKI_QUERY_TIMEOUT_MS
    });

    const streams = response.data?.data?.result || [];
    const entries = [];

    for (const stream of streams) {
        for (const value of stream.values || []) {
            entries.push({
                timestamp: value[0],
                line: value[1]
            });
        }
    }

    entries.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    return summarizeLogs(entries);
}

function summarizeTrace(trace) {
    const spans = trace.spans || [];
    const totalDurationUs = Number(trace.duration || 0);
    const spanDurations = spans.map((span) => Number(span.duration || 0)).filter((value) => Number.isFinite(value));
    const durationUs = totalDurationUs || (spanDurations.length ? Math.max(...spanDurations) : 0);
    const errorSpans = spans.filter((span) => {
        const tags = span.tags || [];
        return tags.some((tag) => tag.key === 'error' && (tag.value === true || tag.value === 'true')) ||
            tags.some((tag) => String(tag.key || '').toLowerCase().includes('error'));
    });

    return {
        traceID: trace.traceID || trace.traceId || null,
        duration_ms: Math.round(durationUs / 1000),
        spanCount: spans.length,
        errorSpanCount: errorSpans.length,
        operationNames: [...new Set(spans.map((span) => span.operationName).filter(Boolean))].slice(0, 10)
    };
}

function summarizeTraceDetail(trace) {
    const spans = trace.spans || [];
    const summarizedSpans = spans.slice(0, 12).map((span) => ({
        traceID: span.traceID || trace.traceID || trace.traceId || null,
        spanID: span.spanID || null,
        parentSpanID: span.parentSpanID || null,
        operationName: span.operationName || null,
        serviceName: span.process?.serviceName || span.serviceName || null,
        duration_ms: Math.round(Number(span.duration || 0) / 1000),
        tags: span.tags || []
    }));

    const summary = summarizeTrace(trace);
    return {
        ...summary,
        spanDetails: summarizedSpans
    };
}

async function queryJaegerTraceById(traceId) {
    const candidates = [
        {
            url: `${JAEGER_URL}/api/traces/${traceId}`,
            params: {}
        },
        {
            url: `${JAEGER_URL}/api/traces`,
            params: { traceID: traceId }
        }
    ];

    for (const candidate of candidates) {
        try {
            const response = await axios.get(candidate.url, {
                params: candidate.params,
                timeout: JAEGER_QUERY_TIMEOUT_MS
            });
            const traces = normalizeJaegerTraces(response.data);
            const match = traces.find((trace) => (trace.traceID || trace.traceId) === traceId);

            if (match) {
                return summarizeTraceDetail(match);
            }
        } catch (error) {
            continue;
        }
    }

    return null;
}

async function queryJaegerByService(service, from, to) {
    const response = await axios.get(`${JAEGER_URL}/api/traces`, {
        params: {
            service,
            start: Math.floor(from.getTime() * 1000),
            end: Math.floor(to.getTime() * 1000),
            limit: 10
        },
        timeout: JAEGER_QUERY_TIMEOUT_MS
    });

    const traces = normalizeJaegerTraces(response.data);
    const summaries = traces.map(summarizeTraceDetail).sort((a, b) => b.duration_ms - a.duration_ms);

    return {
        totalTraces: summaries.length,
        slowestTraces: summaries.slice(0, 3),
        traces: summaries
    };
}

async function collectEvidence(alert, alertContext) {
    const { from, to } = getIncidentWindow(alert);
    const profile = getMetricProfile(alertContext.service, alertContext.name);
    const missingSignals = [];

    const metricTasks = profile.snapshotQueries.map(async (item) => {
        const result = await queryPrometheus(item.query, to);
        return {
            name: item.name,
            query: item.query,
            result: summarizePrometheusResult(result)
        };
    });

    const trendTask = queryPrometheusRange(profile.trendQuery, from, to).then((result) => ({
        query: profile.trendQuery,
        result: summarizeRangeResult(result)
    }));

    const logsTask = queryLoki(alertContext.service, from, to);

    const [metricsResults, trendResult, logsResult] = await Promise.all([
        Promise.allSettled(metricTasks),
        trendTask.then((value) => ({ status: 'fulfilled', value })).catch((error) => ({ status: 'rejected', reason: error })),
        logsTask.then((value) => ({ status: 'fulfilled', value })).catch((error) => ({ status: 'rejected', reason: error }))
    ]);

    const metrics = {
        focus: profile.focus,
        snapshot: metricsResults.map((item) => item.status === 'fulfilled'
            ? item.value
            : { error: item.reason.message, name: 'unknown' }),
        trend: trendResult.status === 'fulfilled'
            ? trendResult.value
            : { error: trendResult.reason.message }
    };

    if (trendResult.status !== 'fulfilled') {
        missingSignals.push(`Prometheus trend unavailable for ${alertContext.service}`);
    }

    const logs = logsResult.status === 'fulfilled'
        ? logsResult.value
        : { error: logsResult.reason.message, totalLines: 0, errorCount: 0, warningCount: 0, topErrors: [], topWarnings: [], samples: [] };

    if (logsResult.status !== 'fulfilled') {
        missingSignals.push(`Loki logs unavailable for ${alertContext.service}`);
    }

    const traceIds = collectTraceIdsFromLogs(logs);
    if (logs.totalLines > 0 && traceIds.length === 0) {
        missingSignals.push(`No trace_id values found in Loki logs for ${alertContext.service}`);
    }
    const traceDetailResults = await Promise.allSettled(
        traceIds.slice(0, 5).map((traceId) => queryJaegerTraceById(traceId))
    );
    const traceDetails = traceDetailResults
        .filter((result) => result.status === 'fulfilled' && result.value)
        .map((result) => result.value);

    let traces = {
        totalTraces: 0,
        slowestTraces: [],
        linkedTraces: [],
        traceIds
    };

    try {
        const fallbackTraces = await queryJaegerByService(alertContext.service, from, to);
        traces = {
            ...fallbackTraces,
            linkedTraces: traceDetails,
            traceIds
        };
    } catch (error) {
        missingSignals.push(`Jaeger traces unavailable for ${alertContext.service}`);
        traces = {
            error: error.message,
            totalTraces: 0,
            slowestTraces: [],
            linkedTraces: traceDetails,
            traceIds
        };
    }

    const correlation = {
        service: alertContext.service,
        alertname: alertContext.name,
        timeWindow: {
            from: toIso(from),
            to: toIso(to)
        },
        signals: [
            metrics.snapshot
                .filter((item) => item.result && item.result.length)
                .map((item) => `${item.name}: ${item.result[0].value}`),
            logs.topErrors.slice(0, 3).map((entry) => entry.msg || entry.error || entry.raw),
            traces.linkedTraces.slice(0, 3).map((trace) => `${trace.traceID}: ${trace.duration_ms}ms`),
            traces.slowestTraces.slice(0, 3).map((trace) => `${trace.traceID}: ${trace.duration_ms}ms`)
        ].flat().filter(Boolean)
    };

    return {
        alert: alertContext,
        metrics,
        logs,
        traces,
        correlation
        ,
        missingSignals
    };
}

function getViewMetricsQueries(service) {
    if (service === 'payment-service') {
        return [
            { name: 'payment_target_up', query: 'up{job="payment-service"}' },
            { name: 'charges_per_min', query: 'rate(aiops_lab_charges_total[5m]) * 60' },
            { name: 'failed_charge_rate_pct', query: 'rate(aiops_lab_charges_total{status="failed"}[5m]) / rate(aiops_lab_charges_total[5m]) * 100' },
            { name: 'charge_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_charge_duration_milliseconds_bucket[5m]))' },
            { name: 'revenue_total_thb', query: 'aiops_lab_revenue_THB_total' }
        ];
    }

    if (service === 'api-gateway') {
        return [
            { name: 'api_gateway_target_up', query: 'up{job="api-gateway"}' },
            { name: 'api_requests_per_min', query: 'rate(aiops_lab_api_requests_total[5m]) * 60' },
            { name: 'orders_created_per_min', query: 'rate(aiops_lab_orders_created_total[5m]) * 60' },
            { name: 'api_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_api_request_duration_milliseconds_bucket[5m]))' }
        ];
    }

    if (service === 'order-service') {
        return [
            { name: 'order_target_up', query: 'up{job="order-service"}' },
            { name: 'payments_attempted_per_min', query: 'rate(aiops_lab_payments_attempted_total[5m]) * 60' },
            { name: 'order_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_order_processing_duration_milliseconds_bucket[5m]))' }
        ];
    }

    return [
        { name: 'api_requests_per_min', query: 'rate(aiops_lab_api_requests_total[5m]) * 60' },
        { name: 'orders_created_per_min', query: 'rate(aiops_lab_orders_created_total[5m]) * 60' },
        { name: 'charges_per_min', query: 'rate(aiops_lab_charges_total[5m]) * 60' }
    ];
}

function formatMetricSeries(series) {
    if (!series || series.length === 0) {
        return 'No metric series returned.';
    }

    return series
        .map((item) => {
            const labels = item.labels && Object.keys(item.labels).length
                ? JSON.stringify(item.labels)
                : '{}';
            return `${item.name}: ${item.value} ${labels}`;
        })
        .join('\n');
}

function ensureRequiredRemediationActions(alertContext, analysis) {
    const recommendedActions = Array.isArray(analysis.recommendedActions)
        ? [...analysis.recommendedActions]
        : [];

    const hasRestart = recommendedActions.some((action) => action.action === 'restart_service');

    const requiresRestartCandidate = new Set([
        'ApiGatewayTargetDown',
        'OrderServiceTargetDown',
        'PaymentServiceTargetDown'
    ]);

    if (requiresRestartCandidate.has(alertContext.name) && !hasRestart) {
        recommendedActions.unshift({
            priority: 1,
            action: 'restart_service',
            description: `Restart ${alertContext.service} because the service-down alert is firing.`,
            reason: `${alertContext.name} is a lab-approved root alert that requires human approval before restarting the stopped service.`,
            service: alertContext.service
        });
    }

    return {
        ...analysis,
        recommendedActions: recommendedActions.map((action, index) => ({
            ...action,
            priority: index + 1
        }))
    };
}

function buildAlertContext(alert) {
    return {
        name: alert.labels.alertname,
        severity: alert.labels.severity || 'unknown',
        service: resolveServiceFromAlert(alert),
        instance: alert.labels.instance || 'unknown',
        description: alert.annotations.description || '',
        summary: alert.annotations.summary || '',
        startsAt: alert.startsAt,
        endsAt: alert.endsAt
    };
}

async function processIncident(incident) {
    const alert = incident.alert;
    console.log(`Processing queued incident: ${incident.alertname} for ${incident.service} (${incident.id})`);

    const alertContext = buildAlertContext(alert);
    alertContext.incidentId = incident.id;

    console.log('Alert Context:', alertContext);
    console.log('Collecting evidence from Prometheus, Loki, and Jaeger...');
    const evidence = await collectEvidence(alert, alertContext);
    incident.evidence = evidence;
    console.log('Evidence Bundle:', {
        service: evidence.alert.service,
        metricGroups: evidence.metrics.snapshot.length,
        logErrors: evidence.logs.errorCount,
        traces: evidence.traces.totalTraces
    });

    console.log(`Analyzing with ${LLM_PROVIDER === 'fake' ? 'fake LLM provider' : 'Groq'}...`);
    const analysis = ensureRequiredRemediationActions(alertContext, await analyzeAlert(alertContext, evidence));
    incident.analysis = analysis;
    console.log('Analysis Result:', analysis);

    const actionRequests = [];
    for (const action of analysis.recommendedActions || []) {
        const actionRequest = await handleRecommendedAction(action, alertContext);
        actionRequests.push(actionRequest);
        console.log('Action request:', actionRequest);
    }

    console.log('Sending approval request to Slack...');
    await sendSlackApproval(alertContext, analysis, bolt, actionRequests);
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'ai-remediation-agent',
        llmProvider: LLM_PROVIDER,
        llmEnabled: LLM_PROVIDER === 'fake' || Boolean(process.env.GROQ_API_KEY),
        groqModel: LLM_PROVIDER === 'groq' ? GROQ_MODEL : null
    });
});

app.post('/alerts', async (req, res) => {
    try {
        const alerts = req.body.alerts || [];
        console.log(`Received ${alerts.length} alert(s)`);

        const result = enqueueAlerts(alerts);

        for (const incident of result.enqueued) {
            console.log(`Queued incident: ${incident.alertname} for ${incident.service} (${incident.id}) priority=${incident.priority}`);
        }

        for (const item of result.skipped) {
            console.log(`Incident not queued: ${item.reason}`);
        }

        res.json({
            status: 'queued',
            received: alerts.length,
            enqueued: result.enqueued.length,
            skipped: result.skipped.length
        });
    } catch (error) {
        console.error('Error processing alerts:', error);
        res.status(500).json({ error: error.message });
    }
});

bolt.action('approve_remediation', async ({ body, ack, say }) => {
  await ack();

  const metadata = JSON.parse(body.actions[0].value);

  try {
    const result = await approveAction(metadata.actionId, body.user.name);

    await say({
      text: `Remediation ${result.status}: ${result.action} for ${result.service}`
    });
  } catch (error) {
    await say({
      text: `Approval failed: ${error.message}`
    });
  }
});

bolt.action('reject_remediation', async ({ body, ack, say }) => {
  await ack();

  const metadata = JSON.parse(body.actions[0].value);

  try {
    const result = rejectAction(metadata.actionId, body.user.name);

    await say({
      text: `Remediation rejected: ${result.action} for ${result.service}`
    });
  } catch (error) {
    await say({
      text: `Reject failed: ${error.message}`
    });
  }
});

async function executeAction(metadata) {
    const { action, service } = metadata;

    switch (action) {
        case 'restart_service': {
            console.log(`Restarting service: ${service}`);
            const { execSync } = require('child_process');
            const output = execSync(`docker-compose restart ${service}`, {
                cwd: '/app',
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return `Service ${service} restarted.\n${output}`;
        }

        case 'check_logs': {
            console.log(`Checking logs for: ${service}`);
            const { execSync } = require('child_process');
            const logs = execSync(`docker-compose logs --tail=20 ${service}`, {
                cwd: '/app',
                encoding: 'utf-8'
            });
            return `Recent logs from ${service}:\n\`\`\`\n${logs}\n\`\`\``;
        }

        case 'view_metrics': {
            console.log(`Fetching metrics from Prometheus for: ${service}`);
            const queries = getViewMetricsQueries(service);
            const results = await Promise.allSettled(
                queries.map(async (item) => {
                    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
                        params: { query: item.query }
                    });
                    const series = response.data?.data?.result || [];
                    return {
                        name: item.name,
                        value: series[0]?.value?.[1] ?? 'N/A',
                        labels: series[0]?.metric || {}
                    };
                })
            );

            const formatted = results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                }

                return {
                    name: queries[index].name,
                    value: `error: ${result.reason.message}`,
                    labels: {}
                };
            });

            return `Metrics snapshot for ${service}:\n${formatMetricSeries(formatted)}`;
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

app.get('/approvals', (req, res) => {
    res.json({
        actions: listActions()
    });
});

app.get('/audit-events', (req, res) => {
    res.json({ events: listAuditEvents() });
});

app.get('/incidents', (req, res) => {
    res.json({
        incidents: listIncidents()
    });
});

app.get('/incidents/:id/evidence', (req, res) => {
    const incident = listIncidents().find((item) => item.id === req.params.id);

    if (!incident) {
        res.status(404).json({ error: 'Incident not found' });
        return;
    }

    res.json({
        id: incident.id,
        status: incident.status,
        alertname: incident.alertname,
        service: incident.service,
        severity: incident.severity,
        evidence: incident.evidence || null,
        analysis: incident.analysis || null,
        message: incident.evidence
            ? 'Evidence collected for this incident.'
            : 'Evidence has not been collected yet. The incident may still be queued or waiting for processing.'
    });
});

app.post('/approvals/:id/approve', async (req, res) => {
    try {
        const result = await approveAction(req.params.id, 'dashboard');
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/approvals/:id/reject', async (req, res) => {
    try {
        const result = rejectAction(req.params.id, 'dashboard');
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/test/pending-restart/:service', async (req, res) => {
    const service = req.params.service;
    const alertContext = {
        name: 'ManualRestartApprovalTest',
        severity: 'test',
        service,
        instance: 'local-docker-compose',
        description: `Manual HITL approval test for ${service}`,
        summary: `Create a pending restart approval for ${service}`,
        startsAt: new Date().toISOString(),
        endsAt: null
    };

    const analysis = {
        rootCause: 'Manual test action created to validate the HITL approval workflow.',
        confidence: 100,
        evidenceUsed: {
            metrics: ['Manual test; no Prometheus evidence required.'],
            logs: ['Manual test; no Loki evidence required.'],
            traces: ['Manual test; no Jaeger evidence required.']
        },
        traceIds: [],
        correlatedSignals: ['Manual approval workflow test'],
        missingSignals: [],
        recommendedActions: [
            {
                priority: 1,
                action: 'restart_service',
                description: `Restart ${service} to test approval and execution.`,
                reason: 'This action is intentionally high-risk so it should require human approval.',
                service
            }
        ]
    };

    try {
        const actionRequest = await handleRecommendedAction(analysis.recommendedActions[0], alertContext);
        await sendSlackApproval(alertContext, analysis, bolt, [actionRequest]);

        res.json({
            status: 'created',
            action: actionRequest,
            dashboard: '/dashboard'
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/dashboard', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html>
<head>
  <title>AIOps Remediation Approvals</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f172a;
      --panel: #111827;
      --panel-soft: #1f2937;
      --border: #334155;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --green: #22c55e;
      --green-soft: rgba(34, 197, 94, 0.14);
      --red: #f87171;
      --red-soft: rgba(248, 113, 113, 0.14);
      --amber: #fbbf24;
      --amber-soft: rgba(251, 191, 36, 0.14);
      --blue: #60a5fa;
      --blue-soft: rgba(96, 165, 250, 0.14);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(59, 130, 246, 0.16), transparent 32rem),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 32px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 28px;
      letter-spacing: -0.03em;
    }

    .subtitle {
      color: var(--muted);
      margin: 0 0 24px;
    }

    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(17, 24, 39, 0.9);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
    }

    table {
      border-collapse: collapse;
      width: 100%;
      min-width: 1080px;
    }

    th, td {
      border-bottom: 1px solid rgba(51, 65, 85, 0.72);
      padding: 12px 14px;
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #0b1220;
      color: #cbd5e1;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    tr:hover td { background: rgba(148, 163, 184, 0.06); }
    tr:last-child td { border-bottom: 0; }

    button {
      margin: 0 8px 8px 0;
      border: 0;
      border-radius: 10px;
      color: #08111f;
      cursor: pointer;
      font-weight: 700;
      padding: 8px 12px;
    }

    button:hover { filter: brightness(1.08); }
    .approve { background: var(--green); }
    .reject { background: var(--red); }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      padding: 4px 10px;
      white-space: nowrap;
    }

    .risk-high, .status-failed, .status-blocked, .status-validation_failed {
      background: var(--red-soft);
      color: var(--red);
    }

    .risk-low, .status-succeeded, .status-cancelled_resolved, .status-cancelled_already_recovered {
      background: var(--green-soft);
      color: var(--green);
    }

    .status-pending_approval, .status-validating, .status-executing, .status-expired, .status-alert_state_mismatch {
      background: var(--amber-soft);
      color: var(--amber);
    }

    .status-rejected {
      background: var(--blue-soft);
      color: var(--blue);
    }

    .reason { color: #d1d5db; max-width: 420px; }
    .time { color: #cbd5e1; white-space: nowrap; }
  </style>
</head>
<body>
  <h1>AIOps Remediation Approvals</h1>
  <p class="subtitle">Human-in-the-loop actions, validation state, and approval expiry.</p>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Risk</th>
          <th>Action</th>
          <th>Service</th>
          <th>Created</th>
          <th>Updated</th>
          <th>Expires</th>
          <th>Reason</th>
          <th>Decision</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <script>
    async function post(url) {
      await fetch(url, { method: 'POST' });
      await load();
    }

    async function load() {
      const res = await fetch('/approvals');
      const data = await res.json();

      const formatTime = (value) => {
        if (!value) {
          return '';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return value;
        }

        return date.toLocaleString();
      };

      document.getElementById('rows').innerHTML = data.actions.map(action => {
        const canDecide = action.status === 'pending_approval';

        return \`
          <tr>
            <td><span class="badge status-\${action.status}">\${action.status}</span></td>
            <td><span class="badge risk-\${action.risk}">\${action.risk}</span></td>
            <td>\${action.action}</td>
            <td>\${action.service || ''}</td>
            <td class="time">\${formatTime(action.createdAt)}</td>
            <td class="time">\${formatTime(action.updatedAt)}</td>
            <td class="time">\${formatTime(action.expiresAt)}</td>
            <td class="reason">\${action.reason || action.description || ''}</td>
            <td>
              \${canDecide ? \`
                <button class="approve" onclick="post('/approvals/\${action.id}/approve')">Approve</button>
                <button class="reject" onclick="post('/approvals/\${action.id}/reject')">Reject</button>
              \` : ''}
            </td>
          </tr>
        \`;
      }).join('');
    }

    load();
    setInterval(load, 3000);
  </script>
</body>
</html>
  `);
});


startIncidentWorker(processIncident);

app.post('/slack/events', bodyParser.urlencoded({ extended: false }), async (req, res) => {
    let payload;

    try {
        payload = JSON.parse(req.body.payload || '{}');
    } catch (error) {
        res.status(400).send('Invalid Slack payload');
        return;
    }
    
    res.status(200).send('');
    
    const action = payload.actions?.[0];
    const channel = payload.channel?.id || process.env.SLACK_CHANNEL_ID;
    const actor = payload.user?.username || payload.user?.name || payload.user?.id || 'slack';
    
    if (!action) {
        return;
    }
    
    try {
        const metadata = JSON.parse(action.value || '{}');
        let result;
        
        if (action.action_id === 'approve_remediation') {
            result = await approveAction(metadata.actionId, actor);
            await bolt.client.chat.postMessage({
                channel,
                text: `Remediation ${result.status}: ${result.action} for ${result.service}`
            });
            return;
        }
        
        if (action.action_id === 'reject_remediation') {
            result = rejectAction(metadata.actionId, actor);
            await bolt.client.chat.postMessage({
                channel,
                text: `Remediation rejected: ${result.action} for ${result.service}`
            });
        }
    } catch (error) {
        await bolt.client.chat.postMessage({
            channel,
            text: `Slack approval failed: ${error.message}`
        });
    }
});

app.listen(PORT, () => {
    console.log(`AI Remediation Agent listening on port ${PORT}`);
    console.log(`Alert webhook: http://localhost:${PORT}/alerts`);
});

module.exports = app;
