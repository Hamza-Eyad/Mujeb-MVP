# مُجيب — Manual Voice Test Matrix (Phase 0)

Automated tests cover logic with fake providers. This matrix covers what only real hardware can show: **echo, false interruptions, and real interruption latency**. Run it whenever the audio path, barge-in policy, or provider settings change.

> No real patient data. Use made-up names, dates, and questions only.

## Setup
1. `npm run build && npm run dev` (live providers configured in `.env`), open `http://127.0.0.1:8787` in Chrome or Edge.
2. Note the browser + version and the audio devices in the results table.
3. Each scenario: run 5 attempts. The UI shows counters (barge-ins, false interruptions, echo-suppressed) and per-turn timings; `logs/turns-*.jsonl` keeps them. Run `npm run report` after a block of tests.

## Device × playback route × AEC

| # | Output device | Playback route | echoCancellation | Expected risk |
|---|---|---|---|---|
| D1 | Headset | direct | on | lowest — baseline |
| D2 | External speakers | direct | on | Chrome may not cancel Web Audio → echo |
| D3 | External speakers | webrtc-loopback | on | should reduce echo; adds some latency |
| D4 | Laptop speakers | webrtc-loopback | on | close mic/speaker coupling |
| D5 | External speakers | direct | off | worst case — validates engine echo filter / half-duplex |
| D6 | External speakers | any | any, `MUJEEB_DUPLEX_MODE=half` | no echo, but no barge-in possible |

## Scenarios (run per device row)

| ID | Scenario | Pass criteria |
|---|---|---|
| S1 | Silent listening while Mujeeb speaks a long answer | 0 interruptions, 0 false-interruption resumes, answer plays to the end |
| S2 | Real interruption: speak a full sentence mid-answer ("لا لحظة، أبي أسأل عن الدوام") | Playback stops; `interrupt_stop_ms` < 300ms; new turn answers the new question; old audio never resumes |
| S3 | Short interruption: say only "لا" mid-answer | Playback pauses immediately; turn interrupted after the commit |
| S4 | Backchannel: say "اها" / "ايه" mid-answer | Playback continues (or pauses briefly then resumes); no new turn |
| S5 | Cough / table knock mid-answer | At most a short pause then resume; counted as false interruption, not as a turn |
| S6 | Speak right after Mujeeb finishes (within 1s) | Your turn is accepted; Mujeeb's own echo tail does not create a turn |
| S7 | Pause mid-sentence for ~1s while thinking ("أبي موعد... يوم الأحد") | Record whether it was split into two turns (endpointing tuning data) |

## Results template

| Date | Browser | Device row | Scenario | Attempts | Passed | False interruptions | Median `interrupt_stop_ms` | Median `e2e_ms` | Notes |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## What to do with the results
- Echo in D2 but not D3 → make `webrtc-loopback` the default route.
- False interruptions in D3/D4 → raise `MUJEEB_FALSE_INTERRUPTION_TIMEOUT_MS`, tune the backchannel list, or the echo overlap threshold.
- Turns split in S7 → raise `MUJEEB_STT_VAD_SILENCE_SECS` (costs latency) or evaluate `turn_prediction` after the probe confirms support.
