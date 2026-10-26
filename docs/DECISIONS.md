# مُجيب — Technical Decision Log

This file distinguishes **current decisions** from **future candidates** and **open questions**. Claude must not treat old research options as current implementation requirements.

## A. Current decisions

### A1. Current phase
**Original decision (2026-10-07):** Build a local real-time Voice Agent MVP first:
`Microphone -> STT -> LLM/Orchestrator -> TTS -> Speaker`.

**Status (2026-10-26):**
- Phase 0 (local voice loop) and Phase 1 (appointment tools on a sandbox HIS) are implemented.
- The current phase is **Phase 4, step 1** (owner decision, 2026-10-25). It connects calls to the same engine through Asterisk (A19) in a **local lab only**:
  `MicroSIP softphone -> Asterisk (WSL) -> chan_websocket -> Mujeeb`.
- There is no carrier line, no real phone number, and no cloud server yet.
- From Phase 2, Phase 4 takes only the routing of a dialed number to an agent profile.

### A2. MVP architecture style
**Decision:** Use a modular pipeline for the first implementation.

Reason: it gives us measurable boundaries for STT, LLM, TTS, orchestration, latency, and error handling.

### A3. Provider coupling
**Decision:** All third-party services must sit behind minimal project-owned adapters/interfaces.

Reason: vendor/model choices may change after benchmarking.

### A4. Current provider direction
**Decision:** OpenAI is the LLM provider for the current MVP. ElevenLabs is the current intended STT/TTS provider direction.

**Constraint:** exact model IDs must be configurable and must not be embedded throughout domain code.

### A5. OpenAI integration direction
**Decision:** For new text/tool integrations, use the current OpenAI Responses API patterns; do not build new code around the retired Assistants API.

### A6. Architecture scale
**Decision:** Start as a modular monolith.

Reason: the project needs clear boundaries, not distributed-system complexity before traffic exists.

### A7. Observability
**Decision:** Latency/error instrumentation is part of the MVP definition of done.

### A8. SaaS future
**Decision:** The system is ultimately multi-tenant, so core concepts must not assume one clinic forever.

**Constraint:** do not implement a full tenant database/admin platform during the local MVP unless explicitly requested.

### A9. Healthcare safety scope
**Decision:** Mujeeb is initially an administrative/operational healthcare assistant, not an unrestricted medical diagnosis agent.

### A10. Runtime language — 2026-10-08
**Decision:** TypeScript (strict) on Node.js 24 LTS for everything that runs at runtime: voice engine, backend, and the future dashboard. Python is **not** part of the runtime.

Python is allowed only for:
- offline tooling (evaluation/data analysis) that the runtime never imports;
- an isolated inference service behind an existing port/adapter, if a measured need appears (e.g. a self-hosted STT model in Saudi Arabia for data residency).

Reason: Mujeeb's own code is streaming I/O + SaaS logic; STT/LLM/TTS run at providers. One language gives shared contracts from engine to dashboard for a single developer. Full comparison: `plans/2026-10-08-language-decision-report.md`.

### A11. Local audio through a browser test client
**Decision:** Phase 0 captures/plays laptop audio in a local browser page that streams PCM frames over a localhost WebSocket to the engine.

Constraints:
- The browser client is a thin audio transport + display. It holds **no API keys and no conversation logic**.
- The engine sees it through the same `AudioTransport` port that telephony will use later (Phase 4).
- Browser echo cancellation is **not assumed** to work: it is measured (see `docs/MANUAL_VOICE_TESTS.md`) and the engine has its own echo/false-interruption handling plus a half-duplex fallback.

### A12. Phase 0 privacy defaults
**Decision:**
- No real patient data in Phase 0 — not in tests, demos, recordings, or prompts.
- OpenAI requests use `store=false`; Mujeeb keeps conversation history itself.
- ElevenLabs Zero Retention Mode (`enable_logging=false`) is **Enterprise-only** per ElevenLabs docs. It is a config flag (`MUJEEB_ELEVENLABS_ZERO_RETENTION`, default `false`). Whether the account actually gets it is verified with `npm run probe:elevenlabs`, not assumed.
- Transcripts are not written to logs by default (`MUJEEB_LOG_TRANSCRIPTS=false`).

