# Pre-Execution Remediation Validation Design

## Purpose

Prevent a delayed Slack approval from executing a stale restart. Approval permits
the agent to validate the proposed action; it does not guarantee execution.

This change applies pre-execution validation to `restart_service`. Read-only
actions keep their current behavior.

## Current Problem

High-risk restart actions can remain in `pending_approval` indefinitely. When an
engineer approves one, the agent immediately restarts the service using evidence
collected when the incident was processed. It does not verify whether the alert
has resolved, whether the service has recovered, or whether another operator has
already remediated it.

Alertmanager is not the source that should be edited to force an alert state.
Prometheus evaluates the alert rule and Alertmanager reflects the resulting
`firing` or `resolved` state.

## Decision

Before executing an approved restart, validate Docker service state and the
Prometheus alert condition twice, 30 seconds apart. A restart executes only when
both checks confirm that the service remains unhealthy and the alert condition
remains active.

If the service is healthy while Alertmanager still reports the alert as firing,
the agent does not modify Alertmanager. It verifies the condition again and then
records the internal incident as recovered or reports a state mismatch. Prometheus
is responsible for sending the eventual resolved state to Alertmanager.

## Configuration

Add environment variables with these defaults:

- `ACTION_APPROVAL_TTL_MS=600000` (10 minutes)
- `REMEDIATION_VALIDATION_INTERVAL_MS=30000` (30 seconds)
- `REMEDIATION_VALIDATION_ATTEMPTS=2`

The interval and attempt count are configurable so automated tests can run without
waiting 30 seconds. Production-like behavior uses the defaults above.

## Data Model

Each action request stores:

- `incidentId`: identifier of the incident that produced the action
- `expiresAt`: timestamp after which approval is stale
- `validation`: latest validation outcome and per-attempt observations

Each validation observation stores its timestamp, Docker result, Prometheus alert
result, and any error. It must not contain credentials or complete response bodies.

Each recovered incident additionally stores:

- `recoveredAt`
- `recoveryReason`

The action and incident stores remain in memory for this learning lab. Persistence
across agent restarts is outside this change.

## Components

### Remediation Validator

Create `remediation-validator.js` with injected dependencies for querying Docker,
Prometheus, and waiting between attempts. It validates a restart without executing
it and returns a structured result.

Docker validation distinguishes:

- running and healthy
- running but unhealthy
- stopped or missing
- unknown because the inspection failed

When a container has no Docker health check, `running` is treated as healthy for
this lab. The observation records that reduced-confidence basis.

Prometheus validation queries the active alerts API and matches the action's alert
name and service labels. Validation also queries Alertmanager to distinguish
eventual-delivery lag, but the Alertmanager result does not decide whether a
restart is required.

### Docker Tool Adapter

Extend the existing allowlisted Docker adapter with a structured service-state
inspection operation. It must continue using `execFile` with fixed arguments and
the existing service allowlist.

### Incident Queue

Expose a narrowly scoped update function by incident ID. The validator uses it to
mark an incident recovered; it must not mutate queue ordering or revive completed
work.

### Action Orchestrator

Approval atomically transitions an action from `pending_approval` to `validating`.
Only one approval can pass this transition. The orchestrator then delegates to the
validator and either cancels, reports a mismatch/failure, or moves to `executing`.

Policy evaluation runs again immediately before execution.

## State Transitions

The restart path is:

```text
pending_approval
  -> expired
  -> validating
       -> cancelled_resolved
       -> cancelled_already_recovered
       -> alert_state_mismatch
       -> validation_failed
       -> executing
            -> succeeded
            -> failed
```

An approval received at or after `expiresAt` produces `expired`. Terminal actions
cannot be approved or executed again.

## Validation Rules

Each attempt collects Docker state, Prometheus alert-condition state, and the
Alertmanager delivery state. The final outcome uses both attempts:

| Observation | Outcome |
| --- | --- |
| Alertmanager reports resolved and the Prometheus condition is inactive | `cancelled_resolved` |
| Service healthy and Prometheus condition inactive on both checks, including when Alertmanager still reports firing | `cancelled_already_recovered` |
| Service healthy on both checks but alert condition remains active | `alert_state_mismatch` |
| Service unhealthy and alert active on both checks | Continue to execution |
| Results change between checks and do not meet a terminal rule | `alert_state_mismatch` |
| A required query fails or is indeterminate | `validation_failed` |

All outcomes except continued execution are fail-closed and do not restart the
service.

Immediately after validation and before calling Docker restart, the orchestrator
rechecks the action state and policy. This limits approval races, although the lab's
in-memory single-process store is not a distributed lock.

## Alert and Incident Reconciliation

When both checks show a healthy service and the Prometheus condition is inactive,
the incident becomes internally recovered with a timestamp and reason. The action
becomes `cancelled_resolved` if Alertmanager already reports resolution; otherwise
it becomes `cancelled_already_recovered` and records that Alertmanager propagation
is still pending.

When Docker is healthy but the Prometheus condition remains active after both
checks, the incident is not marked recovered. The action becomes
`alert_state_mismatch`, and Slack explains that the restart was skipped and the
alert rule or metrics should be investigated.

The agent never deletes, resolves, or silences an Alertmanager alert as part of
this flow.

## Audit and Slack Feedback

Every transition records an audit event containing the actor, previous status,
new status, and concise validation result. Add an HTTP endpoint for retrieving the
existing in-memory audit events so the decision can be inspected during the demo.

Slack receives a follow-up message for every terminal validation result. Messages
state whether the restart executed, expired, was cancelled due to recovery, was
blocked by inconsistent state, or failed validation.

## Error Handling

Validation fails closed. Docker, Prometheus, timeout, malformed response, or
unsupported alert errors produce `validation_failed`; they never fall through to
restart. The stored error is concise and the full operational error remains in the
agent log.

If the process restarts while an action is `validating`, the in-memory action is
lost along with the rest of the current store. Durable recovery is explicitly out
of scope.

## Testing

Use the Node.js built-in test runner and dependency injection. Tests must not need
Docker, Prometheus, Alertmanager, Slack, or a 30-second delay.

Focused tests cover:

- expired approval does not validate or execute
- duplicate approval cannot pass the `validating` transition
- two healthy/inactive checks cancel restart and mark the incident recovered
- resolved Prometheus alert cancels restart
- healthy Docker with an active alert produces `alert_state_mismatch`
- unhealthy Docker with an active alert twice permits restart
- changing or indeterminate observations fail closed
- Docker or Prometheus errors produce `validation_failed`
- a terminal action cannot be executed again
- audit events capture validation outcomes

## Out of Scope

- Persistent storage or recovery across agent restarts
- Distributed locking across multiple agent replicas
- Automatically changing, deleting, or silencing Alertmanager alerts
- Rewriting Prometheus alert rules
- Applying pre-execution validation to read-only actions
