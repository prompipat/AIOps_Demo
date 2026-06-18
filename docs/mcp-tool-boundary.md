# MCP-Style Docker Tool Boundary

This project uses an MCP-style tool boundary for remediation actions, but it does not currently run a full standalone MCP protocol server.

## What Exists Today

The AI remediation agent receives LLM recommendations as JSON. The agent then validates and executes only allowlisted actions through local JavaScript code:

```text
Groq recommendation
  -> action-orchestrator.js
  -> remediation-policy.js
  -> approval-store.js
  -> mcp-docker-client.js
  -> Docker CLI
```

`mcp-docker-client.js` exposes controlled tool names:

- `docker_compose.logs`
- `docker_compose.restart`
- `docker_compose.ps`

Internally, those tools call Docker CLI commands such as `docker logs`, `docker restart`, `docker start`, and `docker ps`.

## Why This Is MCP-Style

The important learning pattern is the boundary:

```text
The LLM suggests.
The application validates.
Policy decides risk.
Humans approve high-risk actions.
Only allowlisted tools execute.
```

The LLM never runs shell commands directly.

## What A Real MCP Upgrade Would Add

A future real MCP version would split the Docker tools into a separate MCP server:

```text
ai-remediation-agent
  -> MCP client
  -> docker-remediation MCP server
  -> Docker Engine
```

That would add protocol transport, tool schemas, server lifecycle, and explicit MCP tool discovery. For the current learning lab, the local adapter keeps the idea visible without adding extra infrastructure.
