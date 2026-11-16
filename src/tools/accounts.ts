import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient, AuthStatus, AuthUrlResult } from '../client.js';
import { currentCallSignal } from '../cancellation.js';
import { ApiError } from '../errors.js';
import { safeHandler, textResult } from '../format.js';
import { MIN_CORE_VERSION, compatibilityWarning, supportsCore } from '../tenant.js';
import { VERSION } from '../version.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_SECONDS = 60;

/** Resolve after `ms`, or early when the tool call is cancelled. */
function pause(ms: number): Promise<void> {
    const signal = currentCallSignal();
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}

type ConnectionKind = 'oauth' | 'form' | 'form-then-oauth';

/**
 * Where the user goes to finish the connection. Every one of these pages is
 * either the provider's or core's own minimal form: the user never needs
 * Studio, and credentials typed into a form never pass through the model.
 */
export function connectionTarget(baseUrl: string, result: AuthUrlResult): { kind: ConnectionKind; url: string } {
    if (typeof result.dataUrl === 'string') {
        // Relative to the API base URL, e.g. "auth-pre?ticket=…".
        const url = /^https?:\/\//.test(result.dataUrl)
            ? result.dataUrl
            : `${baseUrl}/${result.dataUrl.replace(/^\//, '')}`;
        return { kind: 'form-then-oauth', url };
    }
    if (typeof result.authUrl === 'string') {
        return { kind: result.inputs ? 'form' : 'oauth', url: result.authUrl };
    }
    throw new ApiError('The tenant returned no URL to connect the account with.', undefined, 'GET', baseUrl, result);
}

/** Field names and labels of a key-based form, without any values. */
function describeFields(inputs: Record<string, unknown> | undefined) {
    if (!inputs) return undefined;
    return Object.entries(inputs).map(([name, field]) => {
        const label = field && typeof field === 'object' ? (field as { name?: unknown }).name : undefined;
        return typeof label === 'string' && label !== name ? { name, label } : { name };
    });
}

function asList(value: AuthStatus['componentIds']): string[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * Tools about the tenant itself and the third-party accounts its flows use.
 * Connecting an account is what kept "build a flow end to end without the
 * UI" out of reach: core supports it through tickets, and these tools drive
 * that flow, handing the user only the provider's (or core's) sign-in page.
 */
export function registerAccountTools(server: McpServer, client: AppmixerClient): void {

    server.registerTool('get_tenant_info', {
        title: 'Get Tenant Info',
        description: 'Describe the Appmixer tenant this server talks to: its appmixer-core version, ' +
            'tenant ID and Studio URL, the version of this MCP server and whether the core version ' +
            'is supported. Use it when a tool fails in a way that suggests a missing endpoint, or ' +
            'when the user asks which tenant they are connected to.',
        inputSchema: {},
        annotations: { readOnlyHint: true }
    }, safeHandler(async () => {
        const info = await client.getTenantInfo();
        return textResult({
            apiUrl: client.baseUrl,
            ...info,
            mcpServerVersion: VERSION,
            minSupportedCoreVersion: MIN_CORE_VERSION,
            coreSupported: supportsCore(info.version) ?? 'unknown (the tenant did not report a version)',
            warning: compatibilityWarning(info)
        });
    }));

    server.registerTool('connect_account', {
        title: 'Connect Account',
        description: 'Start connecting a third-party account (Slack, Google, an API key, …) that flow ' +
            'components need. Returns a `url` the USER must open in their browser — the service\'s ' +
            'own sign-in page, or a short Appmixer form for API keys and passwords — and a `ticket`. ' +
            'Show the URL to the user and ask them to finish there; never ask them to paste keys or ' +
            'passwords into the chat. Then call get_account_connection with the ticket to wait for ' +
            'the result. Pass the component\'s full type so the account gets exactly the permissions ' +
            'that component needs, and its component_id to have the new account assigned to it ' +
            'automatically. The ticket expires after about 10 minutes.',
        inputSchema: {
            type: z.string().min(1).describe('Component type the account is for, e.g. ' +
                '"appmixer.slack.list.SendChannelMessage" (see get_flow or get_components). A prefix ' +
                'such as "appmixer.slack" also works but requests the permissions of every component ' +
                'of that app.'),
            component_id: z.string().min(1).optional().describe('ID of a component in a flow; the ' +
                'new account is assigned to it when the connection completes.'),
            flow_id: z.string().min(1).optional().describe('ID of the flow the component is in.')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    }, safeHandler(async ({ type, component_id, flow_id }) => {
        const { ticket } = await client.createAuthTicket();
        const result = await client.getAuthUrl(type, ticket, { componentId: component_id, flowId: flow_id });
        const target = connectionTarget(client.baseUrl, result);
        const where = target.kind === 'oauth'
            ? 'the service\'s sign-in page'
            : 'a short Appmixer form where they enter the credentials';
        return textResult({
            ticket,
            url: target.url,
            kind: target.kind,
            fields: target.kind === 'form' ? describeFields(result.inputs) : undefined,
            next: `Ask the user to open the URL in their browser (${where}) and finish there, then ` +
                'call get_account_connection with this ticket.'
        });
    }));

    server.registerTool('get_account_connection', {
        title: 'Get Account Connection Result',
        description: 'Check, and optionally wait for, an account connection started by ' +
            'connect_account. Returns status "pending" (the user has not finished yet), "failed" ' +
            'with the reason, or "connected" with the new accountId, and the components it was ' +
            'assigned to. If no component was assigned, bind the account with assign_account.',
        inputSchema: {
            ticket: z.string().min(1).describe('The ticket returned by connect_account.'),
            wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(30).describe(
                'How long to wait for the user to finish before returning "pending". 0 checks once.')
        },
        annotations: { readOnlyHint: true }
    }, safeHandler(async ({ ticket, wait_seconds }) => {
        const deadline = Date.now() + wait_seconds * 1000;
        const signal = currentCallSignal();
        let status: AuthStatus;
        for (;;) {
            try {
                status = await client.getAuthStatus(ticket);
            } catch (err) {
                if (err instanceof ApiError && err.status === 404) {
                    throw new Error('Unknown or expired ticket. Tickets expire about 10 minutes after ' +
                        'connect_account; start again with connect_account.');
                }
                throw err;
            }
            if (status.finished || Date.now() + POLL_INTERVAL_MS > deadline || signal?.aborted) break;
            await pause(POLL_INTERVAL_MS);
        }

        const service = status.serviceLabel ?? status.service;
        if (!status.finished) {
            return textResult({
                status: 'pending',
                service,
                next: 'The user has not finished yet. Remind them to open the URL from ' +
                    'connect_account, then call this tool again.'
            });
        }
        if (status.error) {
            return textResult({
                status: 'failed',
                service,
                error: status.error,
                next: 'Tell the user why it failed; start again with connect_account to retry.'
            });
        }

        const accountId = status.accountId === undefined ? undefined : String(status.accountId);
        let account: Record<string, unknown> | undefined;
        if (accountId) {
            // Best effort: the account's display name helps the user recognise it.
            const accounts = await client.getAccounts().catch(() => []);
            account = accounts.find(row => String(row.accountId ?? row.id) === accountId);
        }
        const assignedTo = asList(status.componentIds);
        return textResult({
            status: 'connected',
            accountId,
            service: account?.service ?? status.service,
            name: account?.name ?? account?.displayName,
            assignedToComponents: assignedTo,
            next: assignedTo.length
                ? undefined
                : 'Assign the account to the components that need it with assign_account.'
        });
    }));
}
