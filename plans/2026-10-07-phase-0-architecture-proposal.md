# مُجيب — تصميم Phase 0 (v2، معتمد)

- **v1 (2026-10-07):** مقترح أولي اختار Python. استُبدل.
- **v2 (2026-10-08):** اعتمد صاحب المشروع Option A: TypeScript (strict) على Node.js 24 LTS. أُضيفت ملاحظاته التسع (المقاطعة، الصدى، الـstreaming، الـturn detection، جاهزية الهاتف، الخصوصية، القياس، فصل الواجهة، الاختبارات).
- القرارات الرسمية: `docs/DECISIONS.md` (A1–A13). تقرير اللغة: `plans/2026-10-08-language-decision-report.md`.

---

## 1. النطاق

**Phase 0 = أول Vertical Slice حقيقي:**
`Mic (متصفح) → WebSocket → Voice Engine → Streaming STT (ElevenLabs) → OpenAI → Streaming TTS (ElevenLabs) → WebSocket → Speaker (متصفح)`

ومعه: المقاطعة (barge-in) من اليوم الأول، وقياس الأزمنة لكل مرحلة، وواجهة اختبار محلية تعرض النصوص والحالة والأزمنة.

**خارج النطاق:** الهاتف وSIP، والمستشفيات وHIS، والحجز، وقاعدة البيانات، والـtenancy الفعلي، وWhatsApp، ولوحة الإدارة، وأدوات الـagent (تبدأ في Phase 1).

**شروط الخروج:** نفس ROADMAP، بالإضافة إلى: المقاطعة تعمل ومقاسة، ومصفوفة اختبار الصدى اليدوية مُنفذة بنتائج مسجلة.

---

## 2. الطبقات واتجاه الاعتماد

```
app/ (composition root، dev server، CLI) ── يختار ويركّب كل شيء
   │
   ├── adapters/  (الكود الوحيد الذي يعرف OpenAI / ElevenLabs / المتصفح)
   │      openai · elevenlabs · transports/browser-ws · fakes
   │            │ implements
   │            ▼
   ├── ports/  (interfaces صغيرة: AudioTransport · SpeechToText · LanguageModel · TextToSpeech)
   │            ▲ uses
   ├── voice/  (VoiceSession: الدور، المقاطعة، التقطيع، VAD، سياسة الـbarge-in)
   ├── agent/  (Conversation: السجل وبناء الطلب، بدون أي معرفة بالصوت)
   ├── observability/ (logger، TurnTimeline، metrics JSONL)
   ├── contracts/ (zod: agent profile، بروتوكول الواجهة المحلية)
   └── core/   (أنواع الصوت، الأخطاء، المعرّفات، TenantContext، أدوات async) — لا يستورد شيئًا
```

القواعد يفرضها اختبار آلي (`tests/architecture/boundaries.test.ts`):
- `core` لا يستورد أي مجلد آخر.
- `ports` و`contracts` يستوردان من `core` فقط.
- `agent` و`voice` لا يستوردان من `adapters` أو `app`.
- `adapters` لا يستورد من `voice` أو `agent` أو `app`.
- لا يوجد استيراد لـ`openai` أو `ws` خارج `adapters/` و`app/`.

---

## 3. الملاحظات التسع وكيف يعالجها التصميم

### 3.1 المقاطعة (Barge-in): أربع طبقات حماية، وليس `close_context` وحده

عند تأكيد المقاطعة، تنفذ `VoiceSession.interrupt()` بالترتيب ونفس اللحظة:
1. **حارس الجلسة:** `activeEpoch = null`. لا يُرسل أي audio chunk يصل بعد الآن، حتى لو تأخر من المزود.
2. **تفريغ التشغيل:** `transport.clear(epoch)`. المتصفح يفرّغ الـbuffer فورًا، ويرد بـ`playback_cleared` حتى نقيس زمن التوقف الفعلي.
3. **إلغاء التوليد:** `AbortController.abort()` للدور. هذا يوقف طلب OpenAI (HTTP stream)، ويرسل `close_context` لـElevenLabs، ويوقف حلقة الصوت.
4. **حارس العميل:** كل frame صوتي يحمل `epoch` في أول 4 bytes. المتصفح يرمي أي frame قديم epoch-ه أقل من آخر `clear`.