**Verified 2026-10-08 (Starter plan):** the realtime STT server accepts `enable_logging=false` without error but reports `disable_logging: false` — zero retention is **not** applied. The engine logs `stt.config_mismatch` when this happens. Note: the live `session_started.config` uses `vad_commit_strategy` / `disable_logging`, not the documented `commit_strategy` / `enable_logging`.

### A13. Turn commit strategy
**Decision:** Default STT commit strategy is `vad`. `turn_prediction` is opt-in only.

Reason: the ElevenLabs API reference says `turn_prediction` works "only for models that predict turns", and its documented session config for `scribe_v2_realtime` lists only `manual`/`vad`. We enable `turn_prediction` only after `npm run probe:elevenlabs` shows the server accepted it for the configured model.

**Verified 2026-10-08 against the live API:** the server rejects it — `commit_strategy 'turn_prediction' is not supported by model_id 'scribe_v2_realtime'`. Re-check when ElevenLabs ships a new realtime model.

### A14. Scheduling/HIS integration through a project-owned port — 2026-10-12
**Decision:** Scheduling systems (HIS/EHR/scheduling APIs) are reached only through a project-owned `SchedulingSystem` port (`src/ports/scheduling.ts`), using the Adapter Pattern. Each system gets its own adapter under `src/adapters/<system>/`. The agent tools and business logic depend only on the port. The composition root selects the adapter from configuration (`MUJEEB_SCHEDULING_PROVIDER`).

First implementations:
- an in-memory adapter, used for tests and local development;
- a Medplum adapter, used only as a sandbox (A15).

Constraints:
- No HIS IDs, FHIR types, or vendor names outside the adapter folders. The architecture test enforces this.
- The port is minimal and driven by current use cases: directory search, availability, patient lookup and registration, and appointment listing, booking, rescheduling, and cancellation.
- No test patient, practitioner, service, or appointment IDs are hardcoded in agent logic, prompts, or profiles.

Plan: `plans/2026-10-12-his-scheduling-integration.md`.

### A15. Medplum is a temporary sandbox, not a foundation — 2026-10-12
**Decision:** Medplum (project `Mujeb-MVP`) is a temporary test environment for realistic scheduling behaviour. It is not a permanent dependency, an architectural foundation, or a selected production HIS.

Constraints:
- No `@medplum/core` SDK. The adapter uses the built-in `fetch` plus `zod` validation at the boundary.
- All Medplum knowledge stays inside `src/adapters/medplum/`. Removing that folder must only break the composition root and the CLI seed command.
- Medplum's scheduling operations (`$find`, `$book`, `$reschedule`, `$cancel`) are **Beta**. Their response shapes and error mapping are pinned with recorded fixtures and re-verified with live tests before they are relied on.
- The project holds synthetic data only (A17).

### A16. Agent tools and write safety — 2026-10-12
**Decision:** The agent acts only through narrow, provider-independent tools with strict schemas, bound to the trusted session and tenant context.

- **Session-scoped references:** The model sees only short session references (`S1`, `P1`, `A1`, …), never HIS IDs. It cannot act on an object the system did not return in the same session.
- **Dynamic discovery:** Services and practitioners are found through search tools backed by the HIS. Any caching happens server-side in the adapter, never by loading the whole directory into the LLM context.
- **Server-side confirmation for every write.** This covers registration, booking, rescheduling, and cancellation.
  - A `propose_*` tool creates a single-use, expiring pending action. It is bound to the exact operation, tenant, session, verified patient, and target.
  - Only `confirm_pending_action` executes it, and only if all of the following hold:
    - the confirmation comes in the caller's **next** turn, not the turn that made the proposal;
    - the caller's reply reads as a yes on both readings (updated 2026-10-13):
      - **Model reading:** the model passes its reading of the reply (`caller_answer`: yes/no/unclear). It reads a judgment only, never text.
      - **Word check:** a deterministic classifier reads the caller's own STT transcript. The words must either say yes, from a broad list of Saudi phrasings ("إيه", "ثبّته", "توكل على الله", …), or contain only words the list does not know. A hedge, a question, a time/day/doctor, another action, or a "no" in the words always vetoes the yes.
      - **A "no" read by the model** discards the action, because discarding writes nothing, unless the words clearly said yes.
      - **Why:** the strict word list alone rejected natural answers such as "ثبّت الحجز" in live calls.
    - the stored payload is executed unchanged.
