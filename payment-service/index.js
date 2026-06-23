const express = require('express');
const { trace, metrics } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const tracer = trace.getTracer('payment-service');
const meter = metrics.getMeter('payment-service');

const chargeCounter = meter.createCounter('charges.total', {
  description: 'Total payment charges',
});
const revenueCounter = meter.createCounter('revenue.total', {
  description: 'Total revenue processed',
  unit: 'THB',
});
const chargeLatency = meter.createHistogram('charge.duration', { unit: 'ms' });

const FAILURE_RATE = 0.05;
const faultState = {
  forceFailures: false,
  extraLatencyMs: 0
};

function renderPrometheusMetrics() {
  return [
    '# HELP aiops_lab_payment_service_info Static info metric for payment-service direct scrape health.',
    '# TYPE aiops_lab_payment_service_info gauge',
    'aiops_lab_payment_service_info{service="payment-service"} 1',
    ''
  ].join('\n');
}

function buildLog(service, level, msg, extra = {}, span = null) {
  const spanContext = span?.spanContext?.() || null;
  return JSON.stringify({
    service,
    level,
    msg,
    trace_id: spanContext?.traceId || null,
    span_id: spanContext?.spanId || null,
    ...extra
  });
}

app.post('/charge', async (req, res) => {
  const start = Date.now();
  const { orderId, amount, userId } = req.body;

  const span = tracer.startSpan('charge-payment');
  span.setAttributes({
    'payment.order_id': orderId,
    'payment.amount': amount,
    'payment.currency': 'THB',
    'user.id': userId,
  });

  console.log(buildLog('payment-service', 'info', 'received charge request', {
    route: '/charge',
    method: 'POST',
    orderId,
    amount,
    currency: 'THB'
  }, span));

  await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200 + faultState.extraLatencyMs));

  const forcedFailure = req.headers['x-force-payment-failure'] === 'true';

  if (forcedFailure || faultState.forceFailures || Math.random() < FAILURE_RATE) {
    chargeCounter.add(1, { status: 'failed', reason: 'insufficient_funds' });
    span.recordException(new Error('Payment declined: insufficient funds'));
    span.setStatus({ code: 2, message: 'payment_failed' });
    span.end();
    chargeLatency.record(Date.now() - start, { status: 'failed' });
    console.error(buildLog('payment-service', 'error', 'charge failed', {
      route: '/charge',
      method: 'POST',
      orderId,
      amount,
      currency: 'THB',
      status: 'failed',
      reason: faultState.forceFailures ? 'demo_forced_failure' : 'insufficient_funds',
      forcedFailure: forcedFailure || faultState.forceFailures,
      duration_ms: Date.now() - start
    }, span));
    return res.status(402).json({
      success: false,
      reason: faultState.forceFailures ? 'demo_forced_failure' : 'insufficient_funds'
    });
  }

  const transactionId = `TXN-${Date.now()}`;
  chargeCounter.add(1, { status: 'success' });
  revenueCounter.add(amount, { currency: 'THB' });
  span.setStatus({ code: 1 });
  span.end();
  chargeLatency.record(Date.now() - start, { status: 'success' });

  console.log(buildLog('payment-service', 'info', 'charge succeeded', {
    route: '/charge',
    method: 'POST',
    orderId,
    amount,
    currency: 'THB',
    status: 'success',
    transactionId,
    duration_ms: Date.now() - start
  }, span));

  res.json({ success: true, transactionId, amount });
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'payment-service' }));
app.get('/metrics', (_, res) => {
  res.type('text/plain; version=0.0.4; charset=utf-8').send(renderPrometheusMetrics());
});
app.get('/test/faults', (_, res) => res.json({
  service: 'payment-service',
  faults: faultState
}));
app.post('/test/fail-payments/on', (_, res) => {
  faultState.forceFailures = true;
  res.json({ status: 'enabled', fault: 'forceFailures', faults: faultState });
});
app.post('/test/fail-payments/off', (_, res) => {
  faultState.forceFailures = false;
  res.json({ status: 'disabled', fault: 'forceFailures', faults: faultState });
});
app.post('/test/latency/on', (req, res) => {
  const requestedLatency = Number(req.body?.latencyMs ?? 1000);
  faultState.extraLatencyMs = Number.isFinite(requestedLatency)
    ? Math.max(0, Math.min(10000, Math.round(requestedLatency)))
    : 1000;
  res.json({ status: 'enabled', fault: 'extraLatencyMs', faults: faultState });
});
app.post('/test/latency/off', (_, res) => {
  faultState.extraLatencyMs = 0;
  res.json({ status: 'disabled', fault: 'extraLatencyMs', faults: faultState });
});
app.listen(3002, () => console.log('payment-service :3002'));