بعدها يُسجل في السجل **فقط النص الذي سُمع فعلًا**. نحسبه من الـalignment الذي يرسله ElevenLabs مع الـmarks التي يؤكدها المشغّل. إذا غاب الـalignment، يُسجل النص المرسل مع علامة أنه تقديري.

### 3.2 الصدى والمقاطعات الكاذبة: لا نفترض أن المتصفح يحلها

**حقيقة موثقة:** الـAEC في Chrome يعتمد تاريخيًا على الصوت القادم من RTCPeerConnection فقط، وليس على Web Audio المباشر (Chromium issue 687574). Firefox يعامل كل صوت المتصفح.

**ما نبنيه:**
- **مساران للتشغيل في الواجهة، نقيس الاثنين:**
  - `direct`: Web Audio مباشرة.
  - `webrtc-loopback`: الصوت يمر عبر RTCPeerConnection محلي حتى يراه AEC الخاص بـChrome. هذا يضيف تأخيرًا بسيطًا، ونقيسه.
- **مفاتيح في الواجهة:** `echoCancellation` و`noiseSuppression` و`autoGainControl`.
- **سياسة barge-in في المحرك** (`voice/barge-in-policy.ts`)، دالة نقية مختبرة:
  - `ignore`: نص فارغ، أو backchannel فقط ("اها"، "ايه"، "طيب"...)، أو **صدى**، أي أن كلمات الـpartial تتطابق بنسبة ≥ 60% مع نص مُجيب الحالي، بعد تطبيع عربي (الهمزات والتاء المربوطة والتشكيل).
  - `candidate`: كلمة واحدة غير محسومة. **نوقف التشغيل مؤقتًا (pause)** ولا نلغي.
  - `interrupt`: كلمتان أو أكثر ليست صدى، أو commit نهائي غير مُتجاهل. **إلغاء كامل.**
- **المقاطعة الكاذبة:** إذا بقي التشغيل موقوفًا مؤقتًا بدون تأكيد خلال `MUJEEB_FALSE_INTERRUPTION_TIMEOUT_MS`، يُستأنف الصوت من حيث توقف. نحسب ذلك كـ`false_interruption`.
- **ذيل الصدى:** خلال `MUJEEB_ECHO_TAIL_MS` بعد انتهاء كلام مُجيب، أي commit يطابق آخر رد يُتجاهل، ولا يصير دورًا جديدًا.
- **وضع half-duplex** (`MUJEEB_DUPLEX_MODE=half`) كخطة بديلة: المايك لا يُرسل للـSTT أثناء كلام مُجيب.
- **اختبارات يدوية فعلية:** مصفوفة في `docs/MANUAL_VOICE_TESTS.md` تغطي سماعة رأس، وسماعات خارجية، وسماعات اللابتوب، مع كل مسار تشغيل وكل إعداد AEC. الواجهة تعرض عدادات المقاطعات الحقيقية والكاذبة وزمن التوقف.

### 3.3 Streaming حقيقي في كل مرحلة

| المقطع | ما يحدث |
|---|---|
| المايك → المحرك | AudioWorklet يرسل frames من نوع PCM16 16kHz كل 20ms عبر WebSocket، بلا انتظار تسجيل كامل |
| المحرك → STT | تجميع إلى `MUJEEB_STT_CHUNK_MS` (الافتراضي 100ms، وتوصية ElevenLabs 0.1–1s) ثم إرسال فوري |
| STT → المحرك | partial transcripts فورية، ثم commit عند نهاية الكلام |
| LLM → التقطيع | Responses API streaming. كل delta يدخل `text-chunker` فورًا |
| التقطيع → TTS | كل عبارة تكتمل (`. ، ؟ ! ؛` متبوعة بمسافة) تُرسل مع `flush`. المقطع الأول أقصر لتقليل زمن أول صوت |
| TTS → المتصفح | كل audio chunk يُرسل فور وصوله، والمتصفح يشغّله من ring buffer |

