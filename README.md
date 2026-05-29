# AIOps Lab

A small observability demo for the team. It runs three Node.js services plus an OpenTelemetry Collector, Prometheus, Grafana, and a load generator through Docker Compose.

System flow:

`load-generator -> api-gateway -> order-service -> payment-service`

Each service emits traces and metrics through the OpenTelemetry SDK. The collector receives telemetry, exposes Prometheus metrics on port `8889`, Prometheus scrapes the collector, and Grafana reads from Prometheus.

## Quick Start

1. Start the stack:

```bash
docker compose up --build
```

2. Wait until all containers are up, especially the load generator and `otel-collector`.

3. Verify the services:

```bash
curl http://localhost:3000/health
curl http://localhost:3001/health
curl http://localhost:3002/health
```

4. Check that metrics are flowing:

```bash
curl -s http://localhost:8889/metrics | grep aiops_lab | head -10
```

5. Open the UIs:

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3030`

## Services

| Service | Purpose | Host Port | Notes |
| --- | --- | --- | --- |
| api-gateway | Accepts order requests | `3000` | Exposes `/order` and `/health` |
| order-service | Processes orders and calls payment | `3001` | Exposes `/create` and `/health` |
| payment-service | Simulates payment charging | `3002` | Uses a failure rate of about 15% |
| otel-collector | Receives telemetry and exposes metrics | `4317`, `4318`, `8889` | Prometheus metrics are available on `/metrics` via `8889` |
| prometheus | Scrapes metrics from the collector | `9090` | Used as Grafana datasource |
| grafana | Dashboard UI | `3030` | Anonymous access is enabled |
| load-generator | Sends traffic into the gateway | none | Produces the traffic needed for metrics and traces |

## URLs

- API Gateway: `http://localhost:3000`
- API Gateway health: `http://localhost:3000/health`
- Order Service health: `http://localhost:3001/health`
- Payment Service health: `http://localhost:3002/health`
- Collector metrics: `http://localhost:8889/metrics`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3030`

## Running the stack

From the project root:

```bash
docker compose up --build
```

To stop everything:

```bash
docker compose down
```

If you change service code or config, rebuild the stack so the new version is picked up.

## Testing the demo

Create an order through the gateway:

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"item":"laptop","quantity":2,"userId":"user-001"}'
```

Request body:

- `item`: product name
- `quantity`: number of items
- `userId`: customer ID

If the stack and load generator are running, requests should flow through the gateway, order service, and payment service in that order.

## Observability

This project uses OpenTelemetry in all three services.

- Traces are exported to the collector over gRPC on `4317`
- Metrics are exported to the collector over gRPC on `4317`
- The collector exposes Prometheus metrics on `8889`
- Prometheus scrapes `otel-collector:8889`
- Grafana reads data from Prometheus

Important behavior:

- Metrics appear only after there is real traffic
- If no request has been sent yet, `http://localhost:8889/metrics` may be empty
- The load generator is the main source of traffic for the demo

## Expected behavior

When the system is healthy, you should see:

- `docker compose ps` shows the core services running
- `curl http://localhost:3000/health` returns `ok`
- `curl http://localhost:8889/metrics` returns metrics in the `aiops_lab` namespace after traffic starts
- Collector logs show telemetry activity such as `ResourceMetrics` or data from `api-gateway`

## Troubleshooting

### 1. `/metrics` is empty

- Check that the load generator is running
- Send a request manually to `http://localhost:3000/order`
- Check whether the collector is still running and not stuck in a restart loop

### 2. Grafana dashboards are empty

- Verify Prometheus is running at `http://localhost:9090`
- Confirm Prometheus scrapes `otel-collector:8889`
- Confirm the collector is receiving metrics

### 3. Services cannot reach each other

- `api-gateway` calls `order-service:3001`
- `order-service` calls `payment-service:3002`
- In Docker Compose, all services should be on the same network

### 4. View logs

```bash
docker compose logs --tail=50 otel-collector
docker compose logs --tail=50 api-gateway
docker compose logs --tail=50 order-service
docker compose logs --tail=50 payment-service
```

## Notes

- The load generator sends a request every 2 seconds after startup
- After a 5 second warm-up, it sends a burst of 10 additional requests
- Prometheus and Grafana are part of the observability demo, not a production-ready deployment
