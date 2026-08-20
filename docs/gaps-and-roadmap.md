# Honest assessment and roadmap

> As of 2026-08-20, against the MCP specification (2025-11-25), the Anthropic
> directory review criteria, and common expectations for a production server.
> This is a self-audit: it names what is genuinely good, what is missing, and
> what we decided not to build. Platform-side blockers live in
> [`phase-3b-platform.md`](phase-3b-platform.md) and are not repeated here.

## Verdict in one paragraph

The server is a genuinely solid MCP citizen where it counts: tool design,
annotations, error quality, output discipline, auth handling and test coverage
are at or above what the directory review demands, and the eval harness is
something most published servers do not have at all. What separates it from a
finished product is the **outer ring**: release engineering, a handful of
protocol features we consciously skipped (structured output, progress,
prompts), and hardening for hostile traffic on the HTTP transport. The P1
section below closes the first and third of those; none of it was
architectural — the core did not have to change.

## Scorecard

| Area | State | Notes |
|---|---|---|
| Tool design & annotations | **strong** | 23 tools, one per action, read/write split, `title` + `readOnlyHint`/`destructiveHint` everywhere, names ≤ 64 enforced |
| Error quality | **strong** | `ApiError` with status/method/url, actionable `isError` results, targeted hints (invalid variable → `get_flow_variables`) |
| Output discipline | **strong** | pagination, projections, per-result caps, summary/detail modes |
| Flow authoring | **strong** | guide (tool + resource), server-side validate loop, variables with leaf paths, dry-run, dynamic options, account binding, placeholder IDs |
| Testing | **strong** | 64 unit tests, 4 live suites in CI, 14 eval tasks measured on two models (14/14 both) |
| Transports | **good** | stdio + streamable HTTP (sessions, env/bearer, Origin allowlist) + MCPB bundle; no SSE resumability, in-memory sessions only |
| Protocol feature coverage | **fair** | tools + one resource + cancellation; no structured output, progress, prompts, logging notifications, elicitation |
| HTTP hardening | **good** | token verified before session, per-session binding, 4 MB cap, session cap, per-client rate limit, rejected-token cache |
| Release engineering | **good** | tagged release workflow (npm provenance + GitHub release with the bundle), CHANGELOG; bundle not signed yet, nothing published yet |
| Open-source hygiene | **missing → fixed** | SECURITY.md and CONTRIBUTING.md added together with this document |

## Gaps and proposals

### P1 — before the first public release — **done** (2026-08-20)

Items 1–4 below are implemented on `feat/v2-production-hardening`: release
workflow with tag/version check and npm provenance, generated version
constant, session cap plus per-client rate limiting and a rejected-token
cache, and cancellation threaded from the MCP layer to the HTTP client via a
request-scoped store. What remains open is signing the bundle (needs a
code-signing certificate) and the actual npm release.

1. **Release automation.** Nothing ships today: v2 is not on npm and the
   `.mcpb` exists only as a local build. Proposal: a `release.yml` workflow —
   on a version tag run build + tests, `npm publish --provenance`, build and
   `mcpb sign` the bundle, attach it to a GitHub release. Also bump
   `actions/checkout` and `actions/setup-node` to v5 (Node 20 runner
   deprecation warning). Effort: small.
2. **Single source of the version.** `src/server.ts` hardcodes
   `VERSION = '2.0.0'` next to `package.json`'s `version`; they will drift on
   the first patch release. Proposal: generate the constant in the build
   (same pattern as `gen:guide`) or read it in the release workflow and fail
   on mismatch. Effort: trivial.
3. **HTTP DoS hardening.** The sessions map is unbounded and nothing rate
   limits `/mcp`. Bearer-mode initialize also costs one upstream `GET /user`
   per attempt, so an attacker can make the server relay traffic at the
   tenant 1:1. Proposal: a `MAX_SESSIONS` cap (429 above it), a simple
   per-IP rate limit on initialize, and a short-TTL negative cache for
   rejected tokens. Effort: small.
4. **Request cancellation.** Tool handlers ignore the SDK's `extra.signal`.
   When a client cancels — most visible on `test_flow`, which can run for
   two minutes — the server keeps streaming and keeps the upstream call
   alive. Proposal: thread `extra.signal` through `safeHandler` into
   `AppmixerClient` (its methods already use `AbortController` internally).
   Effort: small-medium.

