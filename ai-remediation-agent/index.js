const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
require('dotenv').config();

const { initSlackBot, sendSlackApproval } = require('./slack-bot');
const { analyzeAlert } = require('./groq-analyzer');

const app = express();
const PORT = process.env.PORT || 3003;
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
            { name: 'charges_per_min', query: 'rate(aiops_lab_charges_total[5m]) * 60' },
            { name: 'failed_charge_rate_pct', query: 'rate(aiops_lab_charges_total{status="failed"}[5m]) / rate(aiops_lab_charges_total[5m]) * 100' },
            { name: 'charge_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_charge_duration_milliseconds_bucket[5m]))' },
            { name: 'revenue_total_thb', query: 'aiops_lab_revenue_THB_total' }
        ];
    }

    if (service === 'api-gateway') {
        return [
            { name: 'api_requests_per_min', query: 'rate(aiops_lab_api_requests_total[5m]) * 60' },
            { name: 'orders_created_per_min', query: 'rate(aiops_lab_orders_created_total[5m]) * 60' },
            { name: 'api_p99_ms', query: 'histogram_quantile(0.99, rate(aiops_lab_api_request_duration_milliseconds_bucket[5m]))' }
        ];
    }

    if (service === 'order-service') {
        return [
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

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ai-remediation-agent' });
});

app.post('/alerts', async (req, res) => {
    try {
        const alerts = req.body.alerts || [];
        console.log(`Received ${alerts.length} alert(s)`);

        for (const alert of alerts) {
            if (alert.status !== 'firing') {
                continue;
            }

            console.log(`Processing alert: ${alert.labels.alertname}`);

            const alertContext = {
                name: alert.labels.alertname,
                severity: alert.labels.severity || 'unknown',
                service: resolveServiceFromAlert(alert),
                instance: alert.labels.instance || 'unknown',
                description: alert.annotations.description || '',
                summary: alert.annotations.summary || '',
                startsAt: alert.startsAt,
                endsAt: alert.endsAt
            };

            console.log('Alert Context:', alertContext);
            console.log('Collecting evidence from Prometheus, Loki, and Jaeger...');
            const evidence = await collectEvidence(alert, alertContext);
            console.log('Evidence Bundle:', {
                service: evidence.alert.service,
                metricGroups: evidence.metrics.snapshot.length,
                logErrors: evidence.logs.errorCount,
                traces: evidence.traces.totalTraces
            });

            console.log('Analyzing with Groq...');
            const analysis = await analyzeAlert(alertContext, evidence);
            console.log('Analysis Result:', analysis);

            console.log('Sending approval request to Slack...');
            await sendSlackApproval(alertContext, analysis, bolt);
        }

        res.json({ status: 'received', count: alerts.length });
    } catch (error) {
        console.error('Error processing alerts:', error);
        res.status(500).json({ error: error.message });
    }
});

bolt.action('approve_remediation', async ({ body, ack, say }) => {
    await ack();

    const metadata = JSON.parse(body.action[0].value);
    console.log(`User ${body.user.name} approved action: ${metadata.action}`);

    try {
        const result = await executeAction(metadata);

        await say({
            text: `Remediation executed successfully.\n${result}`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*Remediation Executed*\n\`\`\`${result}\`\`\``
                    }
                }
            ]
        });
    } catch (error) {
        await say({
            text: `Remediation failed: ${error.message}`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*Remediation Failed*\n\`\`\`${error.message}\`\`\``
                    }
                }
            ]
        });
    }
});

bolt.action('reject_remediation', async ({ body, ack, say }) => {
    await ack();

    console.log(`User ${body.user.name} rejected remediation`);

    await say({
        text: 'Remediation rejected by user. Manual intervention required.',
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Remediation Rejected*\nNo automatic action taken. Please investigate manually.`
                }
            }
        ]
    });
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

app.listen(PORT, () => {
    console.log(`AI Remediation Agent listening on port ${PORT}`);
    console.log(`Alert webhook: http://localhost:${PORT}/alerts`);
});

app.post('/slack/events', async (req, res) => {
    await bolt.processEvent(req);
    res.status(200).end();
});

bolt.start(process.env.SLACK_PORT || 3000).then(() => {
    console.log('Slack bot started');
});

module.exports = app;
