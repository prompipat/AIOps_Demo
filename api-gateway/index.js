const axios = require('axios');
const express = require('express');
const { trace, metrics } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const tracer = trace.getTracer('api-gateway');
const meter = metrics.getMeter('api-gateway');

const requestCounter = meter.createCounter('api.requests.total', {
  description: 'Total API requests',
});

const orderCounter = meter.createCounter('orders.created.total', {
  description: 'Total orders created',
});

const latencyHistogram = meter.createHistogram('api.request.duration', {
  description: 'API request duration in ms',
  unit: 'ms',
});

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

app.post('/order', async (req, res) => {
  const startTime = Date.now();
  const { item, quantity, userId } = req.body;

  requestCounter.add(1, { route: '/order', method: 'POST' });

  const span = tracer.startSpan('create-order');
  span.setAttributes({ 'order.item': item, 'order.quantity': quantity, 'user.id': userId });
  console.log(buildLog('api-gateway', 'info', 'received order request', {
    route: '/order',
    method: 'POST',
    userId,
    item,
    quantity
  }, span));

  try {
    const headers = {};
    if (req.headers['x-force-payment-failure'] === 'true') {
      headers['x-force-payment-failure'] = 'true';
    }

    const orderRes = await axios.post('http://order-service:3001/create', {
      item,
      quantity,
      userId,
    }, { headers });

    console.log(buildLog('api-gateway', 'info', 'order request completed', {
      route: '/order',
      method: 'POST',
      status: 'success',
      duration_ms: Date.now() - startTime
    }, span));

    orderCounter.add(1, { status: 'success', item });
    span.setStatus({ code: 1 });
    res.json({ success: true, order: orderRes.data });
  } catch (err) {
    orderCounter.add(1, { status: 'failed' });
    span.recordException(err);
    span.setStatus({ code: 2, message: err.message });
    res.status(500).json({ error: err.message });
    console.error(buildLog('api-gateway', 'error', 'order request failed', {
      route: '/order',
      method: 'POST',
      status: 'failed',
      error: err.message,
      duration_ms: Date.now() - startTime
    }, span));
  } finally {
    span.end();
    latencyHistogram.record(Date.now() - startTime, { route: '/order' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'api-gateway' }));

app.listen(3000, () => console.log('api-gateway: 3000'));
