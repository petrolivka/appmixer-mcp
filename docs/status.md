# Where things stand

> Snapshot taken 2026-08-23, when development paused to wait for review,
> merge and the first release. Written so anyone (including us in a month)
> can pick the work up without rereading the whole history.

## The short version

v2 is feature-complete and verified, and it is waiting on people, not on
code. Everything lives on one branch behind one pull request that has not
been reviewed yet. Nothing is published, so no user can benefit from any of
it until that PR merges and v2 goes to npm.

## What exists

**Branch `feat/v2-core`** on the fork `petrolivka/appmixer-mcp`, 21 commits
ahead of the upstream `main` (which is still the v1 code), CI green on every
push including the live suites.

The server is a TypeScript rewrite on the current MCP SDK with **37 tools**
in three families — operating flows, authoring them, and the data around
them (stores, versions, modifiers, dead-letter queue) — plus dynamic tools
published by MCP Gateway components. It runs over **stdio**, over
**streamable HTTP** (sessions, `env`/`bearer` auth, Origin allowlist,
session cap, rate limiting), and ships as an **MCPB bundle** for Claude
Desktop.

Verification: 66 unit tests, four live suites against a test tenant in CI
(stdio and HTTP smoke, end-to-end authoring, golden descriptors), and 14 LLM
eval tasks scoring real agents — 14/14 on both Sonnet and Haiku.

## What is waiting, and on whom

| Item | Where | Waiting on |
|---|---|---|
| Code review and merge | [appmixer-mcp#5](https://github.com/Appmixer-ai/appmixer-mcp/pull/5) — open, 21 commits, 0 reviews | a reviewer |
| npm release of v2 | after the merge: `npm version <level>` and push the tag; `release.yml` does the rest | the merge |
| Customer documentation | [appmixer-docs-gitbook#157](https://github.com/Appmixer-ai/appmixer-docs-gitbook/pull/157) — draft, base `6.5` | the npm release (the page describes v2; today `npx appmixer-mcp` still installs 1.0.8) |
| MCP Gateway tools, live | [appmixer-connectors#1117](https://github.com/Appmixer-ai/appmixer-connectors/pull/1117) — still open | the connectors PR being fixed and merged |
| claude.ai connector support | [`phase-3b-platform.md`](phase-3b-platform.md) | the platform team (OAuth bridge, personal access tokens) |

The platform items have the longest lead time. Filing them as tickets now
means they can run in parallel with everything else.

## Picking it back up

1. **Release first.** Merge #5, tag a release, confirm the workflow published
   to npm and attached the `.mcpb` to the GitHub release, then take
   docs#157 out of draft and ask for review.
2. **Then let usage steer.** The most useful input so far came from actually
   using the thing — a hand-written "order triage" brief exposed three gaps
   in one afternoon that no amount of desk review had found. Once the team
   is using it, their transcripts beat any list we could write today.
3. **Only then the backlog**, which is in
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
  connected Slack account. CI holds the same credentials as secrets.
