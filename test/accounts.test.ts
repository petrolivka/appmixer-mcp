import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAppmixerServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { compatibilityWarning, parseVersion, supportsCore } from '../src/tenant.js';
import { connectionTarget } from '../src/tools/accounts.js';
import { futureJwt, jsonResponse } from './helpers.js';

const BASE_URL = 'https://api.tenant.appmixer.cloud';

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

function resultJson(result: unknown): Record<string, unknown> {
    return JSON.parse(((result as { content: { text: string }[] }).content)[0].text);
}

describe('tenant version', () => {

    it('parses release, pre-release and short versions', () => {
        expect(parseVersion('6.5.15')).toEqual([6, 5, 15]);
        expect(parseVersion('6.6.0-rc.1')).toEqual([6, 6, 0]);
        expect(parseVersion('6.5')).toEqual([6, 5, 0]);
        expect(parseVersion('dev')).toBeUndefined();
        expect(parseVersion(undefined)).toBeUndefined();
    });

    it('supports 6.5 and newer, and says so only for older cores', () => {
        expect(supportsCore('6.5.0')).toBe(true);
        expect(supportsCore('6.6.0')).toBe(true);
        expect(supportsCore('7.0.0')).toBe(true);
        expect(supportsCore('6.4.15')).toBe(false);
        expect(supportsCore(undefined)).toBeUndefined();
        expect(compatibilityWarning({ version: '6.4.15' })).toContain('6.4.15');
        expect(compatibilityWarning({ version: '6.5.15' })).toBeUndefined();
        expect(compatibilityWarning({})).toBeUndefined();
    });
});

describe('connectionTarget', () => {

    it('distinguishes OAuth, key forms and pre-auth forms', () => {
        expect(connectionTarget(BASE_URL, { authUrl: 'https://slack.com/oauth/v2/authorize?x=1' }))
            .toEqual({ kind: 'oauth', url: 'https://slack.com/oauth/v2/authorize?x=1' });
        expect(connectionTarget(BASE_URL, {
            authUrl: `${BASE_URL}/auth-service?ticket=t`, inputs: { apiKey: { type: 'text' } }
        })).toEqual({ kind: 'form', url: `${BASE_URL}/auth-service?ticket=t` });
        expect(connectionTarget(BASE_URL, { dataUrl: 'auth-pre?ticket=t', authUrlRedirect: 'x' }))
            .toEqual({ kind: 'form-then-oauth', url: `${BASE_URL}/auth-pre?ticket=t` });
        expect(() => connectionTarget(BASE_URL, {})).toThrow(/no URL/);
    });
});

describe('account tools', () => {

    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('get_tenant_info reports the core version without authenticating', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            name: 'Appmixer', version: '6.5.15', tenantId: 'acme', studioUrl: 'https://my.acme.cloud'
        }));
        const client = await connectedClient();

        const info = resultJson(await client.callTool({ name: 'get_tenant_info', arguments: {} }));

        expect(info).toMatchObject({
            version: '6.5.15', tenantId: 'acme', coreSupported: true, minSupportedCoreVersion: '6.5.0'
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${BASE_URL}/`);
        expect(init.headers).toBeUndefined();
    });

    it('connect_account returns the URL and ticket, and passes the component along', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ ticket: 'u1:abc' }))
            .mockResolvedValueOnce(jsonResponse({
                authUrl: `${BASE_URL}/auth-service?ticket=u1:abc`,
                inputs: { apiKey: { type: 'password', name: 'API Key' } }
            }));
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'connect_account',
            arguments: { type: 'appmixer.openai.core.SendPrompt', component_id: 'c1' }
        });

        expect(result.isError).toBeFalsy();
        expect(resultJson(result)).toMatchObject({
            ticket: 'u1:abc',
            kind: 'form',
            url: `${BASE_URL}/auth-service?ticket=u1:abc`,
            fields: [{ name: 'apiKey', label: 'API Key' }]
        });
        expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/auth/ticket`);
        expect(fetchMock.mock.calls[0][1].method).toBe('POST');
        const authUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(authUrl.pathname).toBe('/auth/appmixer.openai.core.SendPrompt/auth-url/u1%3Aabc');
        expect(authUrl.searchParams.get('componentId')).toBe('c1');
    });

    it('get_account_connection reports pending without waiting when asked not to', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ finished: false, service: 'appmixer:slack' }));
        const client = await connectedClient();

        const status = resultJson(await client.callTool({
            name: 'get_account_connection', arguments: { ticket: 't', wait_seconds: 0 }
        }));

        expect(status).toMatchObject({ status: 'pending', service: 'appmixer:slack' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('get_account_connection returns the new account and where it was assigned', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({
                finished: true, error: null, accountId: 'a1', service: 'appmixer:slack', componentIds: ['c1']
            }))
            .mockResolvedValueOnce(jsonResponse([
                { accountId: 'a1', service: 'appmixer:slack', name: 'acme workspace' }
            ]));
        const client = await connectedClient();

        const status = resultJson(await client.callTool({
            name: 'get_account_connection', arguments: { ticket: 't', wait_seconds: 0 }
        }));

        expect(status).toMatchObject({
            status: 'connected', accountId: 'a1', name: 'acme workspace', assignedToComponents: ['c1']
        });
        expect(status.next).toBeUndefined();
    });

    it('get_account_connection reports a failure and an expired ticket', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ finished: true, error: 'Invalid API key' }))
            .mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404));
        const client = await connectedClient();

        const failed = resultJson(await client.callTool({
            name: 'get_account_connection', arguments: { ticket: 't', wait_seconds: 0 }
        }));
        expect(failed).toMatchObject({ status: 'failed', error: 'Invalid API key' });

        const expired = await client.callTool({
            name: 'get_account_connection', arguments: { ticket: 't', wait_seconds: 0 }
        });
        expect(expired.isError).toBe(true);
        expect((expired.content as { text: string }[])[0].text).toMatch(/expired ticket/);
    });
});
