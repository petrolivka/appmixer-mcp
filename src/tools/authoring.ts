import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient } from '../client.js';
import { safeHandler, textResult, truncate } from '../format.js';
import { FLOW_AUTHORING_GUIDE } from '../guide.js';

const COMPONENT_TYPE_PATTERN = /^\w+\.\w+\.\w+\.\w+$/;

/** Flow descriptor: flat map of component UUID -> component descriptor. */
const FLOW_DESCRIPTOR = z.record(
    z.string().describe('Component ID (a fresh UUID v4).'),
    z.looseObject({
        type: z.string().regex(COMPONENT_TYPE_PATTERN,
            'Component type must match vendor.service.module.Component, e.g. appmixer.utils.timers.Scheduler.')
    })
).describe('The flow descriptor JSON: a flat object mapping component UUIDs to component ' +
    'descriptors (type, label, source, config, x, y). See get_flow_authoring_guide.');

interface ComponentManifest {
    name?: string;
    label?: string;
    description?: string;
    inPorts?: { name: string }[];
    outPorts?: { name: string }[];
    [key: string]: unknown;
}

async function validationSummary(client: AppmixerClient, flowId: string): Promise<unknown> {
    try {
        const result = await client.validateFlow(flowId);
        const errors = result?.errors || [];
        return errors.length === 0
            ? { valid: true }
            : { valid: false, errors, hint: 'Fix the reported errors with update_flow, then run validate_flow again.' };
    } catch (err) {
        return { valid: undefined, note: 'Validation could not be performed.', detail: String(err) };
    }
}

export function registerAuthoringTools(server: McpServer, client: AppmixerClient): void {

    server.registerTool('get_flow_authoring_guide', {
        title: 'Get Flow Authoring Guide',
        description: 'Get the complete guide to writing Appmixer flow descriptor JSON: structure, ' +
            'wiring (source), input mapping (config.transform, modifiers, variables), error handling ' +
            'and common validation failures. Read this before calling create_flow or update_flow.',
        inputSchema: {},
        annotations: { readOnlyHint: true }
    }, safeHandler(async () => {
        return { content: [{ type: 'text' as const, text: FLOW_AUTHORING_GUIDE }] };
    }));

    server.registerTool('list_apps', {
        title: 'List Apps',
        description: 'List apps (connectors) available on this Appmixer tenant, e.g. "appmixer.utils", ' +
            '"appmixer.slack". Use get_components to inspect an app\'s components.',
        inputSchema: {
            category: z.string().optional().describe('Filter by category, e.g. "applications" or "utilities".')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ category }) => {
        const apps = await client.getApps();
        const rows = Object.values(apps)
            .filter(app => !category || app.category === category)
            .map(app => ({
                name: app.name,
                label: app.label,
                category: app.category,
                description: app.description ? truncate(app.description, 120) : undefined
            }));
        return textResult({ count: rows.length, apps: rows });
    }));

    server.registerTool('get_components', {
        title: 'Get Components',
        description: 'Inspect components of an Appmixer app. Without `component`, returns a compact ' +
            'summary of all the app\'s components (type, description, port names). With `component` ' +
            '(the full type, e.g. "appmixer.utils.email.SendEmail"), returns the full manifest ' +
            'including input fields, required fields and output variables — needed to build ' +
            'config.transform correctly. Never guess component types, port names or fields.',
        inputSchema: {
            app: z.string().min(1)
                .describe('App/module name, e.g. "appmixer.utils" or "appmixer.slack" (see list_apps).'),
            component: z.string().optional()
                .describe('Exact component type to get the full manifest for.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ app, component }) => {
        const components = await client.getComponents(app) as ComponentManifest[];
        if (component) {
            const manifest = components.find(c => c.name === component);
            if (!manifest) {
                return textResult({
                    error: `Component "${component}" not found in app "${app}".`,
                    available: components.map(c => c.name)
                });
            }
            // Strip fields irrelevant for authoring to keep the output lean.
            const { icon, author, dependencies, ...essential } = manifest as Record<string, unknown>;
            return textResult(essential, 40_000);
        }
        const rows = components.map(c => ({
            type: c.name,
            description: c.description ? truncate(String(c.description), 150) : undefined,
            trigger: !c.inPorts || c.inPorts.length === 0,
            inPorts: (c.inPorts || []).map(p => p.name),
            outPorts: (c.outPorts || []).map(p => p.name)
        }));
        return textResult({
            count: rows.length,
            note: 'Call get_components with `component` set to a type to get its full manifest.',
            components: rows
        });
    }));

    server.registerTool('list_accounts', {
        title: 'List Accounts',
        description: 'List third-party accounts (Slack, Google, …) connected by the authenticated ' +
            'Appmixer user. Components of connected apps need an account; accounts are connected by ' +
            'the user in the Appmixer UI, not through this server.',
        inputSchema: {},
        annotations: { readOnlyHint: true }
    }, safeHandler(async () => {
        const accounts = await client.getAccounts();
        const rows = accounts.map(account => ({
            accountId: account.accountId ?? account.id,
            service: account.service,
            name: account.name ?? account.displayName,
            profile: account.profileInfo
        }));
        return textResult({ count: rows.length, accounts: rows });
    }));

    server.registerTool('create_flow', {
        title: 'Create Flow',
        description: 'Create a new Appmixer flow from a flow descriptor JSON and validate it. ' +
            'Read get_flow_authoring_guide first and discover exact component types, ports and ' +
            'fields with get_components. The flow is created stopped; fix any validation errors ' +
            'with update_flow, then use start_flow.',
        inputSchema: {
            name: z.string().min(1).describe('Human-readable flow name.'),
            flow: FLOW_DESCRIPTOR,
            description: z.string().optional().describe('Optional flow description.')
        },
        annotations: { destructiveHint: false }
    }, safeHandler(async ({ name, flow, description }) => {
        const created = await client.createFlow({ name, flow, description });
        const validation = await validationSummary(client, created.flowId);
        return textResult({ flowId: created.flowId, validation });
    }));

    server.registerTool('update_flow', {
        title: 'Update Flow',
        description: 'Update an existing Appmixer flow (descriptor and/or name) and re-validate it. ' +
            'The flow must be stopped. Send the COMPLETE flow descriptor — it replaces the stored one.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow to update.'),
            flow: FLOW_DESCRIPTOR.optional(),
            name: z.string().optional().describe('New flow name.'),
            description: z.string().optional().describe('New flow description.')
        },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ id, flow, name, description }) => {
        const body: Record<string, unknown> = {};
        if (flow !== undefined) body.flow = flow;
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        await client.updateFlow(id, body);
        const validation = await validationSummary(client, id);
        return textResult({ flowId: id, updated: true, validation });
    }));

    server.registerTool('validate_flow', {
        title: 'Validate Flow',
        description: 'Validate an Appmixer flow server-side. Returns per-component errors (wrong ' +
            'port names, missing required fields, invalid variables). A flow must be valid to start.',
        inputSchema: { id: z.string().min(1).describe('The ID of the flow to validate.') },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id }) => {
        return textResult(await validationSummary(client, id));
    }));
}