- **The read-back is authoritative and must be heard (2026-10-13).** Dates and times the caller confirms are never worded by the language model.
  - The tools build the read-back deterministically from the stored action or record: Saudi Arabic in `Asia/Riyadh`, with an explicit صباحًا/ظهرًا/مساءً.
  - The agent turn speaks it verbatim and ends there. Write results ("تم الحجز …") are spoken the same way, from the record the scheduling system returned.
  - A yes counts only if the caller heard the whole read-back, with no other date or time in that turn. "Heard" means the TTS-aligned text up to the last playback mark the client acknowledged.
  - Otherwise, for example after a barge-in, the system reads the details again and asks again.
- **Ambiguous confirmations are safe.** Mixed or unclear replies (for example "yes, but…") never execute. The system asks for a new, explicit confirmation, either by re-arming the pending action for a bounded number of turns or by asking the model for a fresh proposal. A clear "no" discards the action.
- **Availability is validated at execution time.** A new booking or reschedule relies on the HIS's own atomic availability check when it executes (Medplum `$book`/`$reschedule`, or the equivalent in another adapter), not on data captured at proposal time. A conflict returns `slot_unavailable`, and the agent offers a new search. Version checks (`version`/ETag) are an extra guard for changes to *existing* appointments. They never replace the execution-time availability check.
- **No automatic retries for writes.** Reads may be retried once on transient errors.
- **In-flight writes are never abandoned.**
  - A caller interruption, a cancelled turn, or a session close does not abort a write that has already been sent to the HIS. The write runs to completion under its own timeout.
  - Every executed write is tracked per session as `in_flight`, `succeeded`, `failed`, or `unknown`.
  - Outcomes that time out or remain ambiguous are reconciled by reading the HIS.
  - While a write is `in_flight` or `unknown`, further writes for the same patient are blocked.
  - The final outcome is recorded in the conversation history and the audit log, and the caller is told honestly when the result cannot be confirmed.
- **Audit:** Every proposal, confirmation, execution, and reconciliation emits a structured audit log event without patient identifiers. Persistent audit storage remains a later-phase item.

### A17. Synthetic test data and development-only patient verification — 2026-10-12
**Decision:**
- Scheduling tests use synthetic data only. It comes from one provider-neutral dataset file (`config/test-data/`) that feeds both the in-memory adapter and the Medplum seed script.
  - National IDs use deliberately invalid checksums.
  - Seeded HIS resources are tagged as synthetic.
- Patient verification uses a national ID or phone number, plus date of birth. The policy name is `dev-identifier-dob`.
  - This is a **development-only policy, not production-grade authentication**.
  - It returns the same response for "not found" and "date of birth mismatch".
  - It allows at most 3 failed attempts per session.
  - It is named explicitly in the agent profile and logged at startup.
  - The production verification policy remains open (D2).

### A18. OpenAI tool-calling state with `store=false` — 2026-10-12
**Decision:** Mujeeb keeps owning the conversation (`store=false`, A12). For function calling with the Responses API, following the current OpenAI documentation (function-calling and reasoning guides, checked 2026-10-12):

