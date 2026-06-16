# Autonomous Remediation via MCP Design

## Scope

This design adds autonomous remediation to the local Docker Compose AIOps lab. It keeps the current alert, evidence collection, Groq RCA, and Slack notification flow, then inserts a policy-gated execution path between recommended actions and infrastructure changes.

The first version targets local Docker Compose only. It does not include SSH, Kubernetes, cloud APIs, database rollback automation, or production deployment hardening.

## Goals

- Execute low-risk remediation actions automatically.
- Require human approval before high-impact actions.
- Route all execution through an MCP-style tool boundary instead of direct shell execution inside the LLM-facing agent.
- Provide a dashboard with Approve and Reject controls.
- Keep Slack approval support, but make Slack and dashboard use the same approval state machine.
- Record an audit trail for proposed, approved, rejected, executed, and failed actions.

## Non-Goals

- Production-grade authorization or identity management.
- Durable database storage.
- Multi-cluster or multi-host remediation.
- Arbitrary command execution.
- Letting model output directly become shell commands.

## Current System

Alertmanager sends firing alerts to `ai-remediation-agent`. The agent enriches alerts with Prometheus, Loki, and Jaeger evidence, sends that context to Groq, receives RCA plus recommended actions, and posts the result to Slack. Slack buttons currently call `executeAction()`, which performs direct local shell operations such as `docker-compose restart`.

## Proposed Architecture

The remediation path will be split into five units:

1. `remediation-policy`
   Maps allowed action names to risk level, approval requirement, and allowed services.

2. `action-orchestrator`
   Converts LLM recommendations into normalized action requests, evaluates policy, and decides whether to execute, queue for approval, or block.

3. `mcp-docker-server`
   Exposes a small allowlisted set of Docker Compose tools. The first implementation may use an HTTP JSON interface with MCP-style tool names and arguments, then migrate to a full MCP SDK without changing orchestrator behavior.

4. `approval-store`
   Stores pending approvals and audit events. For the lab, an in-memory store is acceptable. A JSON file can be added later if restart persistence is needed.

5. `approval-dashboard`
   Serves a local dashboard from `ai-remediation-agent` so engineers can approve or reject high-risk actions.

## Action Policy

Actions are allowlisted. Unknown actions are blocked.

Initial policy:

| Action | Risk | Approval | Notes |
| --- | --- | --- | --- |
| `check_logs` | low | no | Read-only local logs. |
| `view_metrics` | low | no | Read-only Prometheus query. |
| `restart_service` | high | yes | Mutates service state. |

Allowed services:

- `api-gateway`
- `order-service`
- `payment-service`

The policy layer must reject unknown services, unknown action names, missing arguments, and any action marked unsafe by default.

## Action State Machine

Each recommendation becomes an action request.

States:

- `proposed`
- `blocked`
- `auto_executing`
- `pending_approval`
- `approved`
- `rejected`
- `executing`
- `succeeded`
- `failed`

Low-risk actions move from `proposed` to `auto_executing` to `succeeded` or `failed`.

High-risk actions move from `proposed` to `pending_approval`. When an engineer approves, they move to `approved`, then `executing`, then `succeeded` or `failed`. Rejected actions move to `rejected` and do not execute.

## MCP Tool Boundary

The Docker executor should expose only structured tool calls:

- `docker_compose.logs`
  - arguments: `service`, `tail`
  - returns recent logs

- `docker_compose.restart`
  - arguments: `service`
  - restarts an allowlisted Docker Compose service

- `docker_compose.ps`
  - arguments: none
  - returns container status

The executor must never accept raw shell commands from the LLM or API caller.

## API Endpoints

Add these routes to `ai-remediation-agent`:

- `GET /approvals`
  Returns pending and recent action requests.

- `POST /approvals/:id/approve`
  Approves and executes a pending action.

- `POST /approvals/:id/reject`
  Rejects a pending action.

- `GET /dashboard`
  Returns the approval dashboard HTML.

Slack button handlers should call the same approval functions used by these HTTP routes.

## Data Flow

1. Alertmanager sends a firing alert to `/alerts`.
2. The agent collects Prometheus, Loki, and Jaeger evidence.
3. Groq returns RCA and recommended actions.
4. The orchestrator evaluates each recommended action against policy.
5. Low-risk actions execute through the MCP Docker tool boundary.
6. High-risk actions are stored as pending approvals.
7. Slack and dashboard show the pending action.
8. An engineer approves or rejects.
9. Approved actions execute through the MCP Docker tool boundary.
10. The agent records audit events and reports the result.

## Error Handling

- If policy evaluation fails, block the action and record the reason.
- If MCP execution fails, mark the action `failed` with the error message.
- If approval references an unknown action ID, return `404`.
- If an action is already approved, rejected, succeeded, or failed, reject duplicate approval attempts.
- If the LLM recommends an unsupported action, do not execute it automatically.

## Testing

Add focused tests for:

- policy classification
- unknown action rejection
- unknown service rejection
- low-risk auto-execution path
- high-risk approval path
- duplicate approval rejection
- executor allowlist behavior

Manual lab validation:

1. Start the Docker Compose stack.
2. Trigger a payment alert.
3. Confirm read-only actions can run automatically.
4. Confirm `restart_service` appears in Slack and dashboard as pending.
5. Approve from the dashboard.
6. Confirm the target service restarts and the audit record shows success.

