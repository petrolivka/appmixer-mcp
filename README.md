# Appmixer MCP

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[Appmixer](https://www.appmixer.com) workflow-automation platform. It lets LLM
clients (Claude, Cursor, VS Code, Windsurf, …) control and observe the flows of
an Appmixer tenant user, and dynamically exposes tools published by
"MCP Gateway" components running inside Appmixer flows.

## Requirements

- Node.js 20 or newer
- An Appmixer tenant and user account

## Getting started

Add the server to your MCP client. A typical configuration:

```json
{
  "mcpServers": {
    "appmixer": {
      "command": "npx",
      "args": ["appmixer-mcp"],
      "env": {
        "APPMIXER_BASE_URL": "https://api.YOUR_TENANT.appmixer.cloud",
        "APPMIXER_ACCESS_TOKEN": "<your-appmixer-access-token>"
      }
    }
  }
}
```

With Claude Code:

```bash
claude mcp add appmixer npx appmixer-mcp \
  -e APPMIXER_BASE_URL="https://api.YOUR_TENANT.appmixer.cloud" \
  -e APPMIXER_ACCESS_TOKEN="..."
```

## Configuration

| Variable | Description |
|---|---|
| `APPMIXER_BASE_URL` | **Required.** Your Appmixer tenant API URL, e.g. `https://api.YOUR_TENANT.appmixer.cloud`. |
| `APPMIXER_ACCESS_TOKEN` | Appmixer access token (JWT). Recommended over username/password. |
| `APPMIXER_USERNAME` | Appmixer username — only needed when no token is provided, or to let the server renew expired tokens automatically. |
| `APPMIXER_PASSWORD` | Appmixer password (see above). |
| `TOOLS` | Enabled tool groups, comma-separated. Default `api,mcpgateway`. |

### Authentication notes

- Prefer `APPMIXER_ACCESS_TOKEN`. Tokens expire (`GRIDD_JWT_TOKEN_EXP` system
  setting, `30d` by default) — when username/password are also provided, the
  server re-authenticates automatically on expiry.
- Consider a dedicated non-admin Appmixer user for MCP access so the token's
  capabilities are limited by ACL.

## Tools

### API tools (`TOOLS=api`)

| Tool | Kind | Description |
|---|---|---|
| `list_flows` | read | List flows (pattern filter, pagination). |
| `get_flow` | read | Flow metadata + component list; optionally the full descriptor. |
| `get_flow_status` | read | Runtime status of a flow. |
| `get_flow_logs` | read | Execution logs, filterable with Lucene query syntax. |
| `start_flow` | write | Start a flow. |
| `stop_flow` | write | Stop a flow. |
| `delete_flow` | destructive | Permanently delete a flow. |
| `trigger_component` | write | POST a webhook payload to a trigger component of a running flow. |
| `send_app_event` | write | Send a named App Event to the user's flows. |

All tools ship proper MCP annotations (`readOnlyHint`, `destructiveHint`), so
well-behaved clients auto-allow reads and always confirm destructive calls.
Errors are returned as actionable `isError` results with the API status and a
hint on how to fix the problem.

### MCP Gateway tools (`TOOLS=mcpgateway`)

Every running flow that contains an "MCP Gateway" component (from the
"MCP Tools" category) contributes its connected tools to this server. The tool
list updates live — starting or stopping such flows adds or removes tools
(standard `tools/list_changed` notifications).

Requires the `appmixer.ai.mcptools` module installed on the tenant. When the
module is missing, gateway tools are disabled gracefully and API tools keep
working. See [`docs/mcptools-endpoints.md`](docs/mcptools-endpoints.md) for the
module's endpoint documentation.

## Development

```bash
npm install
npm run build       # compile TypeScript to dist/
npm test            # unit tests (vitest)
npm run dev         # run from sources (tsx)

# Live smoke test against a real tenant:
APPMIXER_BASE_URL=... APPMIXER_USERNAME=... APPMIXER_PASSWORD=... node test/smoke.mjs
```

## License

[MIT](LICENSE)
