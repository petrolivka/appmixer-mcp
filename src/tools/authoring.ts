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

/** Expand an object schema into concrete leaf variable paths: "$.uuid.out.data.msg (string)". */
function flattenSchemaPaths(schema: unknown, basePath: string, depth = 0): string[] | undefined {
    const s = schema as { type?: string; properties?: Record<string, unknown> } | undefined;
    if (!s || s.type !== 'object' || !s.properties || depth >= 3) return undefined;
    const paths: string[] = [];
    for (const [key, property] of Object.entries(s.properties)) {
        const child = property as { type?: string };
        const path = `${basePath}.${key}`;
        const nested = flattenSchemaPaths(child, path, depth + 1);
        if (nested?.length) {
            paths.push(...nested);
        } else {
            paths.push(`${path} (${child.type || 'unknown'})`);
        }
    }
    return paths;
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

    server.registerTool('get_flow_variables', {
        title: 'Get Flow Variables',
        description: 'Get the output variables available to each component of a flow — the exact ' +
            '"$.<componentId>.<port>.<field>" paths (with schemas) usable in config.transform ' +
            'modifiers. Call this after create_flow/update_flow to fix or build variable references ' +
            'instead of guessing paths.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow.'),
            component_id: z.string().optional()
                .describe('Only return variables available to this component.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id, component_id }) => {
        const result = await client.fetchFlowVariables(id);
        const components = (result.components || {}) as Record<string, {
            links?: Record<string, Record<string, Record<string, {
                variables?: { dynamic?: { label?: string; port?: string; value?: string; schema?: unknown }[] }
            }>>>
        }>;
        const rows: Record<string, unknown>[] = [];
        for (const [componentId, entry] of Object.entries(components)) {
            if (component_id && componentId !== component_id) continue;
            for (const [inPort, upstreams] of Object.entries(entry.links || {})) {
                for (const [upstreamId, ports] of Object.entries(upstreams)) {
                    for (const [port, portEntry] of Object.entries(ports)) {
                        for (const variable of portEntry.variables?.dynamic || []) {
                            const path = variable.value?.replace(/^\{\{\{|\}\}\}$/g, '');
                            rows.push({
                                availableTo: componentId,
                                inPort,
                                from: upstreamId,
                                port,
                                label: variable.label,
                                path,
                                fields: path ? flattenSchemaPaths(variable.schema, path) : undefined
                            });
                        }
                    }
                }
            }
        }
        return textResult({
            count: rows.length,
            note: 'Use `path` as the "variable" of a modifier entry in config.transform ' +
                '(never inside {{{...}}} placeholders directly).',
            variables: rows
        });
    }));

    server.registerTool('test_flow', {
        title: 'Test Flow',
        description: 'Test-run a single component (and its downstream graph) of a flow without ' +
            'starting the flow. Provide the input data the component should receive; returns the ' +
            'outputs each component produced. The flow does not need to be running. Use this to ' +
            'verify a flow works before start_flow.',
        inputSchema: {
            id: z.string().min(1).describe('The ID of the flow.'),
            component_id: z.string().min(1)
                .describe('The component to inject test input into (typically the first action after the trigger, or the trigger itself with `payload`).'),
            input_data: z.record(z.string(), z.unknown()).optional()
                .describe('Input for the tested component, keyed by its inPort name, e.g. {"in": {"to": "x@example.com"}}.'),
            payload: z.record(z.string(), z.unknown()).optional()
                .describe('Webhook-style payload when testing a trigger component.'),
            timeout_seconds: z.number().int().min(5).max(120).default(30)
                .describe('How long to wait for the test to finish.')
        },
        annotations: { destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ id, component_id, input_data, payload, timeout_seconds }) => {
        const events = await client.runFlowTest(id, {
            componentId: component_id,
            inputData: input_data,
            payload,
            options: { timeout: timeout_seconds * 1000 }
        }, timeout_seconds * 1000 + 10_000);

        const outputs = events
            .filter(e => e.event === 'component:output')
            .map(e => e.data as Record<string, unknown>)
            .map(d => ({ componentId: d.componentId, port: d.port, data: d.data }));
        const errors = events
            .filter(e => e.event === 'component:error' || e.event === 'test:error')
            .map(e => e.data);
        const doneEvent = events.find(e => e.event === 'test:done');
        return textResult({
            status: doneEvent ? (doneEvent.data as Record<string, unknown>).status : 'timeout',
            outputs,
            errors: errors.length ? errors : undefined,
            events: events.map(e => e.event)
        });
    }));

    server.registerTool('get_flow_accounts', {
        title: 'Get Flow Accounts',
        description: 'List which components of a flow require a connected third-party account and ' +
            'which account (if any) is assigned to them.',
        inputSchema: { id: z.string().min(1).describe('The ID of the flow.') },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ id }) => {
        return textResult(await client.getFlowAccounts(id));
    }));

    server.registerTool('assign_account', {
        title: 'Assign Account',
        description: 'Assign a connected third-party account (see list_accounts) to a component of ' +
            'a flow, so the component can authenticate against its service. The account must belong ' +
            'to the authenticated user and match the component\'s service.',
        inputSchema: {
            component_id: z.string().min(1).describe('The ID of the component (see get_flow).'),
            account_id: z.string().min(1).describe('The ID of the account (see list_accounts).')
        },
        annotations: { destructiveHint: false, idempotentHint: true }
    }, safeHandler(async ({ component_id, account_id }) => {
        await client.assignAccount(component_id, account_id);
        return textResult(`Account ${account_id} assigned to component ${component_id}.`);
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
