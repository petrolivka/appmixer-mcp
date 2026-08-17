import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { AppmixerClient } from './client.js';
import { registerApiTools } from './tools/api.js';
import { GatewayManager, type Logger } from './tools/gateway.js';

export const VERSION = '2.0.0';

const INSTRUCTIONS = `Tools for the Appmixer workflow-automation platform, operating on the
authenticated user's tenant.

- Flow IDs are not guessable: call list_flows first.
- get_flow without include_descriptor lists the flow's components and their IDs
  (needed by trigger_component); request the full descriptor only when you need
  the wiring details.
- Additional tools may appear or disappear at runtime: any flow that contains a
  running "MCP Gateway" component contributes its connected tools to this server.`;

export interface AppmixerMcpServer {
    server: McpServer;
    client: AppmixerClient;
    gatewayManager?: GatewayManager;
    start(): Promise<void>;
    stop(): void;
}

export function createAppmixerServer(config: Config, log: Logger): AppmixerMcpServer {

    const client = new AppmixerClient(config);
    const server = new McpServer(
        { name: 'appmixer', version: VERSION },
        { instructions: INSTRUCTIONS }
    );

    if (config.tools.has('api')) {
        registerApiTools(server, client);
    }

    let gatewayManager: GatewayManager | undefined;
    if (config.tools.has('mcpgateway')) {
        gatewayManager = new GatewayManager(server, client, log);
    }

    return {
        server,
        client,
        gatewayManager,
        async start() {
            // Load gateway tools before the client's first tools/list if possible,
            // but never fail server startup because of the gateway plugin.
            if (gatewayManager) {
                try {
                    await gatewayManager.start();
                } catch (err) {
                    log('Gateway manager failed to start; continuing with API tools only.', err);
                }
            }
        },
        stop() {
            gatewayManager?.stop();
        }
    };
}
