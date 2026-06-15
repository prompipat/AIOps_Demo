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

const FAILURE_RATE = 0.85;

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

  await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

  if (Math.random() < FAILURE_RATE) {
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
      reason: 'insufficient_funds',
      duration_ms: Date.now() - start
    }, span));
    return res.status(402).json({ success: false, reason: 'insufficient_funds' });
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
app.listen(3002, () => console.log('payment-service :3002'));
