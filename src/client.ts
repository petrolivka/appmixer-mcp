import { ApiError } from './errors.js';
import type { Config } from './config.js';

const TOKEN_EXPIRY_CLEARANCE_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    timeoutMs?: number;
}

export interface GatewayToolFunction {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export interface Gateway {
    flowId: string;
    componentId: string;
    webhook: string;
    tools: { type: string; function: GatewayToolFunction }[];
}

/** Decode a JWT payload without verifying the signature (client-side expiry check only). */
export function jwtExpiresAt(token: string): number | undefined {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' ? payload.exp : undefined;
    } catch {
        return undefined;
    }
}

export class AppmixerClient {

    private token?: string;
    private refreshPromise?: Promise<string>;

    constructor(private readonly config: Pick<Config, 'baseUrl' | 'accessToken' | 'username' | 'password'>) {
        this.token = config.accessToken;
    }

    get baseUrl(): string {
        return this.config.baseUrl;
    }

    private tokenUsable(): boolean {
        if (!this.token) return false;
        const exp = jwtExpiresAt(this.token);
        if (exp === undefined) return false;
        return exp > Date.now() / 1000 + TOKEN_EXPIRY_CLEARANCE_SECONDS;
    }

    private canReauthenticate(): boolean {
        return Boolean(this.config.username && this.config.password);
    }

    /** Returns a valid token, re-authenticating with username/password when possible. */
    async ensureToken(): Promise<string> {
        if (this.tokenUsable()) return this.token as string;
        if (!this.canReauthenticate()) {
            if (this.token) return this.token; // Let the API decide; we cannot renew it anyway.
            throw new ApiError(
                'No usable access token and no credentials to authenticate with.',
                401, 'POST', `${this.config.baseUrl}/user/auth`);
        }
        return this.refreshToken();
    }

    private refreshToken(): Promise<string> {
        // Single-flight: concurrent calls share one login request.
        if (!this.refreshPromise) {
            this.refreshPromise = this.login().finally(() => {
                this.refreshPromise = undefined;
            });
        }
        return this.refreshPromise;
    }

