# First prompt to send Claude Code

Read `CLAUDE.md`, `docs/PROJECT_CONTEXT.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`, and inspect the available project skills under `.claude/skills/`.

We are starting Phase 0 of Mujeeb. The goal is a local real-time Arabic Voice Agent MVP using microphone input, streaming STT, OpenAI for the LLM/orchestration layer, streaming TTS, and speaker output. This MVP is the foundation of the future SaaS product, so it must be clean and extensible, but we do not want premature infrastructure or unrelated future features.

For this first task, do **not** start implementing immediately.

First:
1. Inspect the repository as it currently exists.
2. Summarize your understanding of the project and Phase 0 boundaries.
3. Propose the smallest robust technical stack and repository/module structure for Phase 0.
4. Explain how you will separate STT, LLM, TTS, orchestration, audio I/O, configuration, and observability.
5. Explain how cancellation/interruption and latency measurement will work.
6. List the environment variables we will need, without requesting or printing any secret values.
7. Identify any architectural decision that truly needs my approval before implementation.
8. Give a concrete implementation sequence in small steps.

Do not add SIP, phone numbers, a database, cloud deployment, WhatsApp, hospital APIs, or an admin dashboard in this phase.

After the plan, stop before implementation so I can review the foundation.