### P2 — protocol depth (quality, not correctness)

5. **Structured output.** Read tools return JSON serialized into a text
   block. The SDK supports `outputSchema` + `structuredContent`, which lets
   clients consume results without re-parsing prose and is where directory
   expectations are heading. Proposal: add output schemas to the read tools
   with stable shapes (`list_flows`, `get_flow_variables`, `validate_flow`,
   `get_component_options`), keeping the text block as a mirror. Effort:
   medium.
6. **Progress notifications.** `test_flow` streams component events
   internally but reports nothing until it finishes. The SDK exposes
   progress via `extra.sendNotification`; mapping `component:start/output`
   events to progress updates makes a 30–120 s call feel alive. Effort:
   small.
7. **MCP prompts.** Zero prompts today. Two canned workflows would package
   our own know-how: `build-flow` (brief → the authoring loop) and
   `diagnose-flow` (logs → descriptor → fix). Directory guidance explicitly
   encourages shipping these. Effort: small.
8. **Logging notifications.** v1 declared the `logging` capability; v2
   dropped it and logs to stderr only, so remote clients never see gateway
   reconnects or degradation notices. Proposal: re-declare `logging` and
   send `notifications/message` for gateway lifecycle events. Effort: small.
9. **Elicitation.** When `assign_account` finds several accounts for one
   service, the agent guesses. Spec-native elicitation ("which account?")
   fits exactly, gated on `clientCapabilities.elicitation` with the current
   behaviour as fallback. Host support is still rolling out, hence P2.
   Effort: small-medium.

### P3 — operations at official-hosting scale

10. **Session durability and horizontal scale.** Sessions are in-memory: a
    restart drops every client, and multiple replicas would need sticky
    routing. Fine for self-hosting; not for the per-tenant hosting planned
    in phase 3b. Proposal: SDK `EventStore` for SSE resumability plus a
    Redis-backed session map, delivered together with the hosting work.
    Effort: medium.
11. **Structured logs and metrics.** Logs are prefixed stderr lines; there
    are no counters (sessions, tool calls, upstream latency). Enough for
    npx, thin for a hosted service. Proposal: optional JSON log mode and a
    `/metrics` endpoint, again scoped to the hosting milestone. Effort:
    medium.
12. **Dependency automation.** No Dependabot/audit gate; the MCP SDK moves
    quickly. Proposal: Dependabot config for npm + actions with weekly
    cadence. Effort: trivial.

### Known and accepted

- **Gateway tools have no live test** until `appmixer.ai.mcptools` merges
  (connectors #1117); unit tests cover the manager. Tracked in phase 3b.
- **The eval runner under-reports cost on a task timeout**: the `result`
  event never arrives, so the missing cost counts as zero. Every run so far
  completed, which makes this a note-level fix rather than a priority.
- **`.mcpb` shasums differ between identical builds** (zip timestamps); we
  chose not to chase reproducible archives.
- **claude.ai connectors cannot connect** until the OAuth bridge exists —
  the top item of phase 3b, not solvable in this repository.

## Directory readiness

| Criterion | Status |
|---|---|
| Read/write tool split, no catch-all method tool | ✅ |
| `title` + `readOnlyHint`/`destructiveHint` on every tool | ✅ |
| Tool names ≤ 64 characters | ✅ (enforced, including dynamic gateway tools) |
| Narrow, accurate descriptions; no prompt-injection patterns | ✅ |
| Actionable errors, validated inputs | ✅ |
| Reasonably sized responses | ✅ |
| First-party API ownership | ✅ (Appmixer's own API) |
| Public documentation | ⏳ docs PR #157, merges after the npm release |
| Test credentials for review | ⏳ to be prepared at submission |
| MCPB open source | ✅ MIT |
| Remote connector auth (OAuth) | ❌ blocked on phase 3b |

Practical consequence: an **MCPB directory listing is reachable now** (after
the npm release and docs merge); the **remote connector listing waits for
OAuth**.

## Suggested order

1. P1.1–P1.2 (release automation, version) — prerequisites for shipping v2.
2. P1.3–P1.4 (hardening, cancellation) — cheap and de-risk public exposure.
3. P2.7 and P2.8 (prompts, logging) — small wins, ship with the release.
4. P2.5–P2.6 (structured output, progress) — next minor version.
5. P2.9, P3.* — with elicitation host support and the phase-3b hosting work
   respectively.
