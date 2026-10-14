---
name: mujeeb-architecture
description: Protect Mujeeb's architecture when adding or changing modules, providers, orchestration, integrations, persistence, telephony, or SaaS capabilities. Use before non-trivial architectural changes.
---

# Mujeeb Architecture Guard

When changing architecture:

1. Read `CLAUDE.md`, `docs/PROJECT_CONTEXT.md`, and `docs/DECISIONS.md`.
2. Identify the current roadmap phase and do not expand scope accidentally.
3. Keep domain/orchestration logic independent from vendor SDKs.
4. Put provider-specific behavior behind a minimal adapter/interface.
5. Prefer a modular monolith unless there is measured evidence that a separate service is required.
6. Keep dependency direction clear: product/domain code should not import infrastructure details unnecessarily.
7. Avoid global mutable state that would block multiple sessions later.
8. Treat tenant context as an explicit concept in future-facing boundaries, but do not build unused tenant infrastructure during Phase 0.
9. Before adding a major dependency or subsystem, explain the concrete problem it solves and the simpler alternatives considered.
10. Record any real architecture decision change in `docs/DECISIONS.md`.

Reject changes that make the MVP faster today only by forcing a likely rewrite of the Mujeeb core in the next phase, unless the tradeoff is explicitly approved.
