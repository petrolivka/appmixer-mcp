import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient } from '../client.js';
import { safeHandler, textResult, truncate } from '../format.js';

const FLOW_ID = z.string().min(1).describe('The ID of the flow.');

export function registerApiTools(server: McpServer, client: AppmixerClient): void {

    server.registerTool('list_flows', {
        title: 'List Flows',
        description: 'List Appmixer flows of the authenticated user, sorted by last modification. ' +
            'Returns flow IDs, names, stages and modification times. Use `pattern` to filter by name.',
        inputSchema: {
            pattern: z.string().optional().describe('Filter flows whose name matches this pattern.'),
            limit: z.number().int().min(1).max(100).default(20)
                .describe('Maximum number of flows to return.'),
            offset: z.number().int().min(0).default(0).describe('Pagination offset.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ pattern, limit, offset }) => {
        const flows = await client.getFlows({ pattern, limit, offset });
        const rows = flows.map(flow => ({
            flowId: flow.flowId,
            name: flow.name,
            stage: flow.stage,
            updated: typeof flow.mtime === 'number' ? new Date(flow.mtime).toISOString() : flow.mtime
        }));
        return textResult({
            count: rows.length,
            offset,
            note: rows.length === limit ? 'More flows may exist; increase offset to page.' : undefined,
            flows: rows
        });
    }));

    server.registerTool('get_flow', {
        title: 'Get Flow',
        description: 'Get a single Appmixer flow by ID: metadata and, optionally, the full flow ' +
            'descriptor (the JSON definition of components and their wiring). ' +
            'Set include_descriptor=true when you need component IDs, e.g. for trigger_component.',
        inputSchema: {
            id: FLOW_ID,
            include_descriptor: z.boolean().default(false)
                .describe('Include the full flow descriptor JSON (can be large).')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id, include_descriptor }) => {
        const flow = await client.getFlow(id);
        const result: Record<string, unknown> = {
            flowId: flow.flowId,
            name: flow.name,
            description: flow.description,
            stage: flow.stage,
            type: flow.type,
            created: typeof flow.btime === 'number' ? new Date(flow.btime).toISOString() : flow.btime,
            updated: typeof flow.mtime === 'number' ? new Date(flow.mtime).toISOString() : flow.mtime
        };
        if (include_descriptor) {
            result.descriptor = flow.flow;
        } else {
            const descriptor = (flow.flow || {}) as Record<string, { type?: string; label?: string }>;
            result.components = Object.entries(descriptor).map(([componentId, component]) => ({
                componentId,
                type: component.type,
                label: component.label
            }));
        }
        return textResult(result);
    }));

    server.registerTool('get_flow_status', {
        title: 'Get Flow Status',
        description: 'Get the current stage of an Appmixer flow: "running" or "stopped".',
        inputSchema: { id: FLOW_ID },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id }) => {
        const flow = await client.getFlow(id);
        return textResult({ flowId: flow.flowId, name: flow.name, stage: flow.stage });
    }));

    server.registerTool('get_flow_logs', {
        title: 'Get Flow Logs',
        description: 'Get execution logs of an Appmixer flow. Optionally filter with an Apache Lucene ' +
            'query over fields such as "msg", "@timestamp", "portType", "port", "correlationId", ' +
            '"senderType", "senderId" and "inputMessages".',
        inputSchema: {
            id: FLOW_ID,
            query: z.string().optional().describe('Apache Lucene query to filter the logs.'),
            size: z.number().int().min(1).max(100).default(20)
                .describe('Maximum number of log records to return.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id, query, size }) => {
        const logs = await client.getLogs(id, { query, size });
        const hits = (logs.hits || []).map(hit => ({
            timestamp: hit['@timestamp'],
            severity: hit.severity,
            componentId: hit.componentId,
            componentType: hit.componentType,
            port: hit.port,
            portType: hit.portType,
            correlationId: hit.correlationId,
            message: typeof hit.msg === 'string' ? truncate(hit.msg, 500) : hit.msg
        }));
        return textResult({ count: hits.length, logs: hits });
    }));

    server.registerTool('start_flow', {
        title: 'Start Flow',
        description: 'Start an Appmixer flow by ID. The flow must be valid and complete to start.',
        inputSchema: { id: FLOW_ID },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ id }) => {
        await client.commandFlow(id, 'start');
        const flow = await client.getFlow(id);
        return textResult({ message: `Flow ${id} start requested.`, stage: flow.stage });
    }));

    server.registerTool('stop_flow', {
        title: 'Stop Flow',
        description: 'Stop a running Appmixer flow by ID.',
        inputSchema: { id: FLOW_ID },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ id }) => {
        await client.commandFlow(id, 'stop');
        const flow = await client.getFlow(id);
        return textResult({ message: `Flow ${id} stop requested.`, stage: flow.stage });
    }));

    server.registerTool('delete_flow', {
        title: 'Delete Flow',
        description: 'Permanently delete an Appmixer flow by ID. This cannot be undone.',
        inputSchema: { id: FLOW_ID },
        annotations: { destructiveHint: true }
    }, safeHandler(async ({ id }) => {
        await client.deleteFlow(id);
        return textResult(`Flow ${id} deleted.`);
    }));

    server.registerTool('trigger_component', {
        title: 'Trigger Component',
        description: 'Send a webhook request that submits data to a trigger component of a running ' +
            'flow, using POST (default), PUT, PATCH or DELETE — match the method the flow\'s webhook ' +
            'trigger expects. Find the component ID with get_flow (include_descriptor=false lists ' +
            'components with their IDs). For triggers that expect GET, use read_component_trigger.',
        inputSchema: {
            flow_id: FLOW_ID,
            component_id: z.string().min(1).describe('The ID of the component to trigger.'),
            method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).default('POST')
                .describe('HTTP method the webhook trigger listens on.'),
            body: z.record(z.string(), z.unknown()).optional()
                .describe('JSON body to send to the component.')
        },
        annotations: { destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ flow_id, component_id, method, body }) => {
        const result = await client.triggerComponent(flow_id, component_id, { method, body });
        return textResult(result ?? 'Component triggered.');
    }));

    server.registerTool('read_component_trigger', {
        title: 'Read From Component Trigger',
        description: 'Send a GET request to a trigger component of a running flow, for webhook ' +
            'triggers that listen on GET, and return the component\'s response.',
        inputSchema: {
            flow_id: FLOW_ID,
            component_id: z.string().min(1).describe('The ID of the component to call.'),
            query: z.record(z.string(), z.string()).optional()
                .describe('Query string parameters to send with the request.')
        },
        annotations: { readOnlyHint: true, openWorldHint: true }
    }, safeHandler(async ({ flow_id, component_id, query }) => {
        const result = await client.triggerComponent(flow_id, component_id, { method: 'GET', query });
        return textResult(result ?? 'Component called.');
    }));

    server.registerTool('send_app_event', {
        title: 'Send App Event',
        description: 'Send a named App Event to Appmixer. All running flows of this user that contain ' +
            'an OnAppEvent trigger for this event name will receive it.',
        inputSchema: {
            event: z.string().min(1).describe('The name of the event.'),
            data: z.record(z.string(), z.unknown()).optional().describe('Event payload.')
        },
        annotations: { destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ event, data }) => {
        const result = await client.sendAppEvent(event, data);
        return textResult(result ?? `App event "${event}" sent.`);
    }));
}
