const axios = require('axios');
const express = require('express');
const { trace, metrics } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const tracer = trace.getTracer('order-service');
const meter = metrics.getMeter('order-service');

const paymentCounter = meter.createCounter('payments.attempted.total');
const orderProcessDuration = meter.createHistogram('order.processing.duration', { unit: 'ms' });

app.post('/create', async (req, res) => {
  const start = Date.now();
  const { item, quantity, userId } = req.body;

  const span = tracer.startSpan('process-order');
  span.setAttributes({ 'order.item': item, 'order.quantity': quantity });
  console.log(JSON.stringify({
    service: 'order-service',
    level: 'info',
    msg: 'received payment request',
    route: '/payment',
    method: 'POST',
    userId,
    item,
    quantity
  }));

  try {
    // จำลอง processing delay 50–150ms
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

    const orderId = `ORD-${Date.now()}`;

    // เรียก payment-service
    const payRes = await axios.post('http://payment-service:3002/charge', {
      orderId, amount: quantity * 100, userId,
    });

    paymentCounter.add(1, { status: 'success' });
    span.setStatus({ code: 1 });
    res.json({ orderId, item, quantity, payment: payRes.data });
    console.log(JSON.stringify({
      service: 'order-service',
      level: 'info',
      msg: 'payment request completed',
      route: '/payment',
      method: 'POST',
      status: 'success',
      duration_ms: Date.now() - start
    }))
  } catch (err) {
    paymentCounter.add(1, { status: 'failed' });
    span.recordException(err);
    span.setStatus({ code: 2, message: err.message });
    res.status(500).json({ error: err.message });
    console.error(JSON.stringify({
      service: 'order-service',
      level: 'error',
      msg: 'payment request failed',
      route: '/payment',
      method: 'POST',
      status: 'failed',
      error: err.message,
      duration_ms: Date.now() - start
    }))
  } finally {
    span.end();
    orderProcessDuration.record(Date.now() - start);
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'order-service' }));
app.listen(3001, () => console.log('order-service :3001'));