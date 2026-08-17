export interface Config {
    baseUrl: string;
    accessToken?: string;
    username?: string;
    password?: string;
    /** Enabled tool groups: 'api', 'mcpgateway'. */
    tools: Set<string>;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {

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

    if (!accessToken && !(username && password)) {
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
