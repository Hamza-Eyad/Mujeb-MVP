---
name: voice-pipeline
description: Build or modify Mujeeb's realtime audio path: microphone/telephony audio, streaming STT, turn handling, LLM orchestration, TTS, playback, interruption, and cancellation.
---

# Voice Pipeline Development

For any voice-loop change:

1. Draw the affected flow from audio input to audio output before editing.
2. Preserve provider boundaries; do not leak vendor events throughout the codebase.
3. Normalize streaming events into project-owned event types where useful.
4. Make cancellation explicit across STT, LLM generation, TTS generation, and playback.
5. Avoid unbounded audio/text buffering.
6. Handle partial and final transcripts intentionally; do not trigger duplicate turns from both.
7. Separate "user turn accepted" from "provider emitted a partial transcript".
8. Ensure stale output from a previous turn cannot play after a new interruption/cancellation.
9. Attach `session_id` and `turn_id` to logs/metrics.
10. Measure latency at meaningful boundaries rather than only total duration.
11. Surface provider disconnects/timeouts as typed/normalized failures.
12. Keep the core compatible with a future telephony audio source; microphone-specific code belongs at the edge.
13. Test the state machine/lifecycle with fake providers where possible.

Do not optimize by hiding latency or errors. We need measurements that show where the delay actually occurs.
