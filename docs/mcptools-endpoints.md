# Modul `appmixer.ai.mcptools` — dokumentace endpointů

> Fáze 0 — dokumentace nedokumentované závislosti appmixer-mcp serveru.
>
> **Zdroj:** PR [Appmixer-ai/appmixer-connectors#1117](https://github.com/Appmixer-ai/appmixer-connectors/pull/1117)
> (head: `apx-vero/appmixer-connectors@1ced0eb8`, branch `fix/mcp-gateway-outport-examples`).
> **Stav k 2026-08-17: PR je OTEVŘENÝ, nemergnutý** (od 2026-05-29, nahrazuje #1023).
> Modul není v žádném release `appmixer-connectors` — appmixer-mcp v1.x tedy závisí
> na kódu, který oficiálně neexistuje.

## Přehled

Modul dodává komponentu **MCPGateway** (kategorie „MCP Tools") a plugin routes.
MCPGateway běží ve flow a vystavuje tooly připojené na její porty:

- port `tools` → řetězce začínající `appmixer.ai.agenttools.ToolStart` (ruční definice toolu ve flow),
- port `mcp` → komponenty `appmixer.mcpservers.*.MCPServer` (proxy na 3rd-party MCP servery).

appmixer-mcp server tyto gatewaye čte a jejich tooly publikuje MCP klientům.

## REST endpointy

Mount prefix: `/plugins/appmixer/ai/mcptools` (viz `engine/src/context/Plugin.js`).

### `GET /gateways` — seznam gatewayí uživatele

- **Auth:** `jwt-strategy` (Bearer token).
- **Handler:** vrací obsah service-state setu `mcpgateways:user:<userId>`.
- **Odpověď:** pole objektů:

```json
[
  {
    "flowId": "…",
    "componentId": "…",
    "webhook": "https://api.tenant…/flows/<flowId>/components/<componentId>",
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "<componentIdNeboShortUuid>_<toolName>",
          "description": "…",
          "parameters": { "type": "object", "properties": { } }
        }
      }
    ]
  }
]
```

Záznam do setu zapisuje `MCPGateway.start()` (`context.service.stateAddToSet`),
odebírá `MCPGateway.stop()`. Formát názvu toolu: pro ToolStart řetězce
`<componentId>_<sanitizovanýLabel>` (ořez na 64 znaků), pro MCP servery
`<shortUuid(componentId)>_<toolName>` (short-uuid kvůli 64znakovému limitu).

### `POST /gateways` — broadcast `gateway-add`

- **Auth:** `jwt-strategy`.
- Nic neukládá — pouze publikuje `{ type: 'gateway-add', data: <payload> }`
  na pub/sub kanál `stream:mcp:events:<userId>`. Volá ho `MCPGateway.start()`
  (s prázdným body) po zápisu do service state. Vrací `{}`.

### `DELETE /gateways/{gatewayId}` — broadcast `gateway-delete`

- **Auth:** `jwt-strategy`.
- Opět nic nemaže — publikuje `{ type: 'gateway-delete', id: <gatewayId>, data: … }`
  na tentýž kanál. `gatewayId` je componentId MCPGateway komponenty. Volá ho
  `MCPGateway.stop()` po odebrání ze service state. Vrací `{}`.

### `GET /events?token=<JWT>` — SSE stream událostí

- **Auth:** strategie `public` + **ruční** ověření JWT z query parametru
  (`jwt.verify` proti secretu načtenému přímo z core kolekce `config`,
  typ `JWTSecret`); `userId` se bere z `sub` claimu.
- **CORS:** `origin: ['*']`.
- **Chování:** `text/event-stream`; úvodní `: init`, heartbeat `: ping` každých
  `SSE_HEARTBEAT_INTERVAL` ms (default 15 s); události = JSON z kanálu
  `stream:mcp:events:<userId>` (`gateway-add` / `gateway-delete`).
  Unsubscribe při odpojení klienta.
- appmixer-mcp na událost reaguje `server.sendToolListChanged()`.

## Volání toolu (webhook)

`POST <gateway.webhook>` — tj. `POST /flows/<flowId>/components/<componentId>`
(standardní webhook endpoint trigger komponenty v core, auth dle flow) s tělem:

```json
{ "function": { "name": "<prefix>_<toolName>", "arguments": { } } }
```

`MCPGateway.receive()`:

1. rozparsuje `name` na `componentId` (příp. z short-uuid) a `toolName`;
2. **MCP server komponenta** → `POST /flows/<flowId>/components/<cid>?action=callTool`
   s `{ name, arguments }`, výstup vrací synchronně (chyby vrací jako text, ne 5xx);
3. **ToolStart řetězec** → pošle `{ toolCalls: [...] }` na port `tools` a polluje
   flow state pod `correlationId` (interval 300 ms, timeout 120 s — pak vrací
   `"Error: Tool timed out."` s HTTP 200);
4. malformed request → HTTP 400.

Discovery toolů MCP serverů: `POST /flows/<flowId>/components/<cid>?action=listTools`.

## Nálezy / problémy (k vyřešení před spoléháním se na modul)

| # | Problém | Detail |
|---|---------|--------|
| 1 | **PR není mergnutý** | Celá gateway funkce appmixer-mcp stojí na neschváleném PR; v PR zbývají 4 otevřené TODO položky (webhook flag v manifestu, UUID guard pro correlationId, 400 na malformed JSON — částečně řešeno, e2e fix). |
| 2 | **Bug: chybějící `await` v `mcpListTools`** | `const { data } = context.callAppmixer({ … })` destrukturuje Promise → `data` je vždy `undefined`. Discovery toolů z MCP server komponent přes `callAppmixer` nemůže fungovat (zakomentovaná `httpRequest` varianta byla správně). `MCPGateway.js`, `mcpListTools`. |
| 3 | **JWT v query stringu SSE** | Token se loguje v access lozích/proxy. Zdůvodněno omezením `EventSource`; řešení: krátkodobý jednorázový ticket (vzor `POST /auth/ticket` v core) místo plného JWT. |
| 4 | **SSE obchází auth pipeline** | Ruční `jwt.verify` proti secretu z DB přeskakuje validace `jwt-strategy` (existence uživatele, group-context re-validace). Revokovaný/smazaný uživatel se streamem dál poslouchá do expirace tokenu. |
| 5 | **Timeout toolu vrací HTTP 200** | `"Error: Tool timed out."` jako úspěšná odpověď — MCP klient by měl dostat chybu (`isError`), jinak LLM považuje timeout za výsledek. |
| 6 | **`stateRemoveFromSet` křehkost** | `stop()` odebírá záznam rekonstruovaný z `stateGet('tools')` — pokud se definice toolů mezi start/stop změní (edit flow), záznam v setu nemusí odpovídat a gateway „visí" v seznamu. |

## Důsledky pro appmixer-mcp v2

- Gateway funkci držet za feature flagem (`TOOLS=mcpgateway`) a degradovat
  gracefully, dokud modul není mergnutý a vydaný (dnes: pokud endpointy
  neexistují, v1 jen zaloguje chybu — v2 musí umět běžet čistě v `api` režimu).
- Tlačit na merge #1117 s opravou nálezů 2–5 (vlastník: platform tým / autor PR).
- E2E testy v2 musí pokrývat i lifecycle gateway (start/stop flow → listChanged).