- **Within the current user turn:** Every output item since the last user message is replayed **verbatim and in order**. This covers reasoning items with their `encrypted_content`, assistant messages with their original `phase`, and `function_call` items. A `function_call_output` follows for each `call_id`.
- **Opaque continuation:** The `LanguageModel` port carries these items as an opaque `continuation`, tagged with the provider and model. Domain code stores it but never inspects it.
- **Integrity:**
  - A `function_call` is never sent without its output.
  - An aborted model round is dropped entirely, together with its reasoning items.
  - History is trimmed only at turn boundaries.
- **Model change:** Reasoning items are replayed only to the same model. If the model changes, they are dropped and function calls are rebuilt from normalized data.
- **Earlier turns:** These are kept as compact Mujeeb-owned records: user text, tool call and output pairs, and the assistant text the caller actually heard. This matches the `current_turn` reasoning context, which is the default for the GPT-5.4/5.5 family currently used. Adopting a model whose default is `all_turns` requires revisiting this decision first.
- **Request settings:** `parallel_tool_calls=false`, and strict JSON schemas with every field required, `additionalProperties: false`, and optional values as `null`.
- **Verification:** Verified live on 2026-10-13 with `gpt-5.4-mini` (`tests/live/agent-tools.live.test.ts`, gated). The test covered:
  - multi-round tool calls in one turn with `store=false`;
  - replay of `message` items with `phase: commentary`, and of `reasoning` items with `encrypted_content` (reasoning effort `low`);
  - `phase: final_answer` on assistant history;
  - strict schemas.

### A19. Telephony gateway: Asterisk 22 + `chan_websocket` — 2026-10-25
**Decision:** Phone calls reach Mujeeb through **Asterisk 22 LTS**, using its WebSocket channel driver (`chan_websocket`).
- Asterisk terminates SIP/RTP.
- For each call, it opens **one WebSocket** to Mujeeb's telephony gateway on the same host.
- Mujeeb sees the call through the existing `AudioTransport` port, through one adapter: `AsteriskWsTransport`.
- `VoiceSession`, the agent tools, and the STT/LLM/TTS providers are unchanged.

**Background:** `plans/2026-10-21-telephony-gateway-research.md`, `plans/2026-10-21-exacall-integration-report.md`, and `plans/2026-10-22-telephony-review-brief.md`. The brief includes the external review (§12): conditional approval to build, with production not yet approved.

**Rejected alternatives:**

| Alternative | Why it was rejected |
|---|---|
| ARI External Media (RTP/AudioSocket) | The app owns packet timing, which means more code |
| FreeSWITCH + `mod_audio_stream` | External module, and some versions are commercial |
| SIP/RTP in Node | Every SIP edge case becomes ours |
| jambonz/LiveKit | Larger platforms than we need |
| Hosted voice-AI platforms | They replace the engine or move audio out of Saudi Arabia |

**Constraints:**
- **Boundary:**
  - Asterisk and `chan_websocket` knowledge stays in `src/adapters/telephony/asterisk/`.
  - Only `src/app/telephony-server.ts` imports it.
  - The architecture test enforces both rules.
- **Gateway access:**
  - The gateway binds to loopback only.
  - Asterisk authenticates with HTTP Basic (`websocket_client.conf` username/password), compared in constant time.
  - The shared secret is only in `.env` and the Asterisk host. It is never in the repository.
- **Call lifecycle:**
  - The dialplan dials with `n`, so Asterisk does not auto-answer.
  - Mujeeb sends `ANSWER` only after the call's session exists.
  - A call is refused before it is answered when the gateway is at capacity, the dialed key has no route, or `MEDIA_START` does not arrive in time.
- **Call metadata:**
  - The dialed number, caller, and call ID arrive as inherited channel variables in `MEDIA_START`, never in the WebSocket URL.
  - Caller numbers are masked in logs.
  - The caller number is **never** used as identity, because it can be spoofed.
- **Routing:**
  - One route key (DID or SIP address) maps to exactly one clinic profile (`config/telephony/routes.json`).
  - An unknown key is refused, never guessed.
  - The route source moves to tenant configuration in Phase 2, behind the same `CallRouter`.
