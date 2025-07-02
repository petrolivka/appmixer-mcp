# Appmixer MCP

A Model Context Protocol (MCP) server that provides LLMs with agentic workflow automation capabilities using Appmixer. This server enables LLMs to interact with other MCP servers configured via Appmixer or with custom built workflows that use 3rd party SaaS products, APIs or other utilities.

## Requirements
- Node.js 20 or newer
- VS Code, Cursor, Windsurf, Claude Desktop or any other MCP client

## Getting started

First, install the Appmixer MCP server with your client. A typical configuration looks like this:

```js
{
  "mcpServers": {
    "appmixer-mcp": {
      "command": "npx",
      "args": [
        "appmixer-mcp"
      ],
      "env": {
        "APPMIXER_BASE_URL": "<your-appmixer-tenant-api-base-url>",
        "APPMIXER_ACCESS_TOKEN": "<your-appmixer-access-token>",
        "APPMIXER_USERNAME": "<optional-appmixer-username>",
        "APPMIXER_PASSWORD": "<optional-appmixer-password>"
      }
    }
  }
}
```

<details>
<summary><b>Install in Claude Desktop</b></summary>

Follow the MCP install [guide](https://modelcontextprotocol.io/quickstart/user), use following configuration:

```js
{
  "mcpServers": {
    "appmixer-mcp": {
      "command": "npx",
      "args": [
        "appmixer-mcp"
      ],
      "env": {
        "APPMIXER_BASE_URL": "<your-appmixer-tenant-api-base-url>",
        "APPMIXER_ACCESS_TOKEN": "<your-appmixer-access-token>",
        "APPMIXER_USERNAME": "<optional-appmixer-username>",
        "APPMIXER_PASSWORD": "<optional-appmixer-password>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Install in Windsurf</b></summary>

Follow Windsuff MCP [documentation](https://docs.windsurf.com/windsurf/cascade/mcp). Use following configuration:

```js
{
  "mcpServers": {
    "appmixer-mcp": {
      "command": "npx",
      "args": [
        "appmixer-mcp"
      ],
      "env": {
        "APPMIXER_BASE_URL": "<your-appmixer-tenant-api-base-url>",
        "APPMIXER_ACCESS_TOKEN": "<your-appmixer-access-token>",
        "APPMIXER_USERNAME": "<optional-appmixer-username>",
        "APPMIXER_PASSWORD": "<optional-appmixer-password>"
      }
    }
  }
}
```
</details>

<details><summary><b>Install in VS Code</b></summary>

You can also install the Appmixer MCP server using the VS Code CLI:

```bash
# For VS Code
code --add-mcp '{"name":"appmixer-mcp","command":"npx","args":["appmixer-mcp","env":{"APPMIXER_BASE_URL":"","APPMIXER_ACCESS_TOKEN":""}]}'
```

After installation, the Appmixer MCP server will be available for use with your GitHub Copilot agent in VS Code.
</details>

<details>
<summary><b>Install in Cursor</b></summary>

Go to `Cursor Settings` -> `MCP` -> `Add new MCP Server`. Name to your liking, use `command` type with the command `npx appmixer-mcp`. You can also verify config or add command like arguments via clicking `Edit`.

```js
{
  "mcpServers": {
    "appmixer-mcp": {
      "command": "npx",
      "args": [
        "appmixer-mcp"
      ],
      "env": {
        "APPMIXER_BASE_URL": "<your-appmixer-tenant-api-base-url>",
        "APPMIXER_ACCESS_TOKEN": "<your-appmixer-access-token>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Install in Claude Code</b></summary>

Use the Claude Code CLI to add the Appmixer MCP server:

```bash
claude mcp add appmixer-mcp npx appmixer-mcp -e APPMIXER_BASE_URL="" -e APPMIXER_ACCESS_TOKEN=""
```
</details>

## Configuration

Appmixer MCP server supports following environment variables:


| Name                   | Description                             |
|------------------------|-----------------------------------------|
| APPMIXER_BASE_URL      | Your Appmixer tenant API url. For example: `https://api.YOUR_TENANT.appmixer.cloud` |
| APPMIXER_ACCESS_TOKEN  | Your Appmixer access token. See Authentication section below for more info.  |
| APPMIXER_USERNAME      | Your Appmixer username. See Authentication section below for more info. |
| APPMIXER_PASSWORD      | Your Appmixer password. See Authentication section below for more info. |
| TOOLS                  | Set to `api,mcpgateway` by default meaning both the Appmixer API tools such as "get-flows" and "MCP Gateway" entry points are enabled. |

## Authentication

You can either set the `APPMIXER_ACCESS_TOKEN` environment variable or use your `APPMIXER_USERNAME` and `APPMIXER_PASSWORD` credentials directly. Note that the former is way more secure. However, note that there's an expiration time on your access token in Appmixer (consult your Appmixer admin to see what the system setting `GRIDD_JWT_TOKEN_EXP` is set to (by default `30d`)).

## Tools

### API Tools

- **get-flows**
  - Parameters:
   - `pattern` (string): Pattern to filter flows by name.
- **get-flow**
  - Parameters:
    - `id` (string): Flow ID
- **delete-flow**
  - Parameters:
    - `id` (string): Flow ID
- **start-flow**
  - Parameters:
    - `id` (string): Flow ID
- **stop-flow**
  - Parameters:
    - `id` (string): Flow ID
- **trigger-component**
  - Parameters:
    - `id` (string): Flow ID
    - `componentId` (string): Component ID
    - `method` (string): HTTP method
    - `body` (string): JSON string that will be sent as the body of the HTTP 
    call to the component.
- **send-app-event**
  - Parameters:
    - `event` (string): App Event name
    - `data` (string): JSON string that will be sent as the event data.
- **get-flow-logs**
  - Parameters:
    - `id` (string): Flow ID
    - `query` (string): Apache Lucene Query Parser Syntax to filter the logs based on a search criteria.

### MCP Gateway Tools

Every time you use the "MCP Gateway" component from the "MCP Tools" category in any of your running flows, the Appmixer MCP server automatically detects the tools connected to this component and lists those. Note that the server is able to detect the changes dynamically meaning just by starting/stopping your Appmixer flows that include the "MCP Gateway" component, you change the list of available tools.

