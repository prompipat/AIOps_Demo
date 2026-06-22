# AIOps Lab

AIOps Lab is a local Docker Compose demo for observability and AI-assisted incident response.

It combines:

- distributed tracing
- metrics and alerting
- centralized logs
- Grafana dashboards
- AI analysis with Groq free tier or fake offline mode
- Slack notifications with recommended next actions

The core request path is:

`load-generator -> api-gateway -> order-service -> payment-service`

Each service emits telemetry with OpenTelemetry. Prometheus evaluates alert rules, Alertmanager routes alerts to the AI remediation agent, and the agent enriches each alert with Prometheus metrics, Loki logs, and Jaeger traces before sending one combined evidence bundle to Groq.

## What This Project Does

- Simulates a small e-commerce style request flow
- Generates traces, metrics, and logs for observability practice
- Triggers alerts from Prometheus when service health degrades
- Sends alert payloads to an AI remediation agent
- Uses Groq LLM to produce:
  - root cause analysis
  - confidence score
  - prioritized remediation actions
  - evidence-based incident summaries
- Posts the analysis to Slack for human review

## AI Features

The AI remediation agent currently supports:

- root cause analysis from alert context plus evidence enrichment
- Prometheus metric snapshots and trend summaries
- Loki log correlation using `trace_id`
- Jaeger trace lookup using linked trace IDs
- next-action recommendations ordered by priority
- confidence scoring for the diagnosis
- Slack approval flow for recommended remediation

Groq is used through the `groq-sdk` package. The default model is `qwen/qwen3-32b`, and it can be changed with `GROQ_MODEL`.
For repeatable demos without an API key, set `LLM_PROVIDER=fake`.
If Groq is unavailable or the API key is missing, the agent falls back to a simple non-AI response so alert handling still continues.

## Architecture

- `load-generator` sends requests into the demo automatically
- `api-gateway` accepts orders and forwards them to `order-service`
- `order-service` simulates business processing and calls `payment-service`
- `payment-service` simulates payment handling and intermittent failures
- `otel-collector` receives telemetry from the services
- `prometheus` scrapes metrics and evaluates alert rules
- `grafana` displays dashboards for metrics and logs
- `loki` stores logs and `promtail` ships container logs into it
- `alertmanager` routes alerts to `ai-remediation-agent`
- `ai-remediation-agent` receives alerts, enriches them with metrics/logs/traces, analyzes them with Groq, and sends recommendations to Slack
- `jaeger` provides distributed trace visibility
- `webhook-logger` is available for alert delivery demos

### Request Flow

```mermaid
graph TD
    LG[load-generator] -->|POST /order| AG[api-gateway]
    AG -->|POST /create| OS[order-service]
    OS -->|POST /charge| PS[payment-service]
```

### Observability Flow

```mermaid
graph TD
    AG[api-gateway] -->|stdout JSON logs| PT[promtail]
    OS[order-service] -->|stdout JSON logs| PT
    PS[payment-service] -->|stdout JSON logs| PT
    PT -->|push logs| LK[loki]

    AG -->|OTLP traces + metrics| OC[otel-collector]
    OS -->|OTLP traces + metrics| OC
    PS -->|OTLP traces + metrics| OC

    OC -->|traces| JG[jaeger]
    OC -->|metrics endpoint :8889| PM[prometheus]
    OC -.->|optional OTLP export| NR[newrelic]

    PM -->|datasource| GF[grafana]
    LK -->|datasource| GF
```

### AI Remediation Flow

```mermaid
graph TD
    PM[prometheus] -->|alert rules fire| AM[alertmanager]
    AM -->|webhook /alerts| AI[ai-remediation-agent]

    AI -->|query metrics| PM
    AI -->|query logs| LK[loki]
    AI -->|query traces| JG[jaeger]

    AI -->|evidence prompt| LLM[Groq or fake LLM]
    LLM -->|JSON analysis| AI

    AI -->|low-risk actions auto-run| DT[MCP-style Docker tools]
    AI -->|high-risk approval request| SL[Slack]
    SL -->|approve or reject| AI
    AI -->|approved restart/log action| DT

    DT -.-> AG[api-gateway]
    DT -.-> OS[order-service]
    DT -.-> PS[payment-service]
```

The Docker remediation layer is MCP-style, not a full standalone MCP server. See `docs/mcp-tool-boundary.md`.

## Project Structure

