import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAppmixerServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { futureJwt, jsonResponse } from './helpers.js';

const BASE_URL = 'https://api.tenant.appmixer.cloud';

const MANIFESTS = [
    {
        name: 'appmixer.utils.email.SendEmail',
        description: 'Send an email.',
        icon: 'data:image/svg;base64,xxxxxxxx',
        author: 'Appmixer',
        inPorts: [{ name: 'in', schema: { type: 'object', required: ['to'] } }],
        outPorts: [{ name: 'out' }]
    },
    {
        name: 'appmixer.utils.timers.Scheduler',
        description: 'Fire on schedule.',
        outPorts: [{ name: 'out' }]
    }
];

async function connectedClient() {
    const config = loadConfig({
        APPMIXER_BASE_URL: BASE_URL,
        APPMIXER_ACCESS_TOKEN: futureJwt(),
        TOOLS: 'api'
    });
    const app = createAppmixerServer(config, () => {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([app.server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
    return (result.content as { text: string }[])[0].text;
}

describe('authoring tools', () => {

    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('get_flow_authoring_guide returns the embedded guide', async () => {
        const client = await connectedClient();
        const result = await client.callTool({ name: 'get_flow_authoring_guide', arguments: {} });
        const text = firstText(result);
        expect(text).toContain('# Appmixer Flow Authoring Guide');
        expect(text).toContain('json2new');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('exposes the guide as an MCP resource too', async () => {
        const client = await connectedClient();
        const { resources } = await client.listResources();
        expect(resources.map(r => r.uri)).toContain('appmixer://guides/flow-authoring');
        const read = await client.readResource({ uri: 'appmixer://guides/flow-authoring' });
        expect((read.contents[0] as { text: string }).text).toContain('# Appmixer Flow Authoring Guide');
    });

    it('get_components returns a compact summary without a component argument', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(MANIFESTS));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_components', arguments: { app: 'appmixer.utils' }
        });

        const text = firstText(result);
        expect(text).toContain('"appmixer.utils.email.SendEmail"');
        expect(text).toContain('"trigger": true');   // Scheduler has no inPorts.
        expect(text).not.toContain('base64');        // No icons in summaries.
        expect(text).not.toContain('"schema"');      // No full schemas in summaries.
    });

    it('get_components returns the full manifest without icon for a single component', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(MANIFESTS));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_components',
            arguments: { app: 'appmixer.utils', component: 'appmixer.utils.email.SendEmail' }
        });

        const text = firstText(result);
        expect(text).toContain('"required"');
        expect(text).not.toContain('base64');
    });

    it('create_flow posts the descriptor and reports validation errors', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (String(url).endsWith('/flows') && init?.method === 'POST') {
                return Promise.resolve(jsonResponse({ flowId: 'new-flow' }));
            }
            if (String(url).includes('/validate')) {
                return Promise.resolve(jsonResponse({
                    errors: [{ componentId: 'c1', errors: [{ message: 'Input field "to" is required.' }] }]
                }));
            }
            return Promise.resolve(jsonResponse({ message: 'unexpected' }, 500));
        });
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'create_flow',
            arguments: {
                name: 'Test',
                flow: { 'aaaa-bbbb': { type: 'appmixer.utils.timers.Scheduler', source: {} } }
            }
        });

        const text = firstText(result);
        expect(result.isError).toBeFalsy();
        expect(text).toContain('"flowId": "new-flow"');
        expect(text).toContain('"valid": false');
        expect(text).toContain('Input field \\"to\\" is required.');
    });

    it('create_flow rejects descriptors with invalid component types before hitting the API', async () => {
        const client = await connectedClient();
        const result = await client.callTool({
            name: 'create_flow',
            arguments: { name: 'Bad', flow: { c1: { type: 'not-a-type' } } }
        });
        expect(result.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('get_flow_variables flattens variable paths with schemas', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            components: {
                'trigger-1': {},
                'action-1': {
                    links: {
                        in: {
                            'trigger-1': {
                                out: {
                                    variables: {
                                        dynamic: [
                                            {
                                                componentId: 'trigger-1', label: 'Data', port: 'out',
                                                value: '{{{$.trigger-1.out.data}}}',
                                                schema: { type: 'object', properties: { msg: { type: 'string' } } }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }));
        const client = await connectedClient();

        const result = await client.callTool({ name: 'get_flow_variables', arguments: { id: 'f1' } });

        const text = firstText(result);
        expect(text).toContain('"path": "$.trigger-1.out.data"');
        expect(text).toContain('"availableTo": "action-1"');
        expect(text).toContain('"msg"');
        expect(text).not.toContain('"path": "{{{'); // Paths are unwrapped from placeholders.
    });

    it('test_flow parses the SSE result stream into outputs', async () => {
        const sse = [
            'event: test:start\ndata: {"testRunId":"t1"}\n\n',
            'event: component:output\ndata: {"componentId":"c1","port":"out","data":{"msg":"direct"}}\n\n',
            'event: component:done\ndata: {"componentId":"c1"}\n\n',
            'event: test:done\ndata: {"testRunId":"t1","status":"completed"}\n\n'
        ].join('');
        fetchMock.mockResolvedValueOnce(new Response(sse, {
            status: 200, headers: { 'Content-Type': 'text/event-stream' }
        }));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'test_flow',
            arguments: { id: 'f1', component_id: 'c1', input_data: { in: { msg: 'direct' } } }
        });

        const text = firstText(result);
        expect(result.isError).toBeFalsy();
        expect(text).toContain('"status": "completed"');
        expect(text).toContain('"msg": "direct"');
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body)).toMatchObject({
            componentId: 'c1',
            inputData: { in: { msg: 'direct' } }
        });
    });

    it('assign_account PUTs to the auth component endpoint', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'assign_account', arguments: { component_id: 'c1', account_id: 'a1' }
        });

        expect(result.isError).toBeFalsy();
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/auth/component/c1/a1');
        expect(init.method).toBe('PUT');
    });

    it('validate_flow reports success for a clean flow', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [] }));
        const client = await connectedClient();
        const result = await client.callTool({ name: 'validate_flow', arguments: { id: 'f1' } });
        expect(firstText(result)).toContain('"valid": true');
    });
});
