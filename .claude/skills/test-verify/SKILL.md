---
name: test-verify
description: Verify Mujeeb changes before declaring them complete. Use after meaningful code changes, bug fixes, provider integrations, refactors, or voice-pipeline modifications.
disable-model-invocation: false
---

# Test and Verify

Before saying a change is complete:

1. Determine the smallest relevant verification set.
2. Run formatting/lint/type checks used by the repository.
3. Run unit tests for changed deterministic logic.
4. Run adapter/integration tests where available.
5. For voice changes, run a local smoke test or explain precisely why a live provider test could not be run.
6. Confirm configuration errors fail clearly (for example missing API key).
7. Confirm no secrets were added to tracked files.
8. Confirm logs include useful session/turn context and do not expose credentials.
9. Check cancellation/error paths, not just the happy path.
10. Report exactly what was executed and what remains unverified.

Never replace real functional verification with "the code looks correct".