```text
.
|-- api-gateway/
|   |-- index.js
|   |-- tracing.js
|   `-- Dockerfile
|-- order-service/
|   |-- index.js
|   |-- tracing.js
|   `-- Dockerfile
|-- payment-service/
|   |-- index.js
|   |-- tracing.js
|   `-- Dockerfile
|-- ai-remediation-agent/
|   |-- Dockerfile
|   |-- index.js
|   |-- groq-analyzer.js
|   `-- slack-bot.js
|-- otel-collector/otel-config.yml
|-- prometheus/
|   |-- alert-rules.yml
|   `-- prometheus.yml
|-- grafana/provisioning/
|   |-- dashboards/dashboard.yml
|   `-- datasources/datasources.yml
|-- alertmanager/alertmanager.yml
|-- promtail/promtail-config.yml
|-- webhook-logger/
|   |-- Dockerfile
|   `-- server.js
|-- load-generator.js
`-- docker-compose.yml
```

## Services

| Service | Purpose | Port |
| --- | --- | --- |
| `api-gateway` | Accepts order requests and forwards them downstream | `3000` |
| `order-service` | Processes orders and calls payment | `3001` |
| `payment-service` | Simulates payment charging with failure cases | `3002` |
| `ai-remediation-agent` | Receives alerts, enriches evidence, and runs Groq analysis | `3003` |
| `otel-collector` | Receives OTLP telemetry and exposes Prometheus metrics | `4317`, `4318`, `8889` |
| `prometheus` | Scrapes metrics and evaluates alert rules | `9090` |
| `grafana` | Dashboard UI | `3030` |
| `loki` | Log storage | `3100` |
| `promtail` | Ships logs to Loki | internal |
| `alertmanager` | Routes alerts to the AI remediation agent | `9093` |
| `jaeger` | Trace UI | `16686` |
| `webhook-logger` | Demo webhook receiver | `5001` |

## Alert Flow

1. A request enters `api-gateway`.
2. The gateway calls `order-service`.
3. `order-service` calls `payment-service`.
4. Services emit metrics, traces, and logs.
5. Prometheus evaluates alert rules.
6. Alertmanager sends firing alerts to `http://ai-remediation-agent:3003/alerts`.
7. The AI agent enriches the alert with:
   - Prometheus metric snapshots and trend data
   - Loki logs from the incident window
   - Jaeger traces linked by `trace_id`
8. The AI agent sends the combined evidence bundle to Groq.
9. Groq returns:
   - the most likely root cause
   - a confidence score
   - three prioritized remediation actions
10. The agent posts the analysis and evidence summary to Slack for human approval.

## Prometheus Alert Rules

The current rules include:

- `HighPaymentErrorRate`
- `HighAPILatency`
- `PaymentServiceDown`
- `LowOrderSuccessRate`

These alerts are a good way to test the AI workflow because they provide enough context for Groq to suggest a likely cause and the next action to take.
The current AI workflow is strongest when the alert maps cleanly to a service, because the agent can then pull the right metrics, logs, and traces for that service.

## Quick Start

1. Start the full stack:

```bash
docker compose up --build -d
```

2. Wait for the containers to boot.

3. Check service health:

```bash
curl http://localhost:3000/health
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

4. Send a manual request:

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"item":"laptop","quantity":2,"userId":"user-001"}'
```

For a guided learning flow, see `docs/demo-runbook.md`.

## AI Setup

The AI layer can use Groq or fake offline mode plus Slack.

### 1. Choose LLM Provider

For real Groq analysis:

Create a Groq account and add this to your `.env` file:

```bash
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_your_api_key_here
GROQ_MODEL=qwen/qwen3-32b
GROQ_MAX_TOKENS=1024
```

`GROQ_MODEL` can be set to another free-tier model such as `llama-3.1-8b-instant` if you need to compare behavior. `GROQ_MAX_TOKENS` keeps responses predictable against Groq's per-minute token budget.

For repeatable local demos without a Groq key:

```bash
LLM_PROVIDER=fake
```

Fake mode returns deterministic JSON in the same shape as the Groq response, so evidence collection, policy checks, Slack approval, and Docker actions still run.

### 2. Slack App

Create a Slack app and add:

```bash
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_CHANNEL_ID=your-channel-id
```

The agent posts formatted alert analysis to Slack and includes buttons for approve/reject workflow.
The Slack card also shows evidence summaries, correlated signals, missing signals, and trace IDs used in the analysis.

