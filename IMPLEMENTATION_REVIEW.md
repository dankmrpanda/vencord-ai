# Phased Implementation Review

This implementation is split into five stacked phase branches. Review and merge them in order so each later branch retains its declared base.

## Baseline and bloat accounting

- Starting `llm/` + `discord/` production lines: **2,724**.
- Phase 1–3 attributed core: **2,860** lines, **+136 / +4.99%**.
- Phase 4 core bundle: **205** lines; total Phase 4 production attribution, including launch state/UI/types/declarations, is **328** lines.
- Current `llm/` + `discord/` total: **3,065** lines.
- Largest new production file: `llm/toolRegistry.ts` at **190** lines; every new production file is below 300 lines.
- Remaining touched hotspots: `components/SidebarPanel.tsx` (1,013), `index.tsx` (647), `discord/search.ts` (562), and `discord/messages.ts` (420).

## Phase 1 — Correctness, privacy, tests

- Permission discovery/check failures now fail closed, and guild candidates are post-filtered against the allowed channel IDs.
- Cache keys include guild-wide mode and all search behavior fields.
- Malformed/unknown arguments throw typed validation errors.
- The built-in safety prompt is always retained; custom instructions are appended. Discord content is marked untrusted.
- DMs remain active-DM-only unless the prompt names a mutual group channel or a validated contextual launch targets it.
- One throwing test runner covers malformed arguments, budgets, injection, scope, and empty results.
- Risk: Discord internal store shapes can change. Mitigation: safe discovery, fail-closed behavior, and fixed fixtures.
- Self-review decision: **approved** after the explicit mutual-group-DM enforcement fix; automated privacy fixtures pass.

## Phase 2 — Lean agent/provider core

- One registry owns schemas, parsing, availability, timeout, read-only classification, and execution.
- One transport handles all presets, conservative capabilities, fragmented SSE calls, strict-schema normalization, and developer-message fallback.
- Shared budgets cap six model turns, twelve tool calls, 90 seconds, 200 records, 32k estimated input tokens, and one finalization call.
- Duplicate normalized calls are rejected; tool reads settle concurrently while search starts are serialized.
- Deleted duplication: the 584-line agent switch and 233-line provider implementation were replaced by smaller focused modules.
- Risk: third-party OpenAI-compatible servers vary. Mitigation: conservative unknown preset plus seven offline contract fixtures.
- Self-review decision: **approved**; compatibility and fragmented transcript fixtures pass.

## Phase 3 — Search/context quality

- Search now normalizes, runs at most three variants, combines candidates, scope-filters, deduplicates, reranks, and returns structured cursors.
- Result limit defaults from settings and caps at 50; scan depth defaults to 100 and caps at 500.
- Local date-only values use local midnight, including DST; timestamps remain ISO.
- Pinned/mention filters and local/server cursors are exposed.
- Deleted duplication: the old first-positive relaxed-search path and duplicate prose message-formatting path.
- Fixtures cover cache separation, combined ranking, >100-message regex pagination, DST, empty results, and citation scope.
- Self-review decision: **approved**; relevance, cursor, and citation-scope fixtures pass.

## Phase 4 — Discord context core

- Added exactly three read-only tools: `get_message_details`, `list_channel_pins`, and `list_threads`.
- Added native Vencord message and thread/channel menu entries. Launch targets are scope-checked, prefilled without submission, passed ephemerally to the next run, and cleared on submission/channel change/stop.
- Discord pin pagination follows the current `messages/pins` response and keeps the deprecated GET fallback read-only.
- Risk: Discord/Vencord internal APIs may drift. Mitigation: native context-menu registration, guarded fields, fallback pin read, and successful Vencord build.
- Self-review decision: **approved for smoke testing**; compile/lifecycle checks pass and interactive Discord results remain pending.

## Phase 5 — Hardening and release

- Diagnostics log only provider capability flags, counts, durations, retries, truncation counts, and stopping reason.
- Provider errors no longer include response bodies; image inspection is Discord-CDN-only and capped at 10 MB.
- `npm test`, `npm run typecheck`, `npm run build`, and the full Vencord build pass.
- Live local/cloud smoke tests were not run because no endpoint/key was provisioned; offline contracts are mandatory and pass.
- Manual read-only scan finds no Discord `POST`, `PUT`, `PATCH`, or `DELETE`; the only production POST is the configured LLM completion transport.
- Release status: self-review **approved**; configured local/cloud provider and interactive Discord smoke results remain for the user to supply.
