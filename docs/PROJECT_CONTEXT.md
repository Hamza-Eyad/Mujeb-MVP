# مُجيب — Project Context & Product Vision

**Status:** Living project reference  
**Audience:** Claude Code, developers, technical reviewers, project stakeholders  
**Product:** مُجيب (Mujeeb)  
**Organization:** أكيد نمو (Akeed Numo) during the current phase  
**Market:** Healthcare providers in Saudi Arabia

---

## 1. Why Mujeeb exists

Healthcare providers receive large volumes of repetitive inbound calls: clinic information, working hours, doctor information, appointment availability, booking, rescheduling, cancellation, directions, preparation instructions, insurance-related questions, and requests to reach a human employee.

Mujeeb aims to become the AI voice layer that handles these calls naturally in Arabic, especially Saudi dialects, while integrating with each healthcare provider's approved knowledge and operational systems.

The product must eventually behave like an operational employee with strict permissions, not like a generic chatbot with unrestricted access.

---

## 2. Product vision

A patient calls the healthcare provider's normal phone number. The call is routed to Mujeeb. Mujeeb understands the caller in Arabic/Saudi dialect, answers approved questions, executes authorized administrative actions, confirms results, and transfers to a human when necessary.

The long-term system should support multiple healthcare organizations from one platform while keeping every organization's data, policies, prompts, tools, credentials, knowledge, and analytics isolated.

Mujeeb should own the orchestration, business rules, audit trail, tenant configuration, integrations, and operational intelligence. Voice/AI/telephony vendors should remain replaceable infrastructure components whenever technically possible.

---

## 3. Intended end-to-end call journey

1. Patient calls the clinic/hospital's existing number.
2. PBX/PSTN/SIP or a telecom provider routes the call to Mujeeb.
3. Mujeeb opens a call/session context.
4. Audio enters the voice engine.
5. The system understands the caller's utterance and current conversation state.
6. Mujeeb decides whether it can answer from approved knowledge or must execute a tool.
7. For an operational request, the orchestrator calls an authorized backend tool.
8. A hospital adapter communicates with the hospital's HIS/EHR/Scheduling system when available.
9. The backend returns a structured result to the orchestrator.
10. Mujeeb confirms the result verbally.
11. A confirmation may later be sent through WhatsApp/SMS.
12. If policy requires it, the session is transferred/escalated to a human with useful context.
13. The session produces auditable operational events and performance metrics.

Target architecture concept:

`Hospital Number -> Telephony/SIP -> Mujeeb Session Gateway -> Voice Engine -> Mujeeb Orchestrator -> Tools -> Hospital Adapter -> HIS/EHR/Scheduling`

---

## 4. Final product capabilities

### 4.1 Knowledge-based answers
Each tenant has its own approved knowledge base, such as:
- branches and locations,
- opening hours,
- clinic services,
- doctor/clinic information,
- approved preparation instructions,
- pricing/policies when explicitly provided,
- frequently asked questions.

The model must not invent tenant-specific facts when the knowledge source does not contain them.

### 4.2 Appointment workflows
Target workflows:
- show available slots,
- book an appointment,
- reschedule,
- cancel,
- confirm the resulting appointment state.

These should be exposed to the agent as strict tools/functions rather than free-form access to hospital systems.

### 4.3 Human handoff
Future capability:
- transfer a call to staff when requested or required,
- preserve/forward relevant context or a short summary,
- avoid forcing a caller through the AI when escalation policy says otherwise.

Implementation is not part of the current local MVP, but the architecture must not make it difficult later.

### 4.4 Confirmations
Future primary messaging direction:
- WhatsApp Business Platform / Cloud API for utility confirmations.
- SMS as a possible fallback depending on customer requirements.

### 4.5 Administration and analytics
Future tenant/admin capabilities may include:
- knowledge configuration,
- agent/prompt configuration,
- tool/integration configuration,
- call logs/transcripts subject to policy,
- task outcome reporting,
- latency/error monitoring,
- usage/cost reporting,
- quality evaluation.

---

## 5. Multi-tenant SaaS model

Mujeeb is intended to serve multiple hospitals/clinics.

One LLM/provider can serve many tenants. Tenant specialization must come from runtime configuration, not separate foundation models.

Per-tenant context can include:
- `tenant_id`,
- agent behavior/prompt configuration,
- knowledge base,
- allowed tools,
- escalation rules,
- hospital adapter/config,
- credentials/secrets,
- voice configuration,
- policies,
- business hours,
- analytics ownership.

Tenant boundaries must be explicit in all future persistent data access and tool execution. Never trust the model to enforce isolation by prompt alone.

---

## 6. Current MVP — October 2026

The immediate goal is **not** to build the entire SaaS platform. It is to prove and engineer the local real-time voice loop correctly.

### Current local flow

`Laptop Microphone -> Streaming STT -> Mujeeb Orchestration + OpenAI -> Streaming TTS -> Laptop Speaker`

### Current intended providers

