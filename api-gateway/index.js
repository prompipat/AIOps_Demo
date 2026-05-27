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

app.post('/order', async (req, res) => {
  const startTime = Date.now();
  const { item, quantity, userId } = req.body;

  requestCounter.add(1, { route: '/order', method: 'POST' });

  // manual span สำหรับ business logic
  const span = tracer.startSpan('create-order');
  span.setAttributes({ 'order.item': item, 'order.quantity': quantity, 'user.id': userId });

  try {
    // เรียก order-service
    const orderRes = await axios.post('http://order-service:3001/create', {
      item, quantity, userId,
    });

    orderCounter.add(1, { status: 'success', item });
    span.setStatus({ code: 1 }); // OK
    res.json({ success: true, order: orderRes.data });
  } catch (err) {
    orderCounter.add(1, { status: 'failed' });
    span.recordException(err);
    span.setStatus({ code: 2, message: err.message }); // ERROR
    res.status(500).json({ error: err.message });
  } finally {
    span.end();
    latencyHistogram.record(Date.now() - startTime, { route: '/order' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'api-gateway'}));

app.listen(3000, () => console.log('api-gateway: 3000'));