### 3.4 Turn detection: نتحقق ولا نفترض

- التوثيق يقول إن `turn_prediction` يعمل "only for models that predict turns". وإعدادات الجلسة الموثقة لـ`scribe_v2_realtime` تذكر `manual` و`vad` فقط. **لذلك الافتراضي `vad`.**
- `npm run probe:elevenlabs` يفتح جلسة STT حقيقية لكل strategy ويقرأ `session_started.config.commit_strategy` كما رجع من الخادم. النتيجة تُطبع وتُسجل.
- `turn_prediction` يُفعّل فقط عبر `MUJEEB_STT_COMMIT_STRATEGY=turn_prediction` بعد نجاح الـprobe. وعند بدء كل جلسة، إذا رد الخادم بـstrategy مختلفة عن المطلوبة، نسجل تحذيرًا صريحًا `stt.commit_strategy_mismatch`.
- `MUJEEB_STT_VAD_SILENCE_SECS` (الافتراضي 0.8 بدل 1.5 الخاص بالمزود) مقبض نقيسه مع اللهجة السعودية.

### 3.5 جاهزية الهاتف: `AudioTransport` قابل للاستبدال

```ts
interface AudioTransport {
  inputFormat: AudioFormat;    // المتصفح: pcm_s16le 16k · الهاتف لاحقًا: mulaw 8k
  outputFormat: AudioFormat;
  capabilities: { pause: boolean; playbackStartEvents: boolean };
  setHandler(h: (e: TransportEvent) => void): void;  // audio | mark | playback_started | playback_cleared | closed
  sendAudio(epoch, bytes); sendMark(epoch, name); clear(epoch); pause(); resume(); close();
}
```

- **الصيغ:** الـtransport يعلن صيغه، ومزودو STT/TTS يُضبطون عليها. ElevenLabs يقبل `ulaw_8000` كمدخل STT ومخرج TTS، فلن نحتاج transcoding للهاتف. VAD المحلي يعمل على PCM16 فقط، ونضيف decoder μ-law عند بناء أول transport هاتفي.
- **التوقيت:** المتصفح والهاتف (مثل Twilio) كلاهما يخزن الصوت عنده. لذلك نعتمد على **marks** بنفس فكرة Twilio لنعرف ما شُغّل فعلًا، وليس على وقت الإرسال.
- **التحكم بالتشغيل:** `clear` متاح في الاثنين. أما `pause/resume` فهو `capability`: متاح في المتصفح، وغير متاح في Twilio. عند غيابه تتحول حالة `candidate` إلى "انتظار التأكيد" بدون إيقاف مسموع.
- **لا تنفيذ لأي هاتف الآن.**

### 3.6 الخصوصية
- لا بيانات مرضى حقيقية إطلاقًا. الاختبارات تستخدم نصوصًا ونغمات اصطناعية. والواجهة تعرض تنبيهًا بذلك.
- OpenAI: `store=false`، وسجل المحادثة عندنا.
- ElevenLabs Zero Retention: **Enterprise فقط**. الـflag `MUJEEB_ELEVENLABS_ZERO_RETENTION` افتراضيه `false`. الـprobe يتحقق مما يعيده الخادم في `session_started.config.enable_logging`. والمحرك يسجل عند البدء `privacy.retention_mode` بوضوح.
- لا تُكتب النصوص في الـlogs افتراضيًا، والمفاتيح لا تُكتب أبدًا (redaction في الـlogger).

### 3.7 القياس (Observability)
`TurnTimeline` يستخدم ساعة monotonic (`performance.now()`) لكل دور:

| المرحلة | المقياس |
|---|---|
| استقبال الصوت | `transport_rtt_ms` (ping/pong كل 2 ثانية) وفجوات وصول الـframes |
| التفريغ النصي | `stt_first_partial` و`stt_finalize_ms = stt_committed − user_speech_end` |
| النموذج | `llm_ttft_ms = llm_first_token − llm_request` و`llm_total_ms` |
| بداية توليد الصوت | `tts_ttfb_ms = tts_first_audio − tts_first_text` |
| بداية التشغيل | `playback_start`، يؤكده المتصفح عند تشغيل أول sample فعلًا |
| الإحساس الكلي | **`e2e_ms = playback_start − user_speech_end`** |
| المقاطعة | `barge_in_reaction_ms = interrupt_requested − barge_in_speech_start` و`interrupt_stop_ms = playback_stopped − interrupt_requested` |

