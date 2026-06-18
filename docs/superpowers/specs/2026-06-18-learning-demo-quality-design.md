# Learning Demo Quality Design

## Goal

Improve the project as a beginner-friendly AIOps learning lab without turning it into a production platform. The demo should make it easy to trigger a known incident, observe telemetry, see the AI evidence bundle, understand the LLM's role, and approve safe remediation.

## Scope

- Add a guided demo runbook.
- Clarify that the current `mcp-docker-client.js` is an MCP-style local Docker tool adapter, not a full MCP protocol implementation.
- Add deterministic payment-service fault injection endpoints.
- Expose collected incident evidence from the AI remediation agent.
- Add a fake/offline LLM mode for demos without Groq credentials.
- Split the README architecture explanation into request, observability, and AI remediation diagrams.

## Non-Goals

- Build a real standalone MCP server.
- Add authentication or production-grade authorization.
- Replace Grafana, Prometheus, Loki, Jaeger, or Alertmanager.
- Build a large custom frontend.

## Design

`payment-service` gets demo-only control endpoints under `/test/*`. These endpoints control in-memory fault state for forced payment failures and extra latency. They are intentionally simple because the service is a local lab component.

`ai-remediation-agent` stores the last collected evidence and analysis on each queued incident object. New endpoints expose incident details and evidence so learners can inspect what context was given to the LLM.

`groq-analyzer.js` supports `LLM_PROVIDER=fake`. Fake mode returns deterministic JSON in the same shape as the Groq analyzer, which keeps the rest of the workflow unchanged.

The MCP clarification stays documentation-first. The existing Docker wrapper remains compatible with the current code, but comments and docs explain that it is an MCP-style tool boundary around Docker CLI commands.

## Verification

- Confirm JavaScript syntax with `node --check` on changed files.
- Confirm docs include the new runbook, MCP explanation, fault injection commands, evidence viewer, fake LLM mode, and split diagrams.