- Speech-to-Text: ElevenLabs streaming/realtime STT direction.
- Large Language Model: OpenAI.
- Text-to-Speech: ElevenLabs low-latency TTS direction.
- Exact model IDs must remain configuration, because models and pricing change over time.

### Current MVP success questions

We need empirical answers to:
- How accurate is Saudi Arabic transcription?
- How well are names, numbers, dates, times, and code-switching handled?
- How quickly does the first useful response audio begin?
- Does the system feel conversational rather than turn-based and slow?
- Can playback/generation be cancelled when the caller interrupts?
- Can a session recover from provider errors or disconnects?
- Are latency and error events observable enough to diagnose problems?
- Is the provider boundary clean enough that microphone audio can later be replaced by telephone media without rewriting the agent core?

### Phase 1 addition (2026-10-12)

The voice loop is now extended with appointment tools: directory search, availability, patient lookup and registration, and booking, rescheduling, and cancellation. The tools run against a provider-independent scheduling port. A **Medplum sandbox with synthetic data** stands in for a hospital system during testing. Medplum is temporary and is not the production integration. See `docs/DECISIONS.md` A14–A18 and `plans/2026-10-12-his-scheduling-integration.md`.

### Explicit current exclusions

Do not add these until a later task/phase requests them:
- real phone number,
- SIP integration,
- Twilio production integration,
- Saudi carrier integration,
- Oracle Cloud deployment,
- database-backed tenant management,
- integration with a real hospital's appointment system or HIS/EHR (only the synthetic Medplum sandbox is in scope),
- production patient authentication (Phase 1 uses a development-only verification policy),
- production knowledge base,
- WhatsApp/SMS,
- human handoff,
- production admin UI.

---

## 7. Voice architecture strategy

Research considered two broad tracks:

### Track A — Modular pipeline
`Audio -> STT -> Orchestrator/LLM -> Tools -> TTS -> Audio`

Advantages:
- easier component-level benchmarking,
- provider choice per layer,
- greater control over transcripts and tool orchestration,
- easier replacement of STT/TTS independently.

Costs:
- latency must be engineered carefully,
- turn-taking and interruption logic become our responsibility.

### Track B — Native speech-to-speech
`Audio -> Realtime Audio Model -> Tools -> Audio`

Potential advantages:
- very natural interaction,
- potentially lower perceived latency,
- fewer explicit pipeline boundaries.

Tradeoffs:
- greater provider coupling,
- harder component-level diagnosis,
- Saudi dialect/voice control/cost/data requirements still require benchmarking.

### Current implementation direction
The first local MVP is intentionally modular. The architecture must preserve the option to benchmark native realtime speech later without replacing Mujeeb's domain/tool layer.

---

## 8. Provider abstraction principle

Do not let application/domain code depend directly on one vendor SDK everywhere.

Conceptual interfaces should exist around external capabilities, for example:

- `SpeechToTextProvider`
- `TextToSpeechProvider`
- `LLMProvider` or `AgentModelProvider`
- later: `TelephonyProvider`
- later: `MessagingProvider`
- `SchedulingSystem` (scheduling/HIS port, introduced in Phase 1; see `docs/DECISIONS.md` A14)

Vendor-specific code belongs in adapters. Domain/orchestration code consumes stable interfaces and normalized events/results.

This is not a reason to build a generic enterprise plugin framework now. Keep the interfaces minimal and driven by current use cases.

---

## 9. Orchestrator responsibility

Mujeeb's orchestrator is the core product layer. It should eventually own:
- session state,
- conversation policy,
- tenant context,
- prompt/context construction,
- tool authorization,
- tool-call loop,
- interruption/cancellation coordination,
- error recovery/fallback policy,
- audit events,
- metrics/traces,
- safe final response generation.

Provider SDKs should not become the product architecture.

---

## 10. Tool design for future actions

Actions such as booking must be deterministic backend operations exposed to the model through narrow schemas.

Example conceptual tool set:
- `search_available_slots`
- `book_appointment`
- `reschedule_appointment`
- `cancel_appointment`
- `get_clinic_information`
- `request_human_handoff`

Important future properties:
- input validation,
- authorization,
- tenant binding,
- idempotency for writes,
- clear success/failure states,
- audit event on every side effect,
- no direct model access to databases or unrestricted hospital APIs.

During the local MVP, tool contracts may be mocked if needed to prove the orchestration path. In Phase 1 the same tool contracts run against an in-memory adapter and a synthetic Medplum sandbox. Every write requires server-side caller confirmation (`docs/DECISIONS.md` A16).

---

## 11. Knowledge architecture

The long-term design should allow each hospital/clinic to have an independent knowledge source.

The model should receive only relevant approved tenant context for the current request.

Do not treat a giant system prompt containing every hospital's information as a multi-tenant architecture.

Future implementation may use retrieval, curated structured data, or both. The exact knowledge storage/search system is not required for the local voice MVP.

---

## 12. Latency and observability

Latency is a first-class product metric, not something added after deployment.

