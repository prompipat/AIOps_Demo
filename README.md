# AIOps Lab

This project is a small observability demo built with Docker Compose. It contains:

- 3 Node.js services
- 1 OpenTelemetry Collector
- 1 Prometheus instance
- 1 Grafana instance
- 1 load generator

The services are wired together like this:

`load-generator -> api-gateway -> order-service -> payment-service`

Each app emits traces and metrics through the OpenTelemetry Collector, which forwards metrics to Prometheus and makes them available to Grafana.

## Services

| Service | Purpose | Host Port | Container Port |
| --- | --- | --- | --- |
| api-gateway | Accepts incoming order requests | `3000` | `3000` |
| order-service | Creates an order and calls payment | `3001` | `3001` |
| payment-service | Simulates payment charging | `3002` | `3002` |
| otel-collector | Receives traces and metrics | `4317`, `4318`, `8889` | same |
| prometheus | Scrapes metrics from the collector | `9090` | `9090` |
| grafana | Dashboard UI | `3030` | `3000` |
| load-generator | Sends test traffic | none | none |

## URLs

- API Gateway: `http://localhost:3000`
- Order Service health: `http://localhost:3001/health`
- Payment Service health: `http://localhost:3002/health`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3030`

## Requirements

- Docker
- Docker Compose

## Run

Start everything from the project root:

```bash
docker compose up --build
```

Stop everything:

```bash
docker compose down
```

## API

Create an order through the gateway:

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"item":"laptop","quantity":2,"userId":"user-001"}'
```

Request body:

- `item`: product name
- `quantity`: number of items
- `userId`: customer id

## Observability

The project uses OpenTelemetry in all three Node.js apps.

- Traces are exported to the collector over gRPC on `4317`
- Metrics are exported to the collector over gRPC on `4317`
- The collector exposes Prometheus metrics on `8889`
- Prometheus scrapes the collector
- Grafana reads from Prometheus

Grafana is configured with a Prometheus datasource at `http://prometheus:9090`.

## Troubleshooting

If a page is not reachable:

- Make sure you are using the correct host port
  - Grafana is `3030`, not `3000`
  - Prometheus is `9090`
  - API Gateway is `3000`
- Rebuild the stack after code changes:

```bash
docker compose down
docker compose up --build
```

- Check whether the container is restarting:

```bash
docker compose ps
```

- If Grafana loads but dashboards are empty, verify Prometheus is up and scraping `otel-collector:8889`

## Notes

- The load generator sends requests every 2 seconds after startup.
- It also sends a short burst of requests after a 5 second warmup.
- The repository includes service-local `package-lock.json` files and `Dockerfile`s for each Node.js service.
