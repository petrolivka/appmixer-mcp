import { EventSource } from 'eventsource';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppmixerClient } from '../client.js';
import { ApiError } from '../errors.js';
import { safeHandler, textResult } from '../format.js';
import { jsonSchemaToZod } from './json-schema-to-zod.js';

const RECONNECT_DELAY_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 300;
const MAX_TOOL_NAME_LENGTH = 64;

export interface Logger {
    (message: string, detail?: unknown): void;
}

/**
 * Manages dynamic tools exposed by "MCP Gateway" components running in the
 * user's Appmixer flows. Tools are (re)registered whenever a gateway is added
 * or removed (SSE events from the mcptools plugin), emitting standard MCP
 * tools/list_changed notifications.
 *
 * The mcptools plugin ships separately from Appmixer core (see
 * docs/mcptools-endpoints.md). When its endpoints are missing (404), the
 * manager disables itself gracefully so the server keeps working in API-only
 * mode.
 */
export class GatewayManager {

    private registered = new Map<string, RegisteredTool>();
    private eventSource?: EventSource;
    private refreshTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;
    private stopped = false;

    constructor(
        private readonly server: McpServer,
        private readonly client: AppmixerClient,
        private readonly log: Logger
    ) {}

    async start(): Promise<void> {
        const available = await this.refresh();
        if (available) {
            await this.connectEvents();
        }
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.refreshTimer);
        clearTimeout(this.reconnectTimer);
        this.eventSource?.close();
    }

    /** Fetch gateways and reconcile registered tools. Returns false when the plugin is unavailable. */
    async refresh(): Promise<boolean> {
        let gateways;
        try {
            gateways = await this.client.getGateways();
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
                this.log('MCP Gateway plugin (appmixer.ai.mcptools) is not installed on this tenant; ' +
                    'gateway tools disabled. API tools keep working.');
                return false;
            }
            this.log('Failed to fetch MCP gateways; keeping previously registered tools.', err);
            return true;
        }

        const desired = new Map<string, { description: string; parameters?: Record<string, unknown>; webhook: string; originalName: string }>();
        const taken = new Set<string>();

        for (const gateway of gateways || []) {
            for (const tool of gateway.tools || []) {
                if (tool?.function?.name && gateway.webhook) {
                    const name = uniqueName(sanitizeToolName(tool.function.name), taken);
                    taken.add(name);
                    desired.set(name, {
                        description: tool.function.description || `Appmixer MCP Gateway tool ${tool.function.name}`,
                        parameters: tool.function.parameters,
                        webhook: gateway.webhook,
                        originalName: tool.function.name
                    });
                }
            }
        }

        // Remove tools that disappeared.
        for (const [name, handle] of this.registered) {
            if (!desired.has(name)) {
                handle.remove();
                this.registered.delete(name);
            }
        }
        // Add new tools.
        for (const [name, definition] of desired) {
            if (this.registered.has(name)) continue;
            const handle = this.server.registerTool(name, {
                title: definition.originalName.split('_').slice(1).join('_') || definition.originalName,
                description: definition.description,
                inputSchema: jsonSchemaToZod(definition.parameters || { type: 'object' }) as never,
                annotations: { openWorldHint: true }
            }, safeHandler(async (args: Record<string, unknown>) => {
                const result = await this.client.callGatewayTool(
                    definition.webhook, definition.originalName, args);
                return textResult(result ?? 'Tool executed.');
            }) as never);
            this.registered.set(name, handle);
        }

        this.log(`MCP Gateway tools: ${this.registered.size} registered.`);
        return true;
    }

    private scheduleRefresh(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refresh().catch(err => this.log('Gateway refresh failed.', err));
        }, REFRESH_DEBOUNCE_MS);
    }

    private async connectEvents(): Promise<void> {
        if (this.stopped) return;
        let token: string;
        try {
            token = await this.client.ensureToken();
        } catch (err) {
            this.log('Cannot obtain token for gateway event stream.', err);
            this.scheduleReconnect();
            return;
        }
        // NOTE: the mcptools /events endpoint only accepts the JWT as a query
        // parameter (EventSource limitation on the plugin side). Tracked as a
        // known issue in docs/mcptools-endpoints.md.
        const url = `${this.client.baseUrl}/plugins/appmixer/ai/mcptools/events?token=${encodeURIComponent(token)}`;
        this.eventSource?.close();
        this.eventSource = new EventSource(url);

        this.eventSource.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data) as { type?: string };
                if (data.type === 'gateway-add' || data.type === 'gateway-delete') {
                    this.scheduleRefresh();
                }
            } catch {
                // Ignore malformed events.
            }
        });
        this.eventSource.addEventListener('error', () => {
            this.eventSource?.close();
            this.scheduleReconnect();
        });
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            // Re-sync missed events, then reconnect with a fresh token.
            this.refresh().catch(err => this.log('Gateway refresh failed.', err));
            this.connectEvents().catch(err => this.log('Gateway event stream reconnect failed.', err));
        }, RECONNECT_DELAY_MS);
    }
}

export function sanitizeToolName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return sanitized.slice(0, MAX_TOOL_NAME_LENGTH) || 'tool';
}

export function uniqueName(name: string, taken: Set<string>): string {
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) {
        const suffix = `_${i}`;
        const candidate = name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
        if (!taken.has(candidate)) return candidate;
    }
}
