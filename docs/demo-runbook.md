# AIOps Lab Demo Runbook

This runbook gives you a repeatable learning demo: create an incident, observe signals, let the AI agent analyze evidence, approve remediation, and confirm recovery.

## 1. Start The Lab

```bash
docker compose up --build -d
```

Useful URLs:

- Grafana: `http://localhost:3030`
- Prometheus alerts: `http://localhost:9090/alerts`
- Alertmanager: `http://localhost:9093`
- Jaeger: `http://localhost:16686`
- AI agent dashboard: `http://localhost:3003/dashboard`
- AI agent incidents: `http://localhost:3003/incidents`

## 2. Optional Offline LLM Mode

For demos without a Groq API key, set this in `.env`:

```bash
LLM_PROVIDER=fake
```

Then restart the AI agent:

```bash
docker compose up --build -d ai-remediation-agent
```

Fake mode returns deterministic analysis so the demo flow still works.

## 3. Confirm Normal Traffic

The load generator sends traffic automatically. You can also send a manual order:

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d "{\"item\":\"laptop\",\"quantity\":2,\"userId\":\"user-001\"}"
```

Check that services are healthy:

```bash
curl http://localhost:3000/health
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

## 4. Scenario A: Forced Payment Failures

Turn on deterministic payment failures:

```bash
curl -X POST http://localhost:3002/test/fail-payments/on
```

Watch:

- Prometheus alerts: `http://localhost:9090/alerts`
- Grafana: `http://localhost:3030`
- AI incidents: `http://localhost:3003/incidents`
- Slack approval message, if Slack is configured

Inspect the current payment fault state:

```bash
curl http://localhost:3002/test/faults
```

Turn the fault off:

```bash
curl -X POST http://localhost:3002/test/fail-payments/off
```

## 5. Scenario B: Payment Latency

Add 1200 ms of extra latency to each charge request:

```bash
curl -X POST http://localhost:3002/test/latency/on \
  -H "Content-Type: application/json" \
  -d "{\"latencyMs\":1200}"
```

Watch latency metrics and traces. Then disable latency:

```bash
curl -X POST http://localhost:3002/test/latency/off
```

## 6. Scenario C: Service Down And Approved Restart

Stop the payment service:

```bash
docker stop $(docker ps -q --filter label=com.docker.compose.service=payment-service)
```

When `PaymentServiceDown` fires, the AI agent should recommend `restart_service`. Restart is high risk, so the action waits for approval in Slack or the local dashboard:

```text
http://localhost:3003/dashboard
```

Approve the action and confirm the payment service starts again.

## 7. Inspect Evidence Sent To The LLM

List incidents:

```bash
curl http://localhost:3003/incidents
```

Open evidence for an incident:

```bash
curl http://localhost:3003/incidents/<incident-id>/evidence
```

This is the best learning endpoint in the project. It shows the alert context, metric snapshots, log samples, trace summaries, correlated signals, and missing signals that the LLM used.

## 8. Reset Demo Faults

```bash
curl -X POST http://localhost:3002/test/fail-payments/off
curl -X POST http://localhost:3002/test/latency/off
```

If needed, restart the stack:

```bash
docker compose restart
```
