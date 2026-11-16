// Live smoke test: spawns the built server over stdio and exercises tools/list
// + a read-only tool call against a real tenant. Requires APPMIXER_* env vars.
// Usage: node test/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// MCP_SERVER_ENTRY lets the same smoke test exercise the MCPB bundle, which
// must run standalone (no node_modules next to it).
const entry = process.env.MCP_SERVER_ENTRY || 'dist/index.js';
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env },
    stderr: 'inherit'
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools/list: ${tools.length} tools -> ${tools.map(t => t.name).join(', ')}`);

for (const tool of tools) {
    if (tool.name.length > 64) throw new Error(`Tool name too long: ${tool.name}`);
    if (!tool.description) throw new Error(`Tool missing description: ${tool.name}`);
}

const result = await client.callTool({ name: 'list_flows', arguments: { limit: 5 } });
if (result.isError) throw new Error(`list_flows failed: ${result.content[0].text}`);
console.log('list_flows:', result.content[0].text.slice(0, 400));

const text = r => r.content[0].text;

const info = await client.callTool({ name: 'get_tenant_info', arguments: {} });
if (info.isError) throw new Error(`get_tenant_info failed: ${text(info)}`);
const tenant = JSON.parse(text(info));
console.log(`get_tenant_info: core ${tenant.version}, supported: ${tenant.coreSupported}`);
if (tenant.coreSupported !== true) throw new Error(`Unsupported or unknown core version: ${tenant.version}`);

// Start an account connection without finishing it: proves the ticket and
// auth-url routes answer as connect_account expects. Nothing is created; the
// ticket expires on its own.
const slack = await client.callTool({ name: 'get_components', arguments: { app: 'appmixer.slack' } });
if (!slack.isError && text(slack).includes('appmixer.slack.')) {
    const started = await client.callTool({ name: 'connect_account', arguments: { type: 'appmixer.slack' } });
    if (started.isError) throw new Error(`connect_account failed: ${text(started)}`);
    const { ticket, url, kind } = JSON.parse(text(started));
    console.log(`connect_account: kind ${kind}, url host ${new URL(url).host}`);
    const status = await client.callTool({ name: 'get_account_connection', arguments: { ticket, wait_seconds: 0 } });
    if (status.isError) throw new Error(`get_account_connection failed: ${text(status)}`);
    const { status: state } = JSON.parse(text(status));
    if (state !== 'pending') throw new Error(`Expected a pending connection, got ${state}`);
    console.log('get_account_connection: pending');
} else {
    console.log('connect_account: skipped, the tenant has no appmixer.slack');
}

await client.close();
console.log('SMOKE OK');