    private async login(): Promise<string> {
        const url = `${this.config.baseUrl}/user/auth`;
        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: this.config.username,
                password: this.config.password
            })
        }, DEFAULT_TIMEOUT_MS);
        if (!response.ok) {
            throw new ApiError(
                `Authentication failed: ${response.status} ${response.statusText}`,
                response.status, 'POST', url, await safeJson(response));
        }
        const data = await response.json() as { token: string };
        this.token = data.token;
        return this.token;
    }

    private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        } catch (err) {
            if (controller.signal.aborted) {
                throw new ApiError(`Request timed out after ${timeoutMs} ms`, undefined,
                    init.method || 'GET', url);
            }
            throw new ApiError(`Network error: ${(err as Error).message}`, undefined,
                init.method || 'GET', url);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Perform an authenticated request. `path` may be a path relative to the
     * tenant base URL or an absolute URL (gateway webhooks).
     */
    async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
        return this.requestInternal<T>(path, options, true);
    }

    private async requestInternal<T>(path: string, options: RequestOptions, allowRetry: boolean): Promise<T> {
        const { method = 'GET', body, query, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

        const url = new URL(/^https?:\/\//.test(path) ? path : `${this.config.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }

        const token = await this.ensureToken();
        const init: RequestInit = {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }

        const response = await this.fetchWithTimeout(url.toString(), init, timeoutMs);

        if (response.status === 401 && allowRetry && this.canReauthenticate()) {
            this.token = undefined;
            return this.requestInternal<T>(path, options, false);
        }
        if (!response.ok) {
            const errorBody = await safeJson(response);
            throw new ApiError(
                `${response.status} ${response.statusText}`,
                response.status, method, url.toString(), errorBody);
        }

        const text = await response.text();
        try {
            return JSON.parse(text) as T;
        } catch {
            return text as T;
        }
    }

    // ---- Domain methods -------------------------------------------------

    getFlows(options: { pattern?: string; filter?: string; limit?: number; offset?: number } = {}) {
        return this.request<Record<string, unknown>[]>('/flows', {
            query: {
                pattern: options.pattern,
                filter: options.filter,
                limit: options.limit,
                offset: options.offset,
                sort: 'mtime:-1',
                projection: '-thumbnail'
            }
        });
    }

    getFlow(id: string) {
        return this.request<Record<string, unknown>>(`/flows/${encodeURIComponent(id)}`);
    }

    deleteFlow(id: string) {
        return this.request(`/flows/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    commandFlow(id: string, command: 'start' | 'stop') {
        return this.request(`/flows/${encodeURIComponent(id)}/coordinator`, {
            method: 'POST',
            body: { command }
        });
    }

    triggerComponent(flowId: string, componentId: string, body: unknown) {
        return this.request(
            `/flows/${encodeURIComponent(flowId)}/components/${encodeURIComponent(componentId)}`,
            { method: 'POST', body: body ?? {} });
    }

    sendAppEvent(event: string, data: unknown) {
        return this.request(
            `/plugins/appmixer/utils/appevents/events/${encodeURIComponent(event)}`,
            { method: 'POST', body: data ?? {} });
    }

    getLogs(flowId: string, options: { query?: string; size?: number } = {}) {
        return this.request<{ hits?: Record<string, unknown>[] }>('/logs', {
            query: { flowId, query: options.query, size: options.size }
        });
    }

    getApps() {
        return this.request<Record<string, { name: string; label?: string; description?: string; category?: string }>>('/apps');
    }

    getComponents(app: string) {
        return this.request<Record<string, unknown>[]>('/apps/components', { query: { app } });
    }

    getAccounts() {
        return this.request<Record<string, unknown>[]>('/accounts');
    }

    createFlow(body: Record<string, unknown>) {
        return this.request<{ flowId: string }>('/flows', { method: 'POST', body });
    }

    updateFlow(id: string, body: Record<string, unknown>) {
        return this.request<Record<string, unknown>>(`/flows/${encodeURIComponent(id)}`, {
            method: 'PUT', body
        });
    }

    validateFlow(id: string) {
        return this.request<{ errors?: unknown[] }>(`/flows/${encodeURIComponent(id)}/validate`);
    }

    fetchFlowVariables(flowId: string) {
        return this.request<{ components?: Record<string, unknown>; flow?: unknown[] }>(
            `/variables/${encodeURIComponent(flowId)}/fetch`, { method: 'POST', body: {} });
    }

    getFlowAccounts(flowId: string) {
        return this.request<Record<string, unknown>[]>(`/accounts/flow/${encodeURIComponent(flowId)}`);
    }

    assignAccount(componentId: string, accountId: string) {
        return this.request(
            `/auth/component/${encodeURIComponent(componentId)}/${encodeURIComponent(accountId)}`,
            { method: 'PUT' });
    }

    /**
     * Run a component test (POST /flows/:id/test) and collect the SSE result
     * events until test:done / test:error or the timeout elapses.
     */
    async runFlowTest(
        flowId: string,
        body: { componentId: string; inputData?: unknown; payload?: unknown; options?: Record<string, unknown> },
        overallTimeoutMs: number
    ): Promise<{ event: string; data: unknown }[]> {

        const token = await this.ensureToken();
        const url = `${this.config.baseUrl}/flows/${encodeURIComponent(flowId)}/test`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), overallTimeoutMs);
        const events: { event: string; data: unknown }[] = [];

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            if (!response.ok || !response.body) {
                throw new ApiError(`${response.status} ${response.statusText}`,
                    response.status, 'POST', url, await safeJson(response));
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let done = false;
            while (!done) {
                const { value, done: streamDone } = await reader.read();
                if (streamDone) break;
                buffer += decoder.decode(value, { stream: true });
                let separator;
                while ((separator = buffer.indexOf('\n\n')) !== -1) {
                    const block = buffer.slice(0, separator);
                    buffer = buffer.slice(separator + 2);
                    let eventName = 'message';
                    const dataLines: string[] = [];
                    for (const line of block.split('\n')) {
                        if (line.startsWith('event:')) eventName = line.slice(6).trim();
                        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                    }
                    if (!dataLines.length && eventName === 'message') continue;
                    let data: unknown = dataLines.join('\n');
                    try { data = JSON.parse(dataLines.join('\n')); } catch { /* keep text */ }
                    events.push({ event: eventName, data });
                    if (eventName === 'test:done' || eventName === 'test:error') {
                        done = true;
                        controller.abort(); // Stop the stream; we have the result.
                    }
                }
            }
        } catch (err) {
            // An abort after test:done/test:error is the expected exit path.
            const finished = events.some(e => e.event === 'test:done' || e.event === 'test:error');
            if (!finished) {
                if (controller.signal.aborted) {
                    events.push({
                        event: 'client:timeout',
                        data: `No test result within ${overallTimeoutMs} ms; collected ${events.length} events.`
                    });
                } else {
                    throw err;
                }
            }
        } finally {
            clearTimeout(timer);
        }
        return events;
    }

    getGateways() {
        return this.request<Gateway[]>('/plugins/appmixer/ai/mcptools/gateways');
    }

    callGatewayTool(webhook: string, name: string, args: unknown) {
        return this.request(webhook, {
            method: 'POST',
            body: { function: { name, arguments: args } },
            timeoutMs: 130_000 // Gateway tool polling on the Appmixer side can take up to 120 s.
        });
    }
}

async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return undefined;
    }
}
