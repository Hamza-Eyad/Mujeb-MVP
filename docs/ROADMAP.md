# مُجيب — Engineering Roadmap

The roadmap separates what should be architecturally possible from what should be implemented now.

## Phase 0 — Foundation and local voice loop — IMPLEMENTED (2026-10-08)

Status: all deliverables are implemented and tested, and live providers work end to end (see `plans/2026-10-07-phase-0-architecture-proposal.md` §8). Still open: the manual echo matrix in `docs/MANUAL_VOICE_TESTS.md` needs human runs on real devices.

Goal: prove the core conversational pipeline locally with production-minded boundaries.

Deliverables:
- repository/toolchain foundation,
- configuration and `.env.example`,
- STT adapter,
- OpenAI LLM/orchestration adapter,
- TTS adapter,
- microphone input and speaker output through a local browser test client (dev-only transport, no keys or logic in the browser),
- streaming/cancellation lifecycle,
- barge-in with false-interruption handling, tested automatically and with the manual matrix in `docs/MANUAL_VOICE_TESTS.md`,
- session/turn IDs,
- structured logs,
- latency instrumentation,
- minimal tests with fake providers,
- documented local run command.

Do not add phone/SIP/database/admin UI just to look more complete.

### Phase 0 exit criteria
- One local session can hold a short Arabic conversation reliably.
- Important latency stages are measurable.
- Provider keys/models can change through configuration.
- Provider adapters can be replaced without rewriting orchestration.
- Errors/cancellation do not leave the process in a corrupted state.
- Tests can run without paid API calls by default.

## Phase 1 — Agent behavior and appointment tools on a sandbox HIS — IMPLEMENTED (2026-10-18)

Status:
- All plan steps (0–9) are implemented and tested, including the Medplum replaceability checks. Plan step 9 showed that the same agent scenarios pass on the in-memory system and on Medplum, selected by configuration only.
- Manual microphone calls on 2026-10-18 booked an appointment for an existing patient and registered a new patient, both end to end on Medplum. The fixes from those calls are in the plan.
- The next phase is Phase 4, by owner decision on 2026-10-25 (see Phase 4 below).

Known quality items, not blocking:
- STT misreads runs of identical digits.
- Spoken dates of birth are converted by the model, and callers do not always catch a wrong read-back.
- Hijri dates of birth are not supported (Gregorian only, by owner decision).
- STT commit and barge-in latency.
- A leftover manual "Dental Consultation" service in the Medplum sandbox.

Goal: prove that Mujeeb can move beyond conversation into controlled actions.

Plan: `plans/2026-10-12-his-scheduling-integration.md`. Decisions: `docs/DECISIONS.md` A14–A18.

Deliverables:
- provider-independent `SchedulingSystem` port (Adapter Pattern),
- in-memory scheduling adapter for tests and local development,
- Medplum adapter as a **temporary sandbox only**, with a reusable seed script for a small synthetic dataset,
- strict tool schemas: directory search, availability, patient lookup and registration, and booking, rescheduling, and cancellation through proposals,
- server-side pending-action confirmation for every write,
- execution-time availability validation, no automatic write retries, tracking and reconciliation of in-flight writes,
- development-only patient verification policy,
- tool-calling support in the LLM port and the OpenAI adapter (`store=false` state replay),
- tool events and latency in the local voice test client and turn metrics,
- contract tests shared by all scheduling adapters, plus evaluation scenarios.

Still no production hospital system and no real patient data. The first real hospital adapter belongs to Phase 3.

## Phase 2 — Core backend and tenant foundations

Goal: introduce persistence only when needed by real workflows.

Potential deliverables:
- tenant configuration model,
- credentials references/secret integration,
- agent configuration,
- knowledge configuration,
- audit events,
- session metadata,
- database migrations,
- tenant-aware repository/data layer.

## Phase 3 — First real healthcare integration

Goal: connect one approved scheduling/HIS/EHR integration end to end.

Deliverables:
- hospital adapter contract (evolves from the Phase 1 `SchedulingSystem` port),
- first real adapter,
- idempotent appointment writes,
- patient verification policy appropriate to the operation,
- failure/rollback semantics,
- audit trail.

## Phase 4 — Telephony and cloud pilot — IN PROGRESS (started 2026-10-25)

**Order:** Phase 4 comes before Phases 2 and 3 by owner decision (2026-10-25), scoped to a proof of concept. From Phase 2 it takes only the routing of a dialed number to an agent profile. Before a second hospital, Phase 2 is needed. Before the first real hospital, Phase 3 is needed.

