# MUJEEB — Claude Code Project Instructions

## Project identity
- Product name: مُجيب (Mujeeb).
- Organization: أكيد نمو (Akeed Numo) during the current build phase; the product may later operate as an independent company/product.
- Domain: Voice AI SaaS for healthcare providers in Saudi Arabia.
- Primary language: Arabic, with a strong requirement for natural Saudi-dialect voice interactions.

## How to work in this repository
1. Treat `docs/PROJECT_CONTEXT.md` as the product/business source of truth.
2. Treat `docs/DECISIONS.md` as the current technical decision log. Newer decisions override older research notes.
3. Treat `docs/ROADMAP.md` as the scope boundary. Do not implement later-phase features unless the current task explicitly asks for them.
4. Use the project skills under `.claude/skills/` whenever relevant.
5. Before making a non-trivial change, inspect the affected code and state the intended change briefly.
6. Prefer small, reviewable changes. Do not redesign unrelated areas.
7. Never claim a task is complete without running the relevant verification/tests.

## Non-negotiable engineering principles
- The current MVP is small in scope, not throwaway code.
- Build for extension without prematurely building a large distributed system.
- Prefer a modular monolith first; split into services only when measured operational needs justify it.
- Keep Mujeeb-owned business logic independent from third-party providers.
- External providers must be accessed through adapters/interfaces so STT, TTS, LLM, telephony, messaging, hosting, or hospital integrations can be replaced later.
- Do not hardcode model names, provider credentials, tenant IDs, prompts, URLs, phone numbers, or environment-specific values.
- Secrets belong only in environment variables or an approved secret manager. Never commit keys.
- Use structured errors, explicit timeouts, cancellation, retries only where safe, and idempotency for side-effecting operations.
- Instrument latency and failures from the first working voice loop.
- Design future healthcare and multi-tenant boundaries now, but do not implement unused infrastructure just because it may be needed later.

## Current build scope
The local Voice Agent MVP (Phase 0) is implemented and runs on a developer laptop:

Microphone -> streaming STT -> Mujeeb orchestration/LLM -> streaming TTS -> speaker

Current phase (Phase 1): give the agent appointment tools on top of that loop. The tools run through a provider-independent `SchedulingSystem` port, backed by an in-memory adapter and a **Medplum sandbox** with synthetic data only. Plan: `plans/2026-10-12-his-scheduling-integration.md`. Decisions: `docs/DECISIONS.md` A14–A18.
- Medplum is temporary: no Medplum or FHIR knowledge outside `src/adapters/medplum/`, and no Medplum SDK.
- Every write needs server-side confirmation (`propose_*` → `confirm_pending_action`). Ambiguous replies never execute.
- New bookings are validated by the HIS at execution time. In-flight writes are never abandoned on interruption; uncertain outcomes are reconciled.
- Patient verification (`dev-identifier-dob`) is development-only, not production authentication.

Current MVP goals:
- Arabic/Saudi speech recognition quality.
- Correct conversational understanding.
- Low perceived latency.
- Natural response audio.
- Interruption/cancellation behavior where supported.
- Reliable logs and latency measurements.
- A clean provider abstraction that can later receive telephone audio instead of microphone audio.

Current MVP exclusions unless explicitly requested:
- SIP/phone numbers/production telephony.
- Oracle Cloud deployment.
- Database-backed multi-tenancy.
- Integration with a real hospital's HIS/EHR (the Medplum sandbox above is the only HIS in scope).
- Real appointment booking for real patients (synthetic sandbox bookings only).
- WhatsApp/SMS confirmations.
- Human handoff implementation.
- Production admin dashboard.

## Current provider direction
- STT/TTS: ElevenLabs is the current intended audio provider for the local MVP.
- LLM: OpenAI is the current intended LLM provider.
- Keep concrete model IDs configurable through environment/config; do not hardcode them into domain logic.
- For new OpenAI text/tool integrations, prefer the current Responses API rather than the retired Assistants API.

## Current stack
- TypeScript (strict) on Node.js 24 LTS for all runtime code (see `docs/DECISIONS.md` A10). Python is not part of the runtime.
- Phase 0 design: `plans/2026-10-07-phase-0-architecture-proposal.md` (v2).
- Phase 1 plan: `plans/2026-10-12-his-scheduling-integration.md`.
- Verify with `npm run check` (typecheck + lint + tests, no paid API calls).

## Product safety boundary
Mujeeb is an operational healthcare assistant, not an open-ended medical diagnosis system.
- Answer clinic/hospital FAQs from approved tenant knowledge.
- Perform explicitly authorized administrative workflows, and execute writes only after server-side confirmation by the caller.
- Do not invent medical facts, availability, prices, policies, doctor information, or appointment status.
- High-risk medical content must be handled by an approved policy/escalation path in later phases.

## Code quality expectations
- Clear module boundaries and dependency direction.
- Types/schemas at provider and tool boundaries.
- Unit tests for deterministic business logic.
- Integration tests for provider adapters where practical.
- Mock/fake providers for tests; tests must not require live paid API calls by default.
- Structured logging with correlation/session IDs.
- No raw secrets in logs.
- Avoid unnecessary abstractions, frameworks, queues, microservices, or databases during the local MVP.

## Before introducing a dependency
Explain briefly:
- what problem it solves,
- why the standard library/current dependency set is insufficient,
- runtime/maintenance cost,
- whether it creates provider lock-in.

## Important context documents
- `docs/PROJECT_CONTEXT.md` — complete product vision and technical context.
- `docs/DECISIONS.md` — current decisions vs future candidates vs unresolved items.
- `docs/ROADMAP.md` — phased implementation path.
- `.claude/skills/` — reusable project procedures.