- كل دور يُكتب كسطر `turn.summary` في `logs/turns-YYYY-MM-DD.jsonl`.
- `npm run report` يحسب p50/p90/p95.
- الواجهة تعرض نفس الأرقام مباشرة.
- `user_speech_end` يحسبه VAD طاقة (RMS) محلي في المحرك، مع تعويض فترة الـhangover.

### 3.8 فصل واجهة الاختبار عن المحرك
- `web/dev-client/` ملفات ثابتة: HTML وJS وAudioWorklets. **لا مفاتيح، ولا prompt، ولا قرار محادثة.** وظيفتها: التقاط، وتشغيل، وعرض أحداث.
- المحرك لا يعرف المتصفح. يعرف فقط `AudioTransport`، ومستمع أحداث (`SessionObserver`) يرسل أحداث العرض.
- الخادم المحلي يستمع على `127.0.0.1` فقط.

### 3.9 الاختبارات الآلية (Vitest، بدون أي API مدفوع)
- **Unit:** التطبيع العربي، وسياسة الـbarge-in، والـchunker، وVAD الطاقة، والـtimeline، والـsettings، وتحليل رسائل المزودين.
- **Integration (fakes):**
  - دور كامل.
  - مقاطعة: توقف LLM وTTS، وتفريغ، و**عدم إرسال أي صوت قديم** حتى لو استمر المزود بالإرسال.
  - مقاطعة كاذبة ثم استئناف.
  - backchannel، وصدى، وكلام أثناء THINKING (دمج النص).
  - خطأ مزود ومهلة، والجلسة تبقى سليمة.
  - **جلسات متزامنة** معزولة.
- **Adapters:** OpenAI مقابل SSE server محلي. ElevenLabs STT وTTS مقابل WebSocket server محلي يحاكي البروتوكول، مع اختبار الإلغاء.
- **Transport:** خادم حقيقي مع WebSocket client حقيقي، دور كامل عبر الشبكة المحلية.
- **Architecture:** قواعد الاستيراد.
- **Live (اختياري):** `MUJEEB_LIVE_TESTS=1` يتطلب مفاتيح، ومعطل افتراضيًا.

---

## 4. الـStack

| العنصر | الاختيار |
|---|---|
| Runtime | Node.js 24 LTS (المشروع يعمل على ≥ 22.14). `.nvmrc` = 24 |
| اللغة | TypeScript strict، يُبنى بـ`tsc` إلى `dist/` ويُشغّل بـ`node` (بدون loaders) |
| Dependencies | `openai`، و`ws` (Node لا يملك WebSocket server)، و`zod` |
| Dev | `typescript` و`vitest` و`eslint` مع `typescript-eslint` (`no-floating-promises`) و`@types/*` |
| حُذف من التقرير | `pino` (استُبدل بـlogger JSON صغير)، و`yaml` (البروفايل JSON مع prompt بصيغة Markdown)، و`dependency-cruiser` (استُبدل باختبار boundaries) |
| `.env` | `node --env-file-if-exists=.env`، بدون dotenv |

