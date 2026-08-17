import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAppmixerServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { futureJwt, jsonResponse } from './helpers.js';

const BASE_URL = 'https://api.tenant.appmixer.cloud';

async function connectedClient(tools = 'api') {
    const config = loadConfig({
        APPMIXER_BASE_URL: BASE_URL,
        APPMIXER_ACCESS_TOKEN: futureJwt(),
        TOOLS: tools
    });
    const app = createAppmixerServer(config, () => {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
        app.server.connect(serverTransport),
        client.connect(clientTransport)
    ]);
    return { client, app };
}

describe('appmixer MCP server', () => {

    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists API tools with titles and correct annotations', async () => {
        const { client } = await connectedClient();
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));

        expect(Object.keys(byName).sort()).toEqual([
            'assign_account', 'create_flow', 'delete_flow', 'get_components',
            'get_flow', 'get_flow_accounts', 'get_flow_authoring_guide',
            'get_flow_logs', 'get_flow_status', 'get_flow_variables',
            'list_accounts', 'list_apps', 'list_flows', 'send_app_event',
            'start_flow', 'stop_flow', 'test_flow', 'trigger_component',
            'update_flow', 'validate_flow'
        ]);
        expect(byName.list_flows.annotations?.readOnlyHint).toBe(true);
        expect(byName.delete_flow.annotations?.destructiveHint).toBe(true);
        expect(byName.start_flow.annotations?.destructiveHint).toBe(false);
        for (const tool of tools) {
            expect(tool.name.length).toBeLessThanOrEqual(64);
            expect(tool.annotations?.title || (tool as { title?: string }).title).toBeTruthy();
            expect(tool.description).toBeTruthy();
        }
    });

    it('list_flows returns compact rows', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([
            { flowId: 'f1', name: 'Flow One', stage: 'running', mtime: 1755000000000, thumbnailIgnored: 'x' }
        ]));
        const { client } = await connectedClient();

        const result = await client.callTool({ name: 'list_flows', arguments: {} });

        const text = (result.content as { text: string }[])[0].text;
        expect(result.isError).toBeFalsy();
        expect(text).toContain('"flowId": "f1"');
        expect(text).toContain('"stage": "running"');
        expect(text).not.toContain('thumbnailIgnored');
    });

    it('propagates API failures as actionable isError results', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Flow not found.' }, 404));
        const { client } = await connectedClient();

        const result = await client.callTool({ name: 'get_flow', arguments: { id: 'missing' } });

        expect(result.isError).toBe(true);
        const text = (result.content as { text: string }[])[0].text;
        expect(text).toContain('404');
        expect(text).toContain('Flow not found.');
        expect(text).toContain('Check that the ID is correct');
    });

    it('validates tool input before calling the API', async () => {
        const { client } = await connectedClient();
        const result = await client.callTool({ name: 'get_flow', arguments: {} });
        expect(result.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('registers gateway tools from the mcptools plugin and calls them via webhook', async () => {
        const webhook = `${BASE_URL}/flows/flow-1/components/comp-1`;
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (String(url).includes('/mcptools/gateways')) {
                return Promise.resolve(jsonResponse([{
                    flowId: 'flow-1', componentId: 'comp-1', webhook,
                    tools: [{
                        type: 'function',
                        function: {
                            name: 'abc123_send_email',
                            description: 'Send an email.',
                            parameters: {
                                type: 'object',
                                properties: { to: { type: 'string' } },
                                required: ['to']
                            }
                        }
                    }]
                }]));
            }
            if (String(url) === webhook && init?.method === 'POST') {
                return Promise.resolve(jsonResponse('sent'));
            }
            return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500));
        });

        const { client, app } = await connectedClient('api,mcpgateway');
        await app.gatewayManager!.refresh();

        const { tools } = await client.listTools();
        const gatewayTool = tools.find(tool => tool.name === 'abc123_send_email');
        expect(gatewayTool).toBeDefined();
        expect(gatewayTool!.inputSchema.properties).toHaveProperty('to');

        const result = await client.callTool({
            name: 'abc123_send_email',
            arguments: { to: 'x@example.com' }
        });
        expect(result.isError).toBeFalsy();
        expect((result.content as { text: string }[])[0].text).toBe('sent');

        const webhookCall = fetchMock.mock.calls.find(([url]) => String(url) === webhook);
        expect(JSON.parse(webhookCall![1].body)).toEqual({
            function: { name: 'abc123_send_email', arguments: { to: 'x@example.com' } }
        });
    });

    it('disables gateway tools gracefully when the plugin is missing', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404));
        const { client, app } = await connectedClient('api,mcpgateway');

        await expect(app.gatewayManager!.refresh()).resolves.toBe(false);
        const { tools } = await client.listTools();
        expect(tools.length).toBe(20); // API + authoring tools only, no crash.
    });
});
