---
name: secure-integrations
description: Use when integrating any external API or SDK in Mujeeb, including OpenAI, ElevenLabs, telephony, messaging, cloud, hospital APIs, databases, or identity providers.
---

# Secure External Integrations

Before implementing an external integration:

1. Define a small project-owned adapter/contract.
2. Keep credentials in environment variables or an approved secret manager.
3. Add only placeholder names to `.env.example`; never add real values.
4. Validate external responses at the boundary.
5. Configure explicit timeouts.
6. Propagate cancellation where the SDK/protocol permits it.
7. Retry only transient operations that are safe to retry.
8. For side effects, design idempotency before automatic retries.
9. Normalize provider-specific errors into useful application errors.
10. Avoid logging secrets, authorization headers, or unnecessary sensitive payloads.
11. Pin/lock dependency versions according to the project package manager and review the SDK's maintenance footprint.
12. Do not spread provider-specific model IDs/endpoints throughout the codebase; centralize configuration.
13. Add a fake/mock adapter for tests when the integration is important to core flows.
14. Never claim regulatory compliance solely because a provider offers a feature or certification; production compliance requires project-specific review.