### 3. Restart the AI Agent

```bash
docker compose up --build -d ai-remediation-agent
```

## Example AI Output

For a firing alert, the agent aims to produce output like this:

- root cause: most likely failure source for the alert
- confidence: percentage confidence score
- evidence used: metrics, logs, and traces that support the diagnosis
- trace IDs: linked trace IDs found in Loki and resolved in Jaeger
- recommended actions:
  1. restart the failing service
  2. check recent logs
  3. inspect metrics for saturation or latency

## Useful URLs

- API Gateway: `http://localhost:3000`
- API Gateway health: `http://localhost:3000/health`
- Order Service health: `http://localhost:3001/health`
- Payment Service health: `http://localhost:3002/health`
- AI Remediation Agent health: `http://localhost:3003/health`
- AI Remediation Agent dashboard: `http://localhost:3003/dashboard`
- AI incidents: `http://localhost:3003/incidents`
- AI incident evidence: `http://localhost:3003/incidents/<incident-id>/evidence`
- Remediation approvals: `http://localhost:3003/approvals`
- Remediation audit events: `http://localhost:3003/audit-events`
- Prometheus: `http://localhost:9090`
- Prometheus alerts: `http://localhost:9090/alerts`
- Grafana: `http://localhost:3030`
- Loki: `http://localhost:3100`
- Alertmanager: `http://localhost:9093`
- Jaeger: `http://localhost:16686`
- Webhook logger: `http://localhost:5001`
- Collector metrics: `http://localhost:8889/metrics`

## Request Pattern

The built-in load generator:

- sends one request every 2 seconds
- starts a burst of 10 extra requests after a 5 second warm-up

This keeps the demo active enough to populate dashboards and produce occasional alert activity.

## Demo Fault Injection

`payment-service` has deterministic demo controls:

```bash
curl http://localhost:3002/test/faults
curl -X POST http://localhost:3002/test/fail-payments/on
curl -X POST http://localhost:3002/test/fail-payments/off
curl -X POST http://localhost:3002/test/latency/on \
  -H "Content-Type: application/json" \
  -d '{"latencyMs":1200}'
curl -X POST http://localhost:3002/test/latency/off
```

Use these with `docs/demo-runbook.md` to create predictable incidents during demos.

## Observability Flow

- services export traces and metrics to the OpenTelemetry Collector over OTLP gRPC on `4317`
- the collector exposes Prometheus-format metrics on `8889`
- Prometheus scrapes the collector on a regular interval
- Promtail forwards Docker logs to Loki
- Grafana reads from Prometheus and Loki
- Alertmanager sends alert webhooks to the AI remediation agent
- the AI agent pulls Prometheus snapshots, Loki logs, and Jaeger traces, then sends one evidence bundle to Groq
- log records include `trace_id` and `span_id` so Loki entries can be correlated back to Jaeger traces

## Evidence Viewer

The AI agent stores evidence on each processed incident. List incidents, then open the evidence endpoint for one ID:

```bash
curl http://localhost:3003/incidents
curl http://localhost:3003/incidents/<incident-id>/evidence
```

This shows the context that was sent to the LLM: alert labels, metrics, logs, traces, correlated signals, missing signals, and the resulting analysis.

Restart approvals expire after 10 minutes. Before an approved restart executes,
the agent checks Docker, Prometheus, and Alertmanager twice, 30 seconds apart. A
healthy or recovered service cancels the restart; failed or inconsistent checks
fail closed and are recorded in the approval and audit endpoints.

## Troubleshooting

### No AI analysis in Slack

- check that `GROQ_API_KEY` is set
- check Slack credentials in `.env`
- confirm `ai-remediation-agent` is running
- review `docker compose logs -f ai-remediation-agent`

### Alerts are not firing

- make sure the load generator is running
- send a manual `POST /order` request
- verify Prometheus is scraping the collector

### Grafana looks empty

- confirm Prometheus is reachable at `http://localhost:9090`
- confirm Loki is running
- make sure the services are receiving traffic

### Services cannot reach each other

- `api-gateway` calls `order-service:3001`
- `order-service` calls `payment-service:3002`
- all services should share the same Docker Compose network

## Notes

- `payment-service` simulates failures so alerting can be tested
- the project is intended for local observability and AIOps practice, not production use
- if you change code or config, rebuild with `docker compose up --build`