**Gateway:** Asterisk 22 + `chan_websocket` (`docs/DECISIONS.md` A19). Background: `plans/2026-10-21-exacall-integration-report.md` and `plans/2026-10-22-telephony-review-brief.md`.

**Step 1 — connect a call to Mujeeb in the local lab: IMPLEMENTED (2026-10-25)**
- Plan: `plans/2026-10-25-phase-4-call-connection.md`.
- Delivered:
  - `AsteriskWsTransport`,
  - the telephony gateway (`npm run telephony`),
  - routing by dialed number,
  - session creation shared with the browser,
  - automated tests against a fake Asterisk,
  - a reproducible lab (`deploy/asterisk/lab/`).
- Verified 2026-10-25: a MicroSIP softphone called Asterisk in WSL, which connected to Mujeeb with live providers, and the call booked a sandbox appointment end to end.
- This is a **local lab, not a commercial connection**. There is no carrier line, real number, or cloud server yet.

**Step 2, still in the lab — IN PROGRESS (started 2026-10-28)**
- Plan and results: `plans/2026-10-28-phase-4-step-2-lab.md`.
- Done:
  - turn metrics per channel (phone/browser) with the call ID,
  - flush confirmation matched to its own `GET_STATUS`,
  - a fix for replies left silent after a paused interruption (seen in a 2026-10-25 call),
  - the apology the caller hears when Mujeeb is unavailable or fails,
  - a second synthetic clinic (301) with isolation tests,
  - acceptance tests with fake providers,
  - one real-provider call from MicroSIP (2026-10-28, 59 s, with an automatic stop). Real concurrent calls are deferred by owner decision, to save credits.
- Decided 2026-10-28:
  - the normal-end rule (A19): hang up the caller's channel through `CallControl`, not built yet,
  - the event-loop criterion: an increase over the idle baseline of at most 10 ms.
- Done 2026-10-29 (approved 2026-10-28):
  - Mujeeb answers only after STT is connected. There are at most two attempts of 3 s each, a stalled attempt is aborted and its socket closed, and the 7 s limit stays below the 10 s `Dial` timeout. A call that cannot connect is turned away unanswered and hears the apology. Lab: 6.4 s of ringing, then the apology.
  - The lab's Asterisk config files that hold secrets are root-only (`600`).
  - CI runs `npm run check` on Node 24 for every pull request.
- Open quality issue: detecting an interruption on the phone takes 1.6–5.8 s (p50 3.5 s, n=4). This is separate from stopping the audio, which takes under 3 ms. Not solved.
- Still waiting: the transcript diagnosis of the confirmation and national-ID issues. Transcripts stay off.
- Last, and not blocking the carrier line: call control separate from audio, plus the ARI transfer spike.

**Next steps (not started):**
- **Then a real line:**
  - Oracle VM in a Saudi region with a reserved IP,
  - the carrier trunk (ExaCall is a candidate),
  - NAT settings tested on real SDP/RTP,
  - production Asterisk templates in `deploy/asterisk/`,
  - the first call from a mobile phone,
  - a forwarded call,
  - measuring the delay between the last mark and the caller's ear.
- **Open owner decisions:**
  - warm transfer in the first commercial version,
  - data residency: storage only, or processing too (D4).

Goal: replace laptop audio with real inbound call media.

Deliverables may include:
- telephony/SIP adapter,
- inbound call session gateway,
- cloud deployment,
- secure secrets/configuration,
- live latency monitoring,
- concurrency tests,
- pilot number/routing,
- deployment/runbook.

## Phase 5 — Human handoff and confirmations

Potential deliverables:
- call transfer/escalation policy,
- staff routing,
- handoff context/summary,
- WhatsApp confirmation workflow,
- optional SMS fallback.

## Phase 6 — Multi-tenant operations and admin

Potential deliverables:
- tenant admin/configuration UI,
- knowledge management,
- per-tenant voice/prompt settings,
- integration management,
- call/task analytics,
- cost reporting,
- operational permissions.

## Phase 7 — Production hardening and scale

Potential deliverables:
- full Saudi benchmark suite,
- load/concurrency tests,
- horizontal scaling,
- rate-limit/backpressure strategy,
- security review,
- privacy/data retention controls,
- disaster recovery,
- SLA monitoring,
- provider fallback only where justified by measured needs.

## Roadmap rule

Do not pull a later-phase feature into an earlier phase unless it is required to validate the current phase or explicitly requested by the project owner.
