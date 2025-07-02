#!/usr/bin/env node

import { AppmixerClient } from './client.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const CONFIG_TOOLS = process.env.TOOLS ||  'api,mcpgateway';

const client = new AppmixerClient({
    baseUrl: process.env.APPMIXER_BASE_URL,
    accessToken: process.env.APPMIXER_ACCESS_TOKEN,
    username: process.env.APPMIXER_USERNAME,
    password: process.env.APPMIXER_PASSWORD
});

const server = new Server(
    {
        name: 'Appmixer',
        version: '1.0.0'
    },
    {
        capabilities: {
            logging: {},
            tools: {},
            listChanged: {}
        }
    }
);

const API_TOOLS = [{
    name: 'get-flows',
    annotations: {
        title: 'Get Flows'
    },
    description: 'Find Appmixer flows optionally filtered by a pattern. If no pattern is provided, last 100 flows are returned.',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Optional pattern to filter flow names.' }
        },
    },
    handler: async (args) => {
        const flows = await client.getFlows(args);
        const formattedFlows = flows.map(flow => `ID: ${flow.flowId}; Name: (${flow.name})`).join('\n');
        return {
            content: [{ type: 'text', text: formattedFlows }],
        };
    }
}, {
    name: 'get-flow',
    annotations: {
        title: 'Get Flow'
    },
    description: 'Get a single Appmixer flow by its ID.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The ID of the flow to retrieve.' }
        },
        required: ['id']
    },
    handler: async (args) => {
        const flow = await client.getFlow(args.id);
        const formattedFlow = `
            ID: ${flow.flowId}\n
            Name: ${flow.name}\n
            Description: ${flow.description}\n
            Stage: ${flow.stage}\n
            Created At: ${new Date(flow.btime).toLocaleString()}\n
            Updated At: ${new Date(flow.mtime).toLocaleString()}\n
            Type: ${flow.type}\n
            Flow: ${JSON.stringify(flow.flow, null, 2)}\n
        `;
        return {
            content: [{ type: "text", text: formattedFlow }],
        };
    }
}, {
    name: 'delete-flow',
    description: 'Delete an Appmixer flow by its ID.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The ID of the flow to delete.' }
        },
        required: ['id']
    },
    handler: async (args) => {
        await client.deleteFlow(args.id);
        return {
            content: [{ type: "text", text: `Flow ${args.id} deleted successfully.` }],
        };
    }
}, {
    name: 'start-flow',
    description: 'Start an Appmixer flow by its ID.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The ID of the flow to start.' }
        },
        required: ['id']
    },
    handler: async (args) => {
        await client.startFlow(args.id);
        return {
            content: [{ type: "text", text: `Flow ${args.id} started successfully.` }],
        };
    }
}, {
    name: 'stop-flow',
    description: 'Stop an Appmixer flow by its ID.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The ID of the flow to stop.' }
        },
        required: ['id']
    },
    handler: async (args) => {
        await client.stopFlow(args.id);
        return {
            content: [{ type: "text", text: `Flow ${args.id} stopped successfully.` }],
        };
    }
}, {
    name: 'trigger-component',
    description: 'Trigger a component in a flow by sending a HTTP webhook request to it. Find the relevant component by getting the flow JSON descriptor (use get-flow tool and its flow field) and finding the component ID by its label or type.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The ID of the flow to trigger.' },
            componentId: { type: 'string', description: 'The ID of the component to trigger.' },
            method: { type: 'string', description: 'HTTP method to use for the request (default: POST).', default: 'POST' },
            body: { type: 'string', description: 'The body (a JSON string) of the request to send to the component.' }
        },
        required: ['id', 'componentId']
    },
    handler: async (args) => {
        const result = await client.triggerComponent(args.id, args.componentId, args.method, args.body);
        return {
            content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : 'Component triggered successfully.' }]
        };
    }
}, {
    name: 'send-app-event',
    description: 'Send an App Event to Appmixer flows.',
    inputSchema: {
        type: 'object',
        properties: {
            event: { type: 'string', description: 'The name of the event.' },
            data: { type: 'string', description: 'The data (a JSON string) of the event to send to Appmixer flows.' }
        },
        required: ['event']
    },
    handler: async (args) => {
        const result = await client.sendAppEvent(args.event, args.data);
        return {
            content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : 'App event sent successfully.' }]
        };
    }
}, {
    name: 'get-flow-logs',
    description: 'Get Appmixer flow logs.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The ID of the flow to retrieve logs for.' },
            query: { type: 'string', description: 'Optional query string to filter logs. It uses the Apache Lucene Query Parser Syntax. The query can reference fields such as "msg", "@timestamp", "portType", "port", "correlationId", "senderType", "senderId" and "inputMessages".' }
        },
        required: ['id']
    },
    handler: async (args) => {
        const logs = await client.getLogs(args.id, args.query);
        const formattedLogs = (logs.hits || []).map(log => `
            Timestamp: ${log['@timestamp']}\n
            Severity: (${log.severity})\n
            Port Type: ${log.portType}\n
            Port: ${log.port}\n
            Component ID: ${log.componentId}\n
            Component Type: ${log.componentType}\n
            Correlation ID: ${log.correlationId}\n
            Sender Component ID: ${log.senderId}\n
            Sender Component Type: ${log.senderType}\n
            Input Message: ${log.inputMessages}\n
            Message: ${log.msg}\n
        `).join('\n');
        return {
            content: [{ type: 'text', text: formattedLogs }],
        };
    }
}];

const TOOLS = CONFIG_TOOLS.includes('api') ? API_TOOLS : [];

async function listMCPGatewayTools() {

    const tools = [];
    if (!CONFIG_TOOLS.includes('mcpgateway')) {
        return tools;
    }

    try {
        const gateways = await client.getGateways();
        for (const gateway of gateways) {
            const webhook = gateway.webhook;
            for (const tool of gateway.tools) {
                const name = tool.function.name;
                const title = name.split('_').slice(1).join('_');
                tools.push({
                    name,
                    description: tool.function.description,
                    inputSchema: tool.function.parameters || {},
                    annotations: {
                        title
                    },
                    handler: async (args) => {
                        const result = await client.request(webhook, 'POST', {
                            function: {
                                name,
                                arguments: args
                            }
                        });
                        return {
                            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }]
                        }
                    }
                });
            }
        }
    } catch (err) {
        console.error('Error fetching tools.', err);
    }

    return tools;
}

async function main() {

    let allTools = TOOLS;

    await client.connectEventSource((data) => {
        if (data.type === 'gateway-add') {
            server.sendToolListChanged();
        } else if (data.type === 'gateway-delete') {
            server.sendToolListChanged();
        }
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const gatewayTools = await listMCPGatewayTools();
        allTools = TOOLS.concat(gatewayTools);
        return {
            tools: allTools
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const tool = allTools.find(tool => tool.name === name);
        if (tool) {
            const args = request.params.arguments;
            const result = await tool.handler(args);
            return result;
        }
        throw new Error(`Tool ${name} not found.`);
      });

    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
    } catch (err) {
        console.error('Fatal error running server:', err);
        process.exit(1);
    }
}

main();