## 5. متغيرات البيئة
أسماء فقط، والقيم في `.env.example`:
- **المفاتيح:** `OPENAI_API_KEY` و`ELEVENLABS_API_KEY`.
- **الـLLM:** `MUJEEB_LLM_PROVIDER` و`MUJEEB_LLM_MODEL` و`MUJEEB_LLM_REASONING_EFFORT` و`MUJEEB_LLM_FIRST_TOKEN_TIMEOUT_MS` و`MUJEEB_LLM_MAX_OUTPUT_TOKENS`.
- **الـSTT:** `MUJEEB_STT_PROVIDER` و`MUJEEB_STT_MODEL` و`MUJEEB_STT_LANGUAGE` و`MUJEEB_STT_COMMIT_STRATEGY` و`MUJEEB_STT_VAD_SILENCE_SECS` و`MUJEEB_STT_CHUNK_MS`.
- **الـTTS:** `MUJEEB_TTS_PROVIDER` و`MUJEEB_TTS_MODEL` و`MUJEEB_TTS_VOICE_ID` و`MUJEEB_TTS_FIRST_AUDIO_TIMEOUT_MS`.
- **ElevenLabs:** `MUJEEB_ELEVENLABS_BASE_URL` و`MUJEEB_ELEVENLABS_ZERO_RETENTION`.
- **سلوك الجلسة:** `MUJEEB_DUPLEX_MODE` و`MUJEEB_FALSE_INTERRUPTION_TIMEOUT_MS` و`MUJEEB_ECHO_TAIL_MS`.
- **الخادم والبروفايل:** `MUJEEB_AGENT_PROFILE` و`MUJEEB_DEV_HOST` و`MUJEEB_DEV_PORT`.
- **الـlogs:** `MUJEEB_LOG_LEVEL` و`MUJEEB_LOG_DIR` و`MUJEEB_LOG_TRANSCRIPTS`.

## 6. المخاطر المفتوحة
1. **الصدى في Chrome مع Web Audio:** أثره الحقيقي يتحدد بنتائج المصفوفة اليدوية.
2. **endpointing باللهجة السعودية:** `vad_silence` مقبض نقيسه. و`turn_prediction` غير مؤكد.
3. **تطبيع الأرقام والأوقات العربية للـTTS:** غير منفذ في هذه الشريحة. ElevenLabs يملك `apply_text_normalization`، ويحتاج تقييمًا.
4. **زمن الشبكة إلى المزودين خارج السعودية:** يُقاس منفصلًا.
5. **ZRM وإقامة البيانات (D4):** قرار تعاقدي، وليس قرارًا هندسيًا.

## 7. تسلسل التنفيذ
1. الأدوات والـtoolchain.
2. `core` و`observability` و`config`.
3. منطق `voice` النقي.
4. `ports` والـfakes و`VoiceSession`.
5. الـtransport والخادم المحلي.
6. واجهة المتصفح.
7. adapters الـOpenAI وElevenLabs.
8. الـprobe والـreport.
9. التشغيل والتوثيق.

## 8. حالة التنفيذ (2026-10-08)

| البند | الحالة |
|---|---|
| الخطوات 1–9 | منفذة ومختبرة آليًا: 74 اختبارًا، وtypecheck، وlint |
| تشغيل حقيقي بالزمن الفعلي مع fakes عبر WebSocket | نجح. المقاطعة أوقفت التشغيل خلال 3ms، وصفر صوت قديم بعد clear |
| واجهة المتصفح (headless، مايك وهمي) | تعمل على المسارين `direct` و`webrtc-loopback`، بدون أخطاء console |
| المزودون الحقيقيون (OpenAI وElevenLabs) | **تعمل** (2026-10-08): `gpt-5.4-mini` و`eleven_flash_v2_5` والصوت المختار و`scribe_v2_realtime`. نجحت محادثة حية كاملة فيها مقاطعة |
| `turn_prediction` وZero Retention | **محسومان بالقياس:** `turn_prediction` مرفوض على `scribe_v2_realtime`، وZero Retention لا يُطبَّق على خطة Starter |
| الأزمنة الحقيقية (2026-10-08، عيّنة صغيرة) | e2e بين 2.9 و3.5 ثانية = إنهاء التفريغ النصي 1.3–1.8 ثانية + أول token من الموديل 0.9–1.5 ثانية + أول صوت من TTS حوالي 0.2 ثانية. أول partial transcript بالعربي يتأخر حوالي 2.3 ثانية، وهذا يبطئ المقاطعة المعتمدة على النص. توقف التشغيل عند المقاطعة أقل من 3ms |
| مصفوفة الصدى اليدوية | جاهزة في `docs/MANUAL_VOICE_TESTS.md`. **تتطلب تنفيذًا بشريًا بأجهزة حقيقية** |
| تطبيع الأرقام والأوقات العربية للـTTS | غير منفذ (خطر مفتوح #3) |
