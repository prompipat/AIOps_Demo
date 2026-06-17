const axios = require('axios');
const express = require('express');
const { trace, metrics } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const tracer = trace.getTracer('order-service');
const meter = metrics.getMeter('order-service');

const paymentCounter = meter.createCounter('payments.attempted.total');
const orderProcessDuration = meter.createHistogram('order.processing.duration', { unit: 'ms' });

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

app.post('/create', async (req, res) => {
  const start = Date.now();
  const { item, quantity, userId } = req.body;

  const span = tracer.startSpan('process-order');
  span.setAttributes({ 'order.item': item, 'order.quantity': quantity, 'user.id': userId });
  console.log(buildLog('order-service', 'info', 'received payment request', {
    route: '/payment',
    method: 'POST',
    userId,
    item,
    quantity
  }, span));

  try {
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

    const orderId = `ORD-${Date.now()}`;

    const headers = {};
    if (req.headers['x-force-payment-failure'] === 'true') {
      headers['x-force-payment-failure'] = 'true';
    }

    const payRes = await axios.post('http://payment-service:3002/charge', {
      orderId,
      amount: quantity * 100,
      userId,
    }, { headers });

    paymentCounter.add(1, { status: 'success' });
    span.setStatus({ code: 1 });
    res.json({ orderId, item, quantity, payment: payRes.data });
    console.log(buildLog('order-service', 'info', 'payment request completed', {
      route: '/payment',
      method: 'POST',
      status: 'success',
      duration_ms: Date.now() - start,
      orderId
    }, span));
  } catch (err) {
    paymentCounter.add(1, { status: 'failed' });
    span.recordException(err);
    span.setStatus({ code: 2, message: err.message });
    res.status(500).json({ error: err.message });
    console.error(buildLog('order-service', 'error', 'payment request failed', {
      route: '/payment',
      method: 'POST',
      status: 'failed',
      error: err.message,
      duration_ms: Date.now() - start
    }, span));
  } finally {
    span.end();
    orderProcessDuration.record(Date.now() - start);
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'order-service' }));
app.listen(3001, () => console.log('order-service :3001'));
