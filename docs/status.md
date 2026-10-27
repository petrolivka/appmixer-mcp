# Where things stand

> Snapshot taken 2026-08-23, when development paused to wait for review,
> merge and the first release. Written so anyone (including us in a month)
> can pick the work up without rereading the whole history.
> Updated 2026-10-14: the connectors PR behind the MCP Gateway tools merged
> and the module is deployed on a dev instance, so the gateway can finally be
> tested live. Nothing else moved.
> Updated 2026-10-19: v2.0.0 is published on npm. What is left is the
> customer documentation, one live test that has never run, and the platform
> work claude.ai needs.
> Updated 2026-10-27: the customer documentation is live at
> <https://docs.appmixer.com/getting-started/appmixer-mcp-server>
> (docs#157 merged) and the gateway suite has had its first green live run.
> What is left is the MCPB directory submission and the platform work.

## The short version

v2 is released. `appmixer-mcp@2.0.0` went to npm on 2026-10-19 with
provenance, and the `.mcpb` desktop bundle is attached to the GitHub release.
Three things are left: the customer documentation, the one live test that has
never actually run, and the platform work that claude.ai connectors need.

## What exists

**Merged into the upstream `main`** as `a02ab48` on 2026-10-16 — PR #5, 26
commits from the fork branch `feat/v2-core`, merged by David Durman — with CI
green on every push including the live suites. Since 2026-10-19 it is also
what `npx appmixer-mcp` installs: `appmixer-mcp@2.0.0` is the `latest` tag on
npm, published with SLSA provenance by `release.yml`.

The server is a TypeScript rewrite on the current MCP SDK with **37 tools**
in three families — operating flows, authoring them, and the data around
them (stores, versions, modifiers, dead-letter queue) — plus dynamic tools
published by MCP Gateway components. It runs over **stdio**, over
**streamable HTTP** (sessions, `env`/`bearer` auth, Origin allowlist,
session cap, rate limiting), and ships as an **MCPB bundle** for Claude
Desktop.

Verification: 75 unit tests, five live suites against a test tenant in CI
(stdio and HTTP smoke, end-to-end authoring, golden descriptors), and 14 LLM
eval tasks scoring real agents — 14/14 on both Sonnet and Haiku.

## What is waiting, and on whom

| Item | Where | Waiting on |
|---|---|---|
| Code review and merge | [appmixer-mcp#5](https://github.com/Appmixer-ai/appmixer-mcp/pull/5) — **merged 2026-10-16** as `a02ab48` | done |
| npm release of v2 | **published 2026-10-19** — `appmixer-mcp@2.0.0`, tag `v2.0.0`, `.mcpb` attached to the release | done |
| Customer documentation | [appmixer-docs-gitbook#157](https://github.com/Appmixer-ai/appmixer-docs-gitbook/pull/157) — **merged**, live at [docs.appmixer.com/getting-started/appmixer-mcp-server](https://docs.appmixer.com/getting-started/appmixer-mcp-server) | done |
| MCP Gateway tools, live | [appmixer-connectors#1117](https://github.com/Appmixer-ai/appmixer-connectors/pull/1117) — **merged 2026-09-21** into `dev`; the module runs on `api-dev-automated-00001.dev.appmixer.ai` | done — `test/e2e-gateway.mjs` passed live in CI on 2026-10-21 (run 39558808082) |
| claude.ai connector support | [`phase-3b-platform.md`](phase-3b-platform.md) | the platform team — hosting and the OAuth ticket flow are the only two gates; revocable tokens are debt, not a gate |

The platform items have the longest lead time. Filing them as tickets now
means they can run in parallel with everything else.

### How a release is cut

Releases are cut locally and published by `release.yml`; the README's
"Releasing" section is the reference. In short: `npm run release`
(commit-and-tag-version) picks the bump from the conventional commits since
the last tag, bumps every file listed in `.versionrc.json`, writes the
changelog and tags; `git push --follow-tags origin main` then runs the
workflow, which builds, tests, publishes to npm through **trusted publishing
(OIDC, no npm token)** and attaches the `.mcpb` bundle to a GitHub release.
Never `npm publish` by hand.

2.0.0 went out that way on 2026-10-19: tag pushed by Vladimir Talas, npm
`latest` now 2.0.0 with SLSA provenance, and a 256,589-byte bundle on the
release — byte-identical in size to the local build.

One constraint worth remembering: we have `pull` access only on
`Appmixer-ai/appmixer-mcp` and are not among the npm package's owners
(martin, daviddurman, vladimir.talas, martinkrcmar), so we cannot cut a
release ourselves. Someone with push does it, which is a one-command job but
needs asking.

### Where the module is deployed

`appmixer.ai.mcptools.MCPGateway` is in the component catalogue of
**`api-dev-automated-00001.dev.appmixer.ai`** — the instance the local
`appmixer` CLI is aliased to, and the one #1117 ran its E2E on. Its plugin
routes answer 401 there (registered, auth required) while a bogus route under
the same prefix answers 404.

Our own test tenant does not have it: on
`api.your-saas.appmixer.cloud` the same routes answer 404, and that is the
tenant whose credentials CI holds today.

**Decision (2026-10-14): CI moves to the dev instance.** We are not going to
wait for the module to reach `your-saas`. This needs no change to
`ci.yml` — the workflow names no tenant, it reads `APPMIXER_BASE_URL`,
`APPMIXER_USERNAME` and `APPMIXER_PASSWORD` from the repository secrets, so
repointing is three secret values plus a user on the dev instance.

The four existing live suites travel well: they reference only
`appmixer.utils.*` core components (app events, controls, filters, HTTP
trigger — all verified present on the dev instance), bind no third-party
account and hardcode nothing about `your-saas`. Two things to keep in mind
when the switch happens:

- The `your-saas` user was deliberately non-admin, so the token's reach was
  limited by ACL. Whoever creates the CI user on the dev instance should keep
  that property instead of reusing an admin account.
- `dev-automated-00001` is a shared dev-automation instance — connector CI
  also runs there and it can be reset. If the live suites start failing for
  reasons that are not ours, that is the first thing to check.

### What #1117 changed for us

The merged module is not the one `docs/mcptools-endpoints.md` was written
against, so the findings there need re-checking against the final code:

- Findings 2, 5 and 6 are gone: tool discovery awaits an `httpRequest`,
  the flow-state polling (and with it the timeout returned as HTTP 200) was
  replaced by a direct component call whose output is the response,
  `receive()` answers 400 on malformed input and 404 on an unknown tool, and
  `stop()` deletes through the plugin route, which removes matching set
  members one by one.
- Findings 3 and 4 stand: the SSE endpoint still takes the JWT as a `token`
  query parameter and verifies it by hand against the secret in the database
  (only the fan-out moved from raw Redis to `context.pubSub*`).
  `src/tools/gateway.ts` still sends the token in the query string for that
  reason.
- Tool names changed: the gateway publishes `type`, `name`, `description`,
  `parameters` only, shortens UUID component ids so names fit 64 characters,
  and suffixes colliding names with a stable 8-character hash. Our
  fingerprint reconciliation should cope, but it has only been unit-tested.
- The `out` port now announces `{ webhook, componentId, flowId, tools }` once
  per flow start; the authoring guide does not mention it yet.

## Picking it back up

1. **MCPB directory submission.** The customer documentation is live
   (docs#157 merged), so every criterion in
   [`gaps-and-roadmap.md`](gaps-and-roadmap.md) is met except test
   credentials for the reviewer. That route to claude.ai waits on nothing in
   core.
2. **Bring `docs/mcptools-endpoints.md` in line with the merged code.** The
   gateway lifecycle suite (`test/e2e-gateway.mjs`) now passes live against
   `api-dev-automated-00001.dev.appmixer.ai`. Its first run found that
   `appmixer.utils.controls.MockValue` is a private component, so the
   gateway silently drops it for users without the `private` scope; the
   suite now picks a visible component, and the module bug is drafted but
   not filed.
3. **Then let usage steer.** The most useful input so far came from actually
   using the thing — a hand-written "order triage" brief exposed three gaps
   in one afternoon that no amount of desk review had found. Once the team
   is using it, their transcripts beat any list we could write today.
4. **Only then the backlog**, which is in
   [`gaps-and-roadmap.md`](gaps-and-roadmap.md): three API gaps remain
   (files, telemetry, third-party account connection), plus the P2 protocol
   items (structured output, progress notifications, prompts, logging
   notifications) and the P3 hosting-scale work that belongs with phase 3b.

## Things worth remembering

- **`src/guide.ts` and `src/version.ts` are generated.** Edit
  `docs/flow-authoring-guide.md` and `package.json` instead, then
  `npm run gen:guide` / `npm run build`.
- **Run the evals after touching the guide, tool descriptions or output
  formats.** They are the only regression test for the parts unit tests
  cannot see, and they cost real tokens, so they are not in CI.
- **Probe the API before trusting a field name.** Three separate times a
  reasonable-looking assumption was wrong: unprocessed messages use `err`
  and `messages`, a store record's value *is* the request body, and clone
  answers with `cloneId`. Each was caught by calling the tenant, not by
  reading code.
- **The test tenant** is `test_mcp@appmixer.ai` on
  `api.your-saas.appmixer.cloud`, a deliberately non-admin user with one
  connected Slack account, and CI holds the same credentials as secrets —
  but both are on their way out: per the decision above, CI moves to
  `api-dev-automated-00001.dev.appmixer.ai`, which is the only instance with
  the mcptools module. The local `appmixer` CLI already points there.
