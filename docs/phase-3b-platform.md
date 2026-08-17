# Fáze 3b — závislosti na platform týmu

> Stav k 2026-08-17. Fáze 3a (streamable HTTP transport, env/bearer auth režimy,
> Docker) je hotová v tomto repu a na platformě nezávisí. Tento dokument je
> zadání zbývající práce, kterou MCP server sám vyřešit nemůže — podklad pro
> tickety na platform tým. Kontext: analýza „Appmixer MCP 2.0" a
> `docs/mcptools-endpoints.md`.

## Co už funguje bez platformy (fáze 3a — hotovo)

| Režim | Použití | Omezení |
|---|---|---|
| stdio (`appmixer-mcp`) | lokální klienti (Claude Code/Desktop, IDE) | credentials v env |
| HTTP `MCP_AUTH_MODE=env` | self-hosted, jeden uživatel/tým | jeden sdílený účet pro všechny klienty |
| HTTP `MCP_AUTH_MODE=bearer` | self-hosted, multi-user | klient musí umět poslat `Authorization` hlavičku (Claude Code ano, **claude.ai konektory ne**); token = plný 30denní user JWT |

## 1. OAuth most pro claude.ai (blokuje veřejné konektory)

**Problém:** claude.ai konektory nepodporují user-pasted bearer tokeny — vyžadují
OAuth 2.0 (preferovaně CIMD, fallback DCR; callback `https://claude.ai/api/mcp/auth_callback`).
OAuth authorization server umíme přidat do MCP serveru (SDK `mcpAuthRouter`),
ale **autorizační krok potřebuje oficiální přihlašovací stránku Appmixeru** —
nechceme sbírat hesla ve vlastním formuláři (anti-pattern, nefunkční pro SSO tenanty).

**Co potřebujeme od platformy:**
- Redirect/ticket mechanismus: MCP server přesměruje uživatele na tenant login
  (Studio/vlastní stránka) s ticketem; po přihlášení se uživatel vrátí na
  callback MCP serveru, který si ticket vymění za token (vzor už existuje:
  `POST /auth/ticket` + `GET /auth/status/{ticket}` pro OAuth 3. stran).
- Funkční pro SSO (SAML/OIDC) tenanty.

**Akceptace:** uživatel na claude.ai přidá konektor URL, proběhne přihlášení do
Appmixeru v prohlížeči, konektor je připojený bez ručního kopírování tokenu.

## 2. PAT / scoped tokeny + revokace + refresh

**Problém:** jediná dlouhodobá identita je 30denní plný user JWT (`GRIDD_JWT_TOKEN_EXP`):
- nelze revokovat (při úniku nezbývá než smazat uživatele nebo rotovat JWT secret tenantu),
- nelze omezit rozsah (token může vše, co uživatel),
- neexistuje refresh endpoint (mimo SSO) — obnova jen heslem.

**Co potřebujeme od platformy:**
- Personal Access Tokens: vytvoření/výpis/revokace, volitelná expirace, scope
  (minimálně: omezení na ACL roli / výčet route-resources),
- nebo aspoň revokovatelný refresh token pro OAuth most z bodu 1.

**Akceptace:** MCP server může držet krátkodobý access token a obnovovat ho bez
hesla; admin vidí a může zneplatnit vydané tokeny.

## 3. Oficiální per-tenant hosting `api.TENANT.appmixer.cloud/mcp`

**Problém:** dnes je remote server self-hosted (Docker za vlastní reverse proxy).
Pro zákazníky chceme MCP endpoint jako součást tenant deploymentu.

**Co potřebujeme od platformy/devops:**
- zařazení `appmixer-mcp-http` image do tenant stacku (compose/k8s),
- routing `/mcp` + `/healthz` na tenant API doméně, TLS,
- konfigurace: `MCP_AUTH_MODE=bearer` (později OAuth), `APPMIXER_BASE_URL` na interní API,
- monitoring healthz.

**Akceptace:** nový tenant má MCP endpoint automaticky; dokumentovaná URL pro zákazníky.

## 4. Merge mcptools (connectors PR #1117)

**Problém:** MCP Gateway tooly závisí na nemergnutém PR. Detily a nalezené vady
(chybějící `await` v `mcpListTools`, JWT v query stringu SSE, ruční ověření
tokenu mimo auth pipeline, timeout jako HTTP 200): `docs/mcptools-endpoints.md`.

**Co potřebujeme:** opravit vady, mergnout, vydat; ideálně nahradit SSE token
v query stringu krátkodobým ticketem.

**Akceptace:** `TOOLS=mcpgateway` funguje proti oficiálně vydanému tenantu;
e2e test gateway lifecycle v CI.

## 5. Jemnější ACL (nice-to-have)

Route ACL dnes vynucuje jen resource `flows`. Pro „MCP token smí číst flow, ale
ne sahat na accounts/logs/stores" je třeba rozšířit enforcement v core na další
resources. Souvisí s scopes u PAT (bod 2) — řešit společně.

## Doporučené pořadí

1. **PAT + revokace (bod 2)** — největší bezpečnostní dluh, odblokuje důvěryhodný bearer režim.
2. **OAuth ticket flow (bod 1)** — odblokuje claude.ai a Anthropic Directory.
3. **Hosting (bod 3)** — může běžet paralelně s 1–2.
4. **mcptools (bod 4)** — nezávislé, kdykoli.
5. **ACL (bod 5)** — spolu s PAT scopes.
