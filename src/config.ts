export interface Config {
    baseUrl: string;
    accessToken?: string;
    username?: string;
    password?: string;
    /** Enabled tool groups: 'api', 'mcpgateway'. */
    tools: Set<string>;
}

export class ConfigError extends Error {}

export type HttpAuthMode = 'env' | 'bearer';

export interface HttpConfig extends Config {
    port: number;
    host: string;
    /** Origin header allowlist; requests with an Origin not listed here are rejected. */
    allowedOrigins: string[];
    authMode: HttpAuthMode;
    /** Idle session lifetime in milliseconds. */
    sessionIdleMs: number;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {

    const authModeRaw = (env.MCP_AUTH_MODE || '').trim().toLowerCase();
    if (authModeRaw && authModeRaw !== 'env' && authModeRaw !== 'bearer') {
        throw new ConfigError(`MCP_AUTH_MODE must be "env" or "bearer", got "${authModeRaw}".`);
    }

    const hasEnvCredentials = Boolean(
        env.APPMIXER_ACCESS_TOKEN?.trim() || (env.APPMIXER_USERNAME?.trim() && env.APPMIXER_PASSWORD));
    const authMode: HttpAuthMode = (authModeRaw as HttpAuthMode)
        || (hasEnvCredentials ? 'env' : 'bearer');

    const base = loadConfig(env, { requireCredentials: authMode === 'env' });

    const port = Number(env.PORT || env.MCP_HTTP_PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`Invalid port: ${env.PORT || env.MCP_HTTP_PORT}`);
    }
    const sessionIdleSeconds = Number(env.MCP_SESSION_IDLE_TIMEOUT || 4 * 3600);
    if (!Number.isFinite(sessionIdleSeconds) || sessionIdleSeconds < 60) {
        throw new ConfigError('MCP_SESSION_IDLE_TIMEOUT must be at least 60 (seconds).');
    }

    return {
        ...base,
        port,
        host: env.MCP_HTTP_HOST || '127.0.0.1',
        allowedOrigins: (env.MCP_ALLOWED_ORIGINS || '')
            .split(',').map(origin => origin.trim().replace(/\/+$/, '')).filter(Boolean),
        authMode,
        sessionIdleMs: sessionIdleSeconds * 1000
    };
}

export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
    options: { requireCredentials?: boolean } = {}
): Config {

    const baseUrl = (env.APPMIXER_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
        throw new ConfigError(
            'APPMIXER_BASE_URL is required. Example: https://api.YOUR_TENANT.appmixer.cloud');
    }
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error();
        }
    } catch {
        throw new ConfigError(`APPMIXER_BASE_URL is not a valid URL: ${baseUrl}`);
    }

    const accessToken = env.APPMIXER_ACCESS_TOKEN?.trim() || undefined;
    const username = env.APPMIXER_USERNAME?.trim() || undefined;
    const password = env.APPMIXER_PASSWORD || undefined;

    if (options.requireCredentials !== false && !accessToken && !(username && password)) {
        throw new ConfigError(
            'Either APPMIXER_ACCESS_TOKEN or APPMIXER_USERNAME + APPMIXER_PASSWORD must be set.');
    }

    const tools = new Set(
        (env.TOOLS || 'api,mcpgateway')
            .split(',')
            .map(t => t.trim().toLowerCase())
            .filter(Boolean)
    );

    return { baseUrl, accessToken, username, password, tools };
}
