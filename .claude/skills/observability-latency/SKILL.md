---
name: observability-latency
description: Add or review structured logging, tracing, realtime latency measurement, error metrics, and performance diagnostics for Mujeeb voice sessions.
---

# Observability and Latency

When instrumenting Mujeeb:

Track useful timestamps/events such as:
- session start/end,
- turn start,
- speech/turn end if available,
- STT first partial,
- STT usable/final transcript,
- LLM request start,
- LLM first output event/token,
- tool call start/end,
- TTS request start,
- TTS first audio chunk,
- playback start/end,
- cancellation/interruption,
- provider reconnect/error.

Requirements:
1. Use structured logs rather than free-form debug text for important events.
2. Include `session_id`, `turn_id`, component/provider, event name, duration/timestamp, and error class where relevant.
3. Never log API keys/tokens.
4. Minimize patient/sensitive content in logs by default.
5. Keep timing measurement monotonic where possible.
6. Distinguish network/provider latency from local playback/buffering latency.
7. Report distributions/percentiles when enough samples exist; do not rely on one successful call or only an average.
8. Make instrumentation cheap enough to leave enabled in development and production with configurable verbosity.