At minimum, the MVP should make it possible to measure:
- speech start/end or detected turn boundaries,
- STT partial/final timing,
- time from final/usable transcript to first LLM output token/event,
- tool-call duration where applicable,
- TTS request start,
- time to first audio byte/chunk,
- playback start,
- end-to-end user-turn latency,
- provider errors/reconnects/cancellations.

Use a `session_id`/correlation ID across the complete turn. Prefer structured machine-readable logs over unstructured print statements.

Do not log API keys. Avoid logging sensitive healthcare/patient information unless explicitly required and governed by a retention/access policy.

---

## 13. Reliability principles

For every external API connection:
- define explicit timeout behavior,
- propagate cancellation,
- classify retryable vs non-retryable errors,
- avoid retrying side effects blindly,
- expose useful normalized error information,
- prevent one vendor failure from corrupting session state.

The local MVP does not need complex high-availability infrastructure. It does need code boundaries that make failure understandable.

---

## 14. Security and healthcare constraints

Mujeeb will eventually handle sensitive operational healthcare interactions. The codebase should therefore avoid architecture that would make later compliance hard.

Principles from day one:
- least privilege,
- secret isolation,
- tenant isolation,
- auditability of important actions,
- no unrestricted model access to backend systems,
- minimize sensitive data collection,
- explicit retention/deletion decisions before production,
- encryption in transit and at rest when persistence is introduced,
- never describe the product as legally/compliance certified without verified evidence.

Saudi privacy, telecom, healthcare, and data residency requirements require formal review before production deployment. Engineering should preserve evidence and configurability rather than make unsupported compliance claims.

---

## 15. Safety scope

Mujeeb is initially an administrative voice assistant for healthcare, not a diagnostic model.

Allowed product direction:
- approved FAQs,
- navigation and administrative information,
- appointment operations,
- approved procedural instructions,
- routing/escalation.

Not a target for the MVP/product core:
- open medical diagnosis,
- hallucinated clinical recommendations,
- replacing emergency/clinical judgment flows without an explicitly approved safety design.

---

## 16. Future telephony direction

Current local MVP uses laptop audio only.

Later progression discussed:
1. Connect a prototype telephony layer to Mujeeb.
2. Validate live PSTN/SIP audio behavior and latency.
3. Prefer a suitable Saudi/local carrier or SIP arrangement for production where operationally and commercially appropriate.

Twilio has been considered useful for prototype/integration work, while a local Saudi carrier/SIP route is preferred as a production direction if it meets requirements. Telephony choice is not a current coding dependency.

---

## 17. Future infrastructure direction

A future cloud starting point has been discussed around Oracle Cloud in Saudi Arabia, with Riyadh as primary deployment direction and Jeddah as a backup/secondary location strategy.

Do not provision or couple the local MVP to Oracle-specific services yet. Keep runtime deployable in a conventional container/process model so infrastructure decisions remain reversible.

---

## 18. Concurrency and scaling vision

The system must eventually handle many simultaneous calls across multiple tenants.

Concurrency should be treated primarily as session isolation + async I/O + capacity planning, not as a reason to introduce microservices before measurements exist.

Future scaling concerns:
- concurrent streaming connections,
- provider rate limits,
- CPU/memory per session,
- audio buffering,
- database connection pressure,
- queue/backpressure behavior,
- tenant quotas,
- horizontal scaling,
- graceful draining of active calls during deployment.

The local MVP should simply avoid global mutable state that prevents more than one session later.

---

## 19. Product differentiation

Mujeeb should not be merely another wrapper around STT + LLM + TTS.

Long-term defensible value should live in:
- Saudi healthcare workflows,
- reliable hospital integrations,
- tenant-specific operational rules,
- auditable tool execution,
- Saudi Arabic evaluation data and quality processes,
- strong deployment/data controls,
- observability and measurable task success,
- an administration layer that makes agents manageable for healthcare operations.

---

## 20. Evaluation strategy

Testing should eventually include a Saudi-focused evaluation suite covering examples such as:
- common and difficult Saudi names,
- doctor names,
- Arabic and English code-switching,
- dates and appointment times,
- phone/identity-style digit sequences,
- noisy audio,
- interruptions,
- caller corrections,
- ambiguous appointment requests,
- provider/API failure cases.

Core metrics:
- transcription correctness,
- task success,
- tool correctness,
- hallucination rate,
- latency distribution rather than only averages,
- interruption success,
- session failure/recovery rate,
- cost per minute/call when paid services are introduced at scale.

---

## 21. Development philosophy

### We do want
- production-minded boundaries,
- simple modules,
- explicit contracts,
- testability,
- observability,
- configuration,
- reversible provider decisions,
- incremental delivery.

### We do not want
- a throwaway script that must be rewritten,
- a giant framework before one call works,
- dozens of microservices,
- Kafka/queues/distributed caches without a measured need,
- premature production UI,
- hardcoded provider SDK usage across the codebase,
- invented requirements or fake compliance.

The guiding sentence is:

> Build the smallest real foundation that can survive the next phase.