- **Playback:**
  - Audio and marks share one ordered queue, which respects `MEDIA_XOFF`/`MEDIA_XON`.
  - Audio goes out in whole frames.
  - `playback_cleared` is reported only after Asterisk's `STATUS` confirms the flush.
  - `MEDIA_MARK_PROCESSED` means "played by Asterisk", not "reached the caller's ear". Whether an extra delay is needed is measured on real calls before it is decided.
- **Asterisk version:**
  - Pinned to 22.11.0, built from source with a pinned SHA-256 (`deploy/asterisk/lab/build-asterisk.sh`).
  - The JSON control format needs ≥ 22.8.
- **Recording and outbound calls:**
  - No call recording by default.
  - No outbound route in any dialplan.
- **Call transfer:** Transfer to staff (Phase 5) is expected through ARI. Call control stays separate from audio transport. A small lab spike, moving a live call from `Dial(WebSocket)` into `Stasis()`, is due before Phase 4 closes.

**Lab vs commercial:**
- The MicroSIP softphone, Asterisk in WSL2, and `deploy/asterisk/lab/` form a **local test bench on the developer laptop**. SIP is bound to 127.0.0.1, and the lab has no outbound route.
- It is **not a commercial connection**. No carrier line (ExaCall is a candidate, see C), real phone number, or cloud server is connected.
- Production Asterisk templates, NAT on the server, and the carrier trunk are later Phase 4 steps.
- The code is permanent. Moving from the lab to a carrier line changes configuration only.

## B. Future planned directions — not current implementation scope

- Live inbound calls on a real carrier line, and the production Asterisk/server setup. The gateway design itself is current (A19). Only the local lab exists today.
- Saudi/local carrier production route.
- Twilio or another provider for prototype/bridge work if useful.
- Oracle Cloud Saudi deployment direction.
- Per-tenant knowledge base.
- Database-backed tenancy/configuration.
- First **production** hospital scheduling integration (a real hospital adapter behind the A14 port), then more adapters. The sandbox Medplum adapter and the appointment tools are current scope (A14–A16).
- Human handoff.
- WhatsApp confirmations; SMS fallback where needed.
- Admin/operations dashboard.
- Persistent call/audit analytics subject to policy.
- Production-scale concurrency and horizontal scaling.

## C. Candidates / research options — do not assume they are selected

- Native speech-to-speech / realtime audio models as an alternative to the modular pipeline.
- Specific Saudi SIP/telecom carrier. ExaCall is under evaluation (`plans/2026-10-21-exacall-integration-report.md`) and is not selected yet.
- Exact long-term database/cache stack.
- Exact knowledge retrieval/vector technology.
- Exact production deployment topology.
- Exact OpenAI model.
- Exact voice/STT/TTS vendor after future benchmark rounds.
- NPHIES-related scope.
- On-premise deployment for particular enterprise customers.

## D. Questions to resolve later

1. Which production telephony provider/carrier best fits Saudi requirements, quality, and cost?
2. What patient verification level is needed for each operation? (A17 defines a development-only policy. It does not answer this question for production.)
3. What call recordings/transcripts are retained, for how long, and where?
4. Which data is allowed to leave Saudi Arabia for third-party processing?
5. What is the exact human-handoff policy and operational routing?
6. Which hospital scheduling/HIS/EHR integration becomes the first supported production adapter? (Medplum is a sandbox only, see A15. It is not an answer to this question.)
7. Which knowledge architecture best fits structured data + documents?
8. What SLA/concurrency target is required by the first pilot customer?
9. Which production model/vendor combination wins the Saudi evaluation suite?

## E. Rule for changing decisions

When a project decision changes:
1. update this file,
2. update `PROJECT_CONTEXT.md` only if the product context also changed,
3. update `CLAUDE.md` only if Claude needs the new fact in every session,
4. avoid leaving contradictory "old decision" instructions elsewhere in the repo.
