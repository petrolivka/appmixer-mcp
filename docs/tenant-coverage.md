# Running the whole tenant from MCP: coverage and gaps

> As of 2026-11-03. Goal agreed that day (point 3 in `status.md`, "Direction"): a user can run
> their whole Appmixer tenant from an MCP client without opening Studio or the Backoffice.
> This maps the core REST API (235 routes in `appmixer-core/gridd/routes` and the system
> plugins, extracted on `593addb9`) against the tools of appmixer-mcp 2.0.0, and proposes
> the order in which to close the gaps. The Copilot routes are left out (point 2), and so is
> uploading connectors (point 4).

Target: appmixer-core 6.5 and newer (the minimum supported version, decided
2026-11-04). Every route listed below as a gap already exists in 6.5.0, except
knowledge bases: that plugin landed on core `dev` on 2026-10-19 and is in no
release yet, so its tools will carry a minimum core version.

## Two audiences, two toolsets

The API splits cleanly by the `admin` scope: 70 routes require it, and they are what the
Backoffice does. Everything else is Studio. That suggests two toolsets rather than one:

- **`TOOLS=api`** (exists): what a tenant user does in Studio, acting as that user.
- **`TOOLS=admin`** (new): what an administrator does in the Backoffice. Off by default,
  because every tool there can affect all users, and because loading it costs tokens that a
  regular user should not pay (see the Cyclr token study in the research doc: tool
  definitions dominate the context).

## Studio (user scope)

Legend: ✅ covered · 🟡 partly · ❌ missing.

| Area | Routes | Today | Gap |
|---|---|---|---|
| Flows: CRUD, start/stop, clone, validate, test | `/flows…` | ✅ | — |
| Flow versions | `/flows/{id}/versions…` | 🟡 list, create, restore | get, rename, delete, clone a version |
| Flow runs and status | `/flows/{id}/runs`, `/coordinator/status` | 🟡 `get_flow_status` | list runs and one run's detail (what Insights shows per run) |
| Logs | `/logs` | ✅ `get_flow_logs` | log detail `/logs/{index}/{id}`; logs across flows, not only per flow |
| Unprocessed messages | `/unprocessed-messages…` | ✅ | — |
| Components and apps catalogue | `/apps`, `/components`, `/categories` | ✅ | — |
| **Accounts (connections)** | `/accounts…`, `/auth…` | 🟡 list, assign to component, accounts of a flow | **connecting a new account**; rename, test, delete; share/unshare; flows using an account |
| Data stores | `/stores`, `/store…` | 🟡 list, create, records get/set/delete | rename and delete a store; search (`find`); export; bulk delete |
| Files | `/files…` | ❌ | list, upload, download, delete — flows read and write them |
| Webhook URLs, URL aliases | `/triggers/{id}/url`, `/url-aliases…` | 🟡 trigger URL | aliases (stable public webhook URLs) |
| Integrations (templates and instances) | `/integrations…`, flows of type integration | ❌ | publish a template change to instances; remove instances |
| Insights charts and telemetry | `/charts…`, `/telemetry…` | ❌ | read telemetry; charts are UI-only and can wait |
| Modifiers | `/modifiers`, `/modifiers/transform` | 🟡 list | try a modifier expression (`/modifiers/transform`) |
| Custom OAuth app per user | `/user-service-config…` | ❌ | needed when a user brings their own OAuth client |
| Knowledge bases | `/knowledgebases…` | ❌ | CRUD, ingest, retrieve |
| Automation Hub | `/automation-hub…` | ❌ | settings and analytics |
| Group context | `/auth/available-contexts`, `/auth/switch-context` | ❌ | act in a user group instead of the personal context |
| Quotas seen by the user | `/quota/storage`, `/quota/flows` | ❌ | read only |

### The one that blocks "no UI": connecting an account

Every flow that touches a connected service needs an account, and today the only way to make
one is Studio. The API already supports doing it without Studio:

1. `POST /auth/ticket` → ticket.
2. `GET /auth/{service}/auth-url/{ticket}` → the provider's authorization URL. The MCP tool
   returns it and the user opens it in a browser. That is the third-party provider's page, not
   Studio, so it meets the goal.
3. The provider redirects to `/auth/{service}/callback`; the tool polls `GET /auth/status/{ticket}`
   until the account exists.

API-key and other non-OAuth services go through `/auth-pre`, `/auth/save-pre-data` and
`/auth/process-auth-data` instead. The MCP elicitation feature fits here: the server can ask
the client for the key in a form instead of the model passing it in a tool argument. To verify
before building: which clients support URL elicitation for step 2, and how the callback page
looks when it is not opened from Studio.

## Backoffice (admin scope)

| Area | Routes | What it enables |
|---|---|---|
| Users | `/users…`, `/user/reset-password` | list, create, edit, delete users |
| User groups | `/user-groups…` | groups and membership |
| ACL | `/acl…` | read and change role rules |
| **Connector configuration** | `/service-config…` | OAuth client IDs/secrets and other per-connector settings; without them a new tenant cannot connect accounts |
| Tenant configuration | `/config` | system settings (Copilot keys and others) |
| Connectors installed | `/components` (POST, DELETE) | upload and remove modules — point 4 |
| Categories, public files | `/categories`, `/public-files` | catalogue appearance |
| Quotas | `/quota…` | limits per user and system |
| Operations | `/system…`, `/stats…`, `/listeners` | health, stop flows of a module, audits, usage reports |
| Ownership transfer | `/resources/transfer` | move flows and accounts between users |
| Modifiers | `PUT/DELETE /modifiers` | custom modifier functions |
| Automation Hub settings | `/automation-hub/settings` | |

Admin tools need a stricter design than user tools: every write marked `destructiveHint`,
confirmation through elicitation for deletes and for anything touching other users, and an
audit trail. Core already audit-logs these routes; the tools should not need more.

## Proposed order

1. **Account connection** (OAuth URL flow and API-key form). Without it no flow that uses a
   connected service can be built end to end from MCP, which makes the rest moot.
2. **Rest of accounts and stores**: rename, test, delete, share; store rename, delete, search,
   export. Small, same pattern as the existing tools.
3. **Runs, log detail, files.** What a user needs to debug a flow and feed it data.
4. **`TOOLS=admin`, first slice**: connector configuration (`/service-config`), users and
   groups. This is what a new tenant needs before its users can do anything.
5. **Integrations, URL aliases, group context, user OAuth configs, quotas.**
6. **The rest of admin** (ACL, config, quotas, operations, transfer) and **knowledge bases,
   Automation Hub, telemetry**, as demand shows.

Charts and thumbnails stay UI-only.

## Open questions

- **Size.** Closing all of this adds roughly 50–70 tools. Two toolsets help; beyond that,
  consider grouping CRUD into fewer tools with an `action` argument, and measure `tools/list`
  as we go (37 API tools are ~6.8k tokens today).
- **Overlap with point 2.** If authoring moves onto a Copilot API, the authoring tools change,
  but none of the gaps above do: they are plain resource management.
- **Admin over OAuth.** A token issued through appmixer-core#4911 carries the user's scopes,
  admin included. Whether an admin should be able to grant a connector admin rights, or the
  connector should be user-scope only unless explicitly allowed, belongs in that issue's design.
