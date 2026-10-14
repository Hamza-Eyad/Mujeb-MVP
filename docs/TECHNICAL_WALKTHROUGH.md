# مُجيب (Mujeeb) — شرح تقني كامل للكود والمعمارية وتدفق البيانات

> **الغرض:** ملف مرجعي لفهم البرنامج من الداخل: كل وحدة وش تسوي، وكيف الداتا تمشي من الميكروفون إلى السماعة، وكيف تتنفذ الأدوات والحجز، وكيف تُحمى الكتابات.
> **مصدر المعلومات:** قراءة مباشرة للكود في `src/` و`web/` و`config/` و`tests/` بتاريخ 2026-10-14. كل اسم ملف أو دالة أو ثابت مذكور هنا موجود فعلًا في الكود.
> **حدود الشرح:** هذا شرح للوضع الحالي (المرحلة 0 + المرحلة 1). ما فيه شي عن مراحل لاحقة (هاتف، قاعدة بيانات، إلخ) إلا في قسم الحدود.

### إذا بترسل الملف لـ ChatGPT

الصق الملف كامل ثم اكتب له شي مثل:

```
هذا شرح تقني لمشروع مُجيب (Voice AI agent للعيادات في السعودية، مكتوب بـ TypeScript على Node.js).
اشرح لي كل قسم بالتفصيل وبالعربي، وبعدها اسألني أسئلة تأكد إني فهمت:
1) كيف يمشي الصوت من الميكروفون إلى السماعة (الأقسام 5 و6)
2) كيف تشتغل المقاطعة (القسم 6.6)
3) كيف يتأكد النظام قبل أي حجز (القسم 10)
4) كيف أستبدل Medplum بنظام مستشفى حقيقي (القسم 11)
```

---

## فهرس الأقسام

1. [الصورة الكبيرة](#1-الصورة-الكبيرة)
2. [خريطة المجلدات وقواعد الاعتماد](#2-خريطة-المجلدات-وقواعد-الاعتماد)
3. [الإقلاع: من `npm run dev` إلى أول مكالمة](#3-الإقلاع-من-npm-run-dev-إلى-أول-مكالمة)
4. [الواجهات (Ports): العقود بين المنطق والمزودين](#4-الواجهات-ports-العقود-بين-المنطق-والمزودين)
5. [رحلة الصوت بالبايتات (نقل الصوت)](#5-رحلة-الصوت-بالبايتات)
6. [`VoiceSession`: قلب النظام](#6-voicesession-قلب-النظام)
7. [سجل المحادثة وطلبات النموذج اللغوي](#7-سجل-المحادثة-وطلبات-النموذج-اللغوي)
8. [`AgentTurn`: حلقة النموذج ↔ الأدوات](#8-agentturn-حلقة-النموذج--الأدوات)
9. [`AppointmentTools`: أدوات المواعيد](#9-appointmenttools-أدوات-المواعيد)
10. [أمان الكتابة: التأكيد، السجل، المطابقة](#10-أمان-الكتابة-التأكيد-السجل-المطابقة)
11. [`SchedulingSystem` والمحولات (Memory وMedplum)](#11-schedulingsystem-والمحولات)
12. [الإعدادات والعقود (zod)](#12-الإعدادات-والعقود-zod)
13. [القياس والسجلات](#13-القياس-والسجلات)
14. [واجهة المتصفح](#14-واجهة-المتصفح)
15. [الإلغاء والأخطاء](#15-الإلغاء-والأخطاء)
16. [الاختبارات](#16-الاختبارات)
17. [الخصوصية والأمان داخل الكود](#17-الخصوصية-والأمان-داخل-الكود)
18. [حدود معروفة وملاحظات](#18-حدود-معروفة-وملاحظات)
19. [كيف تتتبع طلب واحد من الأول للآخر](#19-كيف-تتتبع-طلب-واحد)

---

## 1. الصورة الكبيرة

### 1.1 وش هو البرنامج

عملية Node.js واحدة (modular monolith). تشغّل:

- خادم HTTP محلي يقدّم صفحة الاختبار (`web/dev-client/`)،
- خادم WebSocket على المسار `/ws`: كل اتصال يصير `VoiceSession` مستقلة،
- كل جلسة تربط: **متصفح (مايك وسماعة) ← STT ← نموذج لغوي + أدوات ← TTS ← متصفح**.

لا يوجد: قاعدة بيانات، طوابير، microservices، هاتف. كل حالة الجلسة في ذاكرة العملية.

### 1.2 المكدس

| العنصر | القيمة |
|---|---|
| اللغة | TypeScript (strict)، تُبنى بـ `tsc` إلى `dist/` وتُشغَّل بـ `node` مباشرة |
| Runtime | Node.js 24 (المشروع يقبل ≥ 22.14) |
| مكتبات التشغيل (3 فقط) | `openai` (SDK)، `ws` (WebSocket server وclient)، `zod` (التحقق من المدخلات) |
| الاختبارات | `vitest` |
| الفحص | `eslint` + `typescript-eslint` (مع `no-floating-promises`) |
| المزودون | OpenAI Responses API (النموذج)، ElevenLabs (STT وTTS)، Medplum (نظام مواعيد تجريبي) |

### 1.3 حجم الكود (قياس فعلي)

| الجزء | ملفات | أسطر تقريبًا |
|---|---|---|
| `src/adapters/` | 13 | 3,721 |
| `src/agent/` | 10 | 1,964 |
| `src/voice/` | 5 | 1,232 |
| `src/app/` | 8 | 883 |
| `src/core/` | 12 | 792 |
| `src/contracts/` | 4 | 445 |
| `src/ports/` | 5 | 395 |
| `src/observability/` | 3 | 273 |
| `src/config/` | 1 | 247 |
| `web/dev-client/` | 5 | 1,533 |
| `tests/` | 35 | 7,725 |

### 1.4 أوامر التشغيل (`package.json` → `src/app/cli.ts`)

| الأمر | وش يسوي |
|---|---|
| `npm run dev` | `tsc` ثم `node --env-file-if-exists=.env dist/app/cli.js serve` (مزودون حقيقيون) |
| `npm run dev:fake` | نفس الشي مع `--fake`: مزودون وهميون بدون مفاتيح |
| `npm run check` | `typecheck` + `lint` + `vitest run` (بدون أي API مدفوع) |
| `npm run test:live` | اختبارات مع مزودين حقيقيين (معطلة افتراضيًا) |
| `npm run report` | يحسب p50/p90/p95 من `logs/turns-*.jsonl` |
| `npm run probe:elevenlabs` | يفتح جلسات حقيقية ويقرأ ما طبّقه الخادم فعلًا من الإعدادات |
| `npm run seed:medplum` | يعبّي Medplum ببيانات اصطناعية (dry-run افتراضيًا، `--apply` للكتابة) |

---

## 2. خريطة المجلدات وقواعد الاعتماد

### 2.1 المجلدات

```
src/
  core/            أساسيات بلا اعتماد على أي مجلد آخر
  contracts/       مخططات zod (أدوات، بروفايل، بروتوكول المتصفح، dataset)
  ports/           الواجهات (interfaces) الخمس التي يعتمد عليها المنطق
  observability/   logger، TurnTimeline، turn-metrics (JSONL)
  config/          settings.ts: متغيرات البيئة ← كائن typed
  agent/           سجل المحادثة، حلقة الأدوات، أدوات المواعيد وقواعدها
  voice/           VoiceSession، سياسة المقاطعة، VAD، تقطيع النص
  adapters/        الكود الوحيد الذي يعرف OpenAI وElevenLabs وMedplum والمتصفح
  app/             نقطة التركيب (container)، CLI، الخادم المحلي، التقارير
web/dev-client/    صفحة المتصفح (HTML + JS + AudioWorklets)
config/            profile العيادة + تعليمات الوكيل + بيانات الاختبار
tests/             unit / integration / contract / architecture / live / support
```

### 2.2 اتجاه الاعتماد (يُفرض باختبار آلي)

الملف `tests/architecture/boundaries.test.ts` يقرأ كل `import` في `src/` ويفشل لو خالف الجدول:

| الطبقة | مسموح لها تستورد من |
|---|---|
| `core` | لا شي |
| `contracts` | `core` |
| `ports` | `core` |
| `observability` | `core` |
| `config` | `core` |
| `agent` | `core`, `ports`, `contracts` |
| `voice` | `core`, `ports`, `agent`, `observability` |
| `adapters` | `core`, `ports`, `contracts` |
| `app` | كل الطبقات |

وحزم الطرف الثالث المسموحة لكل طبقة: `contracts` و`config` ← `zod`؛ `adapters` ← `openai`, `ws`, `zod`؛ `app` ← `ws`؛ الباقي ← لا شي.

اختبارات إضافية في نفس الملف:

- ما يظهر اسم `elevenlabs` أو `openai` داخل `core/ports/agent/voice`.
- ما يظهر `medplum` أو `fhir` داخل `core/ports/agent/voice/contracts`.
- من يستورد `adapters/medplum/` فقط `app/container.ts` و`app/medplum-seed-command.ts`.
- ما يوجد UUID مكتوب بالكود أو في `config/agents/`.

**المعنى العملي:** تقدر تحذف `src/adapters/medplum/` وما ينكسر إلا ملفين في `app/`.

### 2.3 الرسم المعماري

```
                      app/ (container.ts, dev-server.ts, cli.ts)
                          | يقرأ الإعدادات، يختار المحولات، يشغّل الخادم
             +------------+-------------+
             v                          v
        voice/VoiceSession  ---->  agent/ (AgentTurn, Conversation, AppointmentTools)
             |  تستخدم                  |  تستخدم
             v                          v
        +------------------- ports/ (interfaces) --------------------+
        | AudioTransport | SpeechToText | TextToSpeech | LanguageModel | SchedulingSystem |
        +--------------------------^----------------------------------+
                                   | implements
        +--------------------------+----------------------------------+
        | adapters/: browser-ws | elevenlabs (stt,tts) | openai | memory | medplum | fakes |
        +----------------------------------------------------------------+
        core/ · contracts/ · observability/ · config/   (الأساس المشترك)
```

---

## 3. الإقلاع: من `npm run dev` إلى أول مكالمة

### 3.1 تسلسل `serve` في `src/app/cli.ts`

1. `loadSettings(process.env, { forceFakeProviders })` ← يقرأ ويتحقق من كل المتغيرات (قسم 12). أي نقص يرمي `ConfigError` برسالة تذكر اسم المتغير بدون قيمته.
2. `createJsonLogger({ level })` ← logger JSON.
3. يسجل `app.config` (إعدادات بدون أسرار) و`privacy.retention_mode`.
4. `loadAgentProfile(settings.agentProfilePath)` (`src/app/agent-profile.ts`) ← يقرأ `profile.json`، ويقرأ `instructions.md` و`tools.md` من داخل نفس المجلد فقط (دالة `readInside` تمنع الخروج من المجلد).
5. `createScheduling(settings, profile.tenantId, log)` (`container.ts`) ← يرجع `MemorySchedulingSystem` أو `MedplumSchedulingSystem` أو `undefined` (لو `none`). **نسخة واحدة تُشارَك بين كل الجلسات** (مثل نظام مستشفى حقيقي).
6. إذا فيه scheduling يسجل `privacy.verification_policy` مع `production_grade: false`.
7. `new JsonlTurnSink(settings.log.dir)` ← يفتح `logs/turns-YYYY-MM-DD.jsonl` للإلحاق.
8. `startDevServer({...})` ← `maxSessions: 2`.
9. يسجل معالجات `SIGINT/SIGTERM` لإغلاق نظيف.

### 3.2 `startDevServer` (`src/app/dev-server.ts`)

- `http.createServer` يخدم ملفات ثابتة من قائمة بيضاء (`STATIC_FILES`: `/`, `/app.js`, `/capture-worklet.js`, `/player-worklet.js`, `/style.css`) ومسار `/healthz`. الاستجابة فيها `content-security-policy` صارمة.
- `WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })`.
- على حدث `upgrade`: يرفض (403) إذا المسار ليس `/ws` أو الـ`Origin` غير موجود/غير مسموح (يسمح فقط بـ `http://127.0.0.1:port` و`http://localhost:port`)، ويرفض (503) إذا الجلسات ≥ `maxSessions`. هذا يمنع مواقع أخرى من تشغيل جلسة وصرف رصيد المزودين.
- الخادم لا يقبل غير loopback: `loadSettings` يرمي خطأ لو `MUJEEB_DEV_HOST` ليس `127.0.0.1/localhost/::1`.

### 3.3 `startSession(ws)` — يُنفَّذ لكل اتصال WebSocket

```
sessionId = newSessionId()                       // ses_<uuid>
transport = new BrowserWsTransport(ws, {pcm16 16kHz in/out})
tenant    = { tenantId, agentId } من profile
tools     = new AppointmentTools({...})          // فقط إذا scheduling + profile.appointmentTools
session   = new VoiceSession({ ..., transport, stt, llm, tts, tools, config, observer })
transport.send({type:'session_started', ...})    // للواجهة
await session.start()
```

نقاط مهمة:

- **`AppointmentTools` تُنشأ لكل جلسة** (refs، التحقق من المريض، الإجراء المعلق، سجل الكتابات). بينما `SchedulingSystem` مشتركة.
- `instructions` المرسلة للنموذج = `instructions.md` + (إذا الأدوات مفعلة) `tools.md`.
- `observer: (event) => transport.send({ type: 'event', event })` ← كل حدث داخل الجلسة يوصل للواجهة للعرض.
- `toolDrainTimeoutMs = writeTimeoutMs + 2 * readTimeoutMs` (افتراضيًا 8000 + 2×4000 = 16 ثانية).

---

## 4. الواجهات (Ports): العقود بين المنطق والمزودين

كل ملف في `src/ports/` يحدد عقدًا صغيرًا. المنطق لا يعرف مزودًا بالاسم.

### 4.1 `AudioTransport` (`ports/audio-transport.ts`)

```ts
interface AudioTransport {
  inputFormat: AudioFormat;       // مثلًا pcm_s16le 16kHz
  outputFormat: AudioFormat;
  capabilities: { pause: boolean; playbackStartEvents: boolean };
  setHandler(h: (e: TransportEvent) => void): void;
  sendAudio(epoch: number, data: Uint8Array): void;
  sendMark(epoch: number, name: string): void;
  clear(epoch: number): void;     // أوقف التشغيل الحين وافرّغ كل شي لهذا الـepoch وما قبله
  pause(): void; resume(): void; close(reason: string): void;
}
type TransportEvent =
  | { type: 'audio'; data }            // صوت المتصل
  | { type: 'mark'; name }             // الطرف الآخر أكد أنه وصل لهذه العلامة بالتشغيل
  | { type: 'playback_started'; epoch }
  | { type: 'playback_cleared'; epoch }
  | { type: 'rtt'; ms }
  | { type: 'closed'; reason };
```

**فكرة الـepoch والـmarks:** الطرف الآخر (متصفح أو هاتف لاحقًا) يخزّن الصوت عنده. فنحن ما نعرف وش انسمع فعلًا من وقت الإرسال، بل من **تأكيد المارك**. كل جملة يقولها مُجيب لها `epoch` رقم جديد، وكل مقطع صوت يتبعه مارك باسم `"<epoch>:<index>"`.

### 4.2 `SpeechToText` (`ports/speech-to-text.ts`)

```ts
open({ format, onEvent, signal, log }): Promise<SttStream>;   // SttStream: sendAudio(bytes), close()
type SttEvent = ready | partial{text} | committed{text} | warning{error} | closed{error?}
```

`partial` = نص جزئي أثناء الكلام. `committed` = نص نهائي لجملة انتهت (حسب صمت VAD عند المزود).

### 4.3 `TextToSpeech` (`ports/text-to-speech.ts`)

```ts
open({format, log}): Promise<TtsSession>;
TtsSession.speak({ utteranceId, text: AsyncIterable<string>, signal }): AsyncIterable<TtsAudioChunk>;
TtsAudioChunk = { data: Uint8Array; text?: string }   // text = الحروف التي يغطيها هذا المقطع (alignment)
```

اتصال TTS واحد طويل لكل جلسة، وكل جملة لها "context" خاص. النص يدخل كتيار (segments) والصوت يطلع كتيار بالتوازي.

### 4.4 `LanguageModel` (`ports/language-model.ts`)

```ts
stream(request: LlmRequest, { signal }): AsyncIterable<LlmEvent>;
LlmRequest = { instructions: string; messages: ConversationItem[]; tools?: ToolSpec[]; toolChoice?: 'auto'|'none' }
ConversationItem = ChatMessage{role,text} | ToolExchange{calls, results, continuation?}
LlmEvent = {type:'text_delta', text} | {type:'completed', toolCalls?, continuation?}
```

- `ModelContinuation { provider, model, items }`: حالة المزود **مبهمة** (opaque). المنطق يخزنها ويعيدها كما هي داخل نفس دور المتصل، لكن ما يفسرها أبدًا.
- حدث `completed` يحمل `toolCalls` فقط إذا النموذج طلب أدوات.

### 4.5 `SchedulingSystem` (`ports/scheduling.ts`)

تسع عمليات، كلها تأخذ `SchedulingContext { tenant, signal, correlationId? }`:

| العملية | ترجع | ملاحظة |
|---|---|---|
| `searchDirectory(ctx, {text?, kind, serviceId?, limit})` | خدمات/أطباء مرتبين بالأفضل | `kind`: service / practitioner / any |
| `findAvailability(ctx, {serviceId, practitionerIds?, from, to, limit, ignoreAppointmentId?})` | slots | نافذة ≤ 14 يوم، الماضي لا يرجع |
| `findPatients(ctx, {nationalId?, phone?})` | مرشحون فقط | **التحقق (تاريخ الميلاد) شغل مُجيب، مو المحول** |
| `registerPatient(ctx, {patient, idempotencyKey})` | `PatientRecord` | `already_exists` لو الهوية مسجلة |
| `getAppointment(ctx, id)` | `AppointmentRecord` | فيه `version?` |
| `listAppointments(ctx, {patientId, from?, statuses?})` | مواعيد مرتبة | الافتراضي booked+pending |
| `book(ctx, {patientId, slot, idempotencyKey})` | موعد | **يتحقق من التوفر ذريًا وقت التنفيذ** |
| `reschedule(ctx, {appointmentId, newSlot, idempotencyKey})` | موعد | نفس الـID بوقت جديد |
| `cancel(ctx, {appointmentId, reason?, idempotencyKey})` | موعد | |

دلالات الأخطاء (مكتوبة في تعليق الملف):

- نتيجة عمل (مثل "الوقت انحجز"، "غير موجود") ← `SchedulingError`.
- فشل نقل أو نظام (auth، timeout، unavailable) ← `ProviderError`.
- إلغاء الـsignal ← يرفض بسبب الإلغاء.

الـ`AvailableSlot.token` نص مبهم يخص المحول (يحمل كل ما يلزم لحجز هذا الوقت بالضبط). الـIDs الحقيقية للمستشفى **تبقى في الخادم** ولا تُعرض للنموذج أبدًا.

---

## 5. رحلة الصوت بالبايتات

### 5.1 من الميكروفون إلى المحرك

```
ميكروفون المتصفح
  → getUserMedia({echoCancellation, noiseSuppression, autoGainControl, channelCount:1})
  → AudioContext (sampleRate 16000 إن أمكن)
  → AudioWorklet 'capture-processor' (web/dev-client/capture-worklet.js)
        • يحوّل float → PCM16 (little-endian، mono)
        • لو معدل الجهاز أعلى من 16kHz: تخفيض بمتوسط العينات (box filter)
        • يرسل إطارًا كل 20ms = 320 عينة = 640 بايت
  → WebSocket (binary) إلى /ws
  → BrowserWsTransport.onMessage (src/adapters/transports/browser-ws-transport.ts)
        • يرفض الإطار إذا: فارغ، أو طوله فردي، أو > 32,000 بايت (MAX_CLIENT_AUDIO_FRAME_BYTES)
        • يحوّله إلى TransportEvent {type:'audio', data}
  → VoiceSession.onAudio
```

### 5.2 داخل `onAudio`

1. `counters.framesIn++`.
2. إذا الترميز `pcm16`: يمر الإطار على `EnergyVad` (قسم 6.4) لقياس بداية ونهاية كلام المتصل (للقياس فقط).
3. **وضع half-duplex:** إذا `duplexMode === 'half'` وكانت الحالة `speaking` أو داخل "ذيل الصدى" (`withinEchoTail`)، يُرسل للـSTT **صمت** (بايتات أصفار بنفس الطول) بدل صوت المايك. الهدف إبقاء التوقيت وعدم التقاط صوت مُجيب نفسه.
4. `bufferForStt`: يجمع الإطارات في مخزن إلى أن يبلغ `sttChunkMs` (الافتراضي 100ms = 3,200 بايت) ثم يرسلها دفعة واحدة لـ`sttStream.sendAudio`. إذا ما فيه stream مفتوح (إعادة اتصال) يُعد الإطار `framesDroppedNoStt`.

### 5.3 STT (ElevenLabs، `adapters/elevenlabs/realtime-stt.ts`)

- WebSocket إلى `/v1/speech-to-text/realtime` مع query: `model_id`, `audio_format`, `commit_strategy`, `language_code`, `vad_silence_threshold_secs`, و`enable_logging=false` عند طلب zero retention. المفتاح في header `xi-api-key`.
- كل دفعة صوت تُرسل كرسالة JSON `input_audio_chunk` بـbase64 مع `commit: false`.
- الرسائل الواردة (تُفحص بـzod): `session_started` → `ready`؛ `partial_transcript` → `partial`؛ `committed_transcript` → `committed`؛ `warning`؛ وأنواع أخطاء تُحوَّل عبر جدول `ERROR_TYPES` إلى `ProviderError` مع تحديد هل هي fatal.
- عند `session_started` تقارن `checkEffectiveConfig` ما طلبناه بما طبّقه الخادم، وتسجل `stt.config_mismatch` عند الاختلاف (هكذا اكتشفنا أن zero retention ما يشتغل على خطة Starter وأن `turn_prediction` مرفوض).

### 5.4 من النص إلى الصوت

```
LLM text_delta  →  chunkText (voice/text-chunker.ts)  →  segments
  →  ElevenLabsTtsSession.speak(): يرسل كل segment {text, context_id, flush:true}
  →  الخادم يرد chunks {audio(base64), alignment.chars}
  →  VoiceSession.speak(): sendAudio(epoch, bytes) + sendMark(epoch, "epoch:index")
  →  BrowserWsTransport.sendAudio: إطار binary = [uint32 LE epoch][PCM16]
  →  المتصفح: onServerMessage → player-worklet.js
```

- **تقطيع النص** (`chunkText`): يقص عند علامات `. ! ? ؟ ؛ ; : ، , …` إذا تلتها مسافة (فلا يُقص "10:30"). القطعة الأولى أقصر (`firstMinChars: 12`) لتبدأ بسرعة، والباقي `minChars: 30`، والحد الأقصى `maxChars: 200`. والثابت الخاص `CHUNK_FLUSH` يجبر المقطّع على إخراج ما عنده فورًا (يُستخدم لعبارة الانتظار قبل الأدوات).
- **TTS** (`multi-context-tts.ts`): اتصال واحد لكل جلسة، `context_id = utteranceId` (يعني `turn.id`). الإلغاء: `close_context` عند المزود + فشل الطابور محليًا + تجاهل أي صوت متأخر لسياق مغلق (`closedContexts`).
- **صيغة الإطار للمتصفح:** أول 4 بايتات = `epoch` (uint32 little-endian) ثم PCM16 (`AUDIO_EPOCH_HEADER_BYTES = 4`).

### 5.5 التشغيل في المتصفح (`player-worklet.js`)

طابور مرتب من عناصر `audio` و`mark`، كلها موسومة بـepoch:

- `audio`/`mark` بـepoch أقل من `minEpoch` تُرمى (صوت قديم لدور أُلغي).
- عند الوصول لمارك في الطابور، يرسل للمحرك `{type:'mark', name}` (هذا "ما انسمع فعلًا").
- أول عينة من epoch جديد ← `{type:'started', epoch}`.
- `clear`: يرفع `minEpoch = epoch + 1`، يفلتر الطابور، يصفّر الموضع، يرد `{type:'cleared', epoch}`.
- `pause`/`resume`: يمسك الطابور بدون حذفه (للمقاطعة المؤقتة).
- إعادة أخذ العينات بالاستيفاء الخطي إذا معدل الجهاز يختلف عن 16kHz.

---

## 6. `VoiceSession`: قلب النظام

الملف `src/voice/session.ts` (~980 سطر). هو الجزء الوحيد الذي يعرف الصوت والتوقيت معًا.

### 6.1 الحالات والثوابت

```ts
SessionState = 'starting' | 'listening' | 'thinking' | 'speaking' | 'closed'
```

**القاعدة (invariant) المكتوبة في الكود:** `current !== null` إذا وفقط إذا الحالة `thinking` أو `speaking`.

الحقول الأساسية:

| الحقل | وظيفته |
|---|---|
| `current: ActiveTurn \| null` | الدور الجاري (رد مُجيب) |
| `epochCounter` / `activeEpoch` | رقم الـepoch لكل رد. الصوت يُمرر فقط لو `activeEpoch === turn.epoch` |
| `pendingTimeline` | قياسات كلام المتصل قبل ما يبدأ الدور فعليًا |
| `carryOverUserText` / `carryOverUserTurn` | كلام متصل لدور أُلغي لأنه كمّل كلامه، ويُدمج مع الجملة التالية |
| `userTurnCounter` | رقم جملة المتصل (1، 2، …). **تأكيدات الحجز ترتبط بهذا الرقم** |
| `lastAgentRun` | آخر دور فيه أدوات (قد تنتهي كتاباته بعد انتهاء الدور) |
| `conversation` | سجل المحادثة (قسم 7) |
| `awaitingClearAck` | أدوار قوطعت وننتظر تأكيد المتصفح أنه فرّغ الصوت |

`ActiveTurn` يحمل: `id`, `kind` (`'user'|'greeting'`), `userTurn`, `epoch`, `controller` (AbortController)، `timeline`، `sentText` (كل ما أُرسل للـTTS)، `alignedText` (ما أرجعه TTS كحروف)، `heardText` (النص حتى آخر مارك مؤكد)، `markText` (خريطة index → النص التراكمي)، `lastSentMarkIndex` / `ackedMarkIndex`، `audioMsSent`، `paused`، `falseInterruptions`.

### 6.2 `start()` و`close()`

- `start()`: يضبط معالج الـtransport، يفتح STT، الحالة `listening`، يسخّن TTS في الخلفية (`prewarmTts`)، وإذا فيه `greeting` يبدأ دورًا من نوع `greeting` بنص ثابت (بدون نموذج).
- `close(reason)`: يضبط `closed`، يلغي `lifetime`، يلغي الدور الجاري، يفرّغ المؤقتات، يغلق transport وSTT وTTS، **ثم** ينتظر `tools.drain(timeout)`: الكتابات التي أكدها المتصل تكتمل وتُسجل حتى لو انتهت المكالمة.

### 6.3 دورة الدور الواحد (الطريق السعيد)

```
(1) الصوت يصل → onAudio → VAD + STT
(2) STT 'partial'  → onPartial → emit user_partial + mark stt_first_partial
(3) STT 'committed' → onCommitted → startUserTurn(text)
(4) startUserTurn: يدمج carryOver، يعلّم stt_committed، beginTurn('user')
(5) beginTurn: ينشئ ActiveTurn جديد (epoch++)، الحالة thinking، runTurn()
(6) runTurn: المصدر = tools ? agentText() : llmText()   [أو نص ثابت للتحية]
(7) speak(): chunkText(source) → tts.speak() → لكل chunk: sendAudio + sendMark
        أول chunk: mark tts_first_audio + الحالة speaking
(8) waitForPlayback: ينتظر تأكيد آخر مارك (أو مهلة audioMsSent + playbackGraceMs)
(9) completeTurn: mark playback_end، commitHistory، الحالة listening، finalizeTurn
```

تفاصيل مهمة في (7): كل chunk يمر على فحص `signal.aborted || activeEpoch !== turn.epoch`؛ إذا فشل الفحص يُحسب `staleChunksDropped` ويتوقف الإرسال.

مصدر النص حسب الوضع:

- **بدون أدوات** `llmText()`: طلب واحد `conversation.request(userText)` ثم بث `text_delta` مع مهلة أول token (`llmFirstTokenTimeoutMs`، افتراضي 8000).
- **مع أدوات** `agentText()`: يستدعي `prepareAgentTurn` (قسم 6.8) ثم ينشئ `AgentTurn` (قسم 8) ويقرأ من `agent.output`: النص يُمرر، و`{type:'pause'}` يتحول إلى `CHUNK_FLUSH`.

### 6.4 `EnergyVad` (`voice/energy-vad.ts`)

كاشف طاقة (RMS بالديسيبل) بحد أدنى متكيف مع الضجيج:

- `thresholdDb: -48`، `noiseMarginDb: 10`، `minSpeechMs: 100`، `hangoverMs: 300`.
- يرسل `speech_start` و`speech_end` مع "قبل كم ms حصل".
- **لا يقرر الأدوار.** الأدوار يحددها STT. الـVAD المحلي للقياس فقط: `user_speech_start/end` (لحساب `e2e_ms`) و`barge_in_speech_start`. وفي حالة المقاطعة المؤقتة يُستخدم `vad.isSpeaking` لتمديد الانتظار (6.6).

### 6.5 الأحداث الصادرة (`SessionEvent`)

`state`, `stt_ready`, `user_partial`, `user_committed`, `assistant_segment`, `barge_in`, `turn_summary`, `counters`, `warning`, `error`, `timeline`, `transport`, `pending_reset`, `tool`. تمر كلها عبر `observer` إلى المتصفح للعرض.

### 6.6 المقاطعة (Barge-in)

عند وصول نص STT أثناء الحالة `speaking` يُستدعى `handleSpeakingTranscript` الذي يستدعي `evaluateBargeIn` (`voice/barge-in-policy.ts`، دالة نقية):

| القرار | الشرط (حسب الكود) |
|---|---|
| `ignore` / `empty` | لا كلمات بعد التطبيع |
| `ignore` / `backchannel` | كل الكلمات من قائمة المجاملة (اه، ايه، طيب، تمام، صح، …) |
| `ignore` / `echo` | ≥ كلمتين ونسبة تطابقها مع نص مُجيب `echoOverlapRatio` (0.6) أو أكثر؛ أو كلمة واحدة **نهائية** موجودة ضمن آخر 8 كلمات نطقها مُجيب |
| `candidate` / `short` | نص جزئي بكلمة واحدة (غير مجاملة وغير صدى) |
| `interrupt` / `speech` | نص نهائي، أو جزئي بكلمتين فأكثر (`minInterruptWords: 2`) |

التطبيع (`core/arabic-text.ts` `normalizeArabic`): يشيل التشكيل والتطويل، يوحّد الهمزات (أ إ آ ← ا) والتاء المربوطة (ة ← ه) والألف المقصورة (ى ← ي)، يحوّل الأرقام العربية/الفارسية لـASCII، يشيل الترقيم، ويدمج الحروف المكررة ("اااه" ← "اه").

**الإجراءات:**

1. **`softPause` (candidate):** `transport.pause()` (لو مدعوم)، يحفظ النص المرفوض في `dismissedTranscript`، ويضبط مؤقتًا `falseInterruptionTimeoutMs` (1500). إن لم تتأكد المقاطعة ينتهي المؤقت.
2. **`resumeAfterFalseInterruption`:** عند انتهاء المؤقت يستأنف الصوت (`transport.resume()`) ويحسب `falseInterruptions`. لكن إذا الـVAD المحلي ما زال يسمع المتصل (النص الجزئي قد يتأخر أكثر من ثانية) يعيد المحاولة كل 250ms حتى 2× المهلة.
3. **`interrupt(turn, reason)` — أربع حمايات بنفس اللحظة:**
   - (أ) `activeEpoch = null` ← الجلسة ترمي أي chunk يصل متأخرًا لهذا الدور.
   - (ب) `transport.clear(epoch)` ← المتصفح يفرّغ ما عنده فورًا.
   - (ج) `controller.abort()` ← يلغي طلب النموذج وسياق TTS.
   - (د) في المتصفح: الـepoch القديم يُرمى (`minEpoch`).
   ثم `commitHistory(turn, true)`: يسجل في السجل **فقط ما سمعه المتصل** (`heardText` من alignment) مع علامة `[قاطعه المتصل هنا]`، ويضع الدور في `awaitingClearAck` إلى أن يؤكد المتصفح `playback_cleared` أو تنتهي مهلة `clearAckTimeoutMs` (1000).
4. **`cancelTurn` (reason `user_continued`):** إذا المتصل **كمّل كلامه أثناء `thinking`** (قبل بدء الصوت): الدور يُلغى، ونصه يُحفظ في `carryOverUserText` ليُدمج مع الجملة التالية، وبنفس رقم `userTurn`. **استثناء مهم:** إذا الدور الملغى كان قد بدأ كتابة (`agent.sideEffects`)، لا يُدمج؛ يُسجل كما هو (`commitAgentTurn`) عشان ما يُعاد تنفيذ شي.

**ذيل الصدى:** خلال `echoTailMs` (1200) بعد انتهاء كلام مُجيب، أي نص نهائي يطابق آخر رد (`isEchoOf`) يُتجاهل ولا يصير دورًا.

### 6.7 ما "سمعه" المتصل فعلًا

- `onMark(name)`: يستخرج `epoch:index`، ويحدّث `ackedMarkIndex` و`heardText = markText.get(index)`.
- `markText[index]` = `alignedText` التراكمي وقت إرسال ذلك المقطع (حروف أرجعها TTS).
- `playedText(turn)`: إذا فيه alignment ← `heardText`؛ وإلا ← كل `sentText` فقط إذا كل المارks أُكدت، وإلا نص فارغ.
- في `finalizeTurn` يُمرر هذا إلى `tools.onTurnFinalized(turnId, heardAnything, playedText)`. **هذا أساس شرط "المتصل لازم يسمع القراءة كاملة قبل أي تنفيذ"** (قسم 10).

### 6.8 إعادة اتصال STT

عند حدث `closed` من STT: إذا الخطأ غير قابل لإعادة المحاولة أو استُنفدت المحاولات (`maxAttempts: 4`) تُغلق الجلسة؛ وإلا إعادة اتصال بتأخير أسي: `baseDelayMs (250) × 2^attempt`. كل stream له رقم `generation` لتجاهل أحداث stream قديم.

### 6.9 `prepareAgentTurn` — قبل كل دور فيه أدوات

1. إذا الدور السابق ما انتهى (`agent.finished` false) ينتظر `agent.done` (مع إمكانية الإلغاء).
2. `recordLateExchanges`: إذا انتهت جولات أدوات بعد ما أُغلق الدور السابق (مثلًا كتابة جارية وقت المقاطعة)، تُضاف للسجل **قبل** الدور الجديد.
3. `tools.reconcileUnresolved()`: يعيد محاولة حسم أي كتابة نتيجتها `unknown`.
4. يرجع ملاحظات نظام بالعربي ("تحديث من النظام: تأكدنا الآن أن الإجراء C1 (booking) تم تنفيذه فعلًا…") تدخل في سياق الطلب التالي للنموذج.

### 6.10 `finalizeTurn` و`TurnSummary`

كل دور ينتهي بـ`outcome`: `completed | interrupted | cancelled | error`، ويُكتب سطر JSON واحد (`turn.summary`) فيه: `marks_ms` (علامات الوقت النسبية)، `durations_ms` (المدد المحسوبة)، `llm_rounds`، `tool_calls[{name, outcome, ms}]`، `false_interruptions`، وعدد الحروف. **النص نفسه لا يُكتب** إلا لو `MUJEEB_LOG_TRANSCRIPTS=true`.

---

## 7. سجل المحادثة وطلبات النموذج اللغوي

### 7.1 `Conversation` (`agent/conversation.ts`)

حالة المحادثة **ملك مُجيب**، مو ملك OpenAI (يرسل `store: false` ويعيد إرسال السجل كل طلب).

- `items: ConversationItem[]` = رسائل نصية + `tool_exchange` مضغوطة.
- **الرسالة لا تُسجل إلا لما ينتهي دورها** (`commitTurn`): فلا يبقى نصف دور أو رسالة يتيمة لو الدور أُلغي.
- `addAssistant(text, {interrupted})`: يضيف ` [قاطعه المتصل هنا]` لو المقاطعة، عشان النموذج يعرف أن المتصل ما سمع الباقي.
- **القص بالأدوار:** `push` يحذف أقدم دور كامل (وما قبله) كلما زاد عدد رسائل المستخدم عن `maxTurns` (من الـprofile، افتراضي 12). فلا يضيع ناتج أداة عن رسالة المستخدم الخاصة به.
- `request(pendingUser, {currentTurn, tools, toolChoice, context})`: يبني `LlmRequest`:
  - `messages` = السجل المحفوظ + الرسالة المعلقة + جولات الأدوات الجارية (مع `continuation` كاملة).
  - `instructions` = تعليمات العيادة + `context` (سطر التاريخ الآن والمرضى المتحقق منهم + ملاحظات النظام).
- `assertComplete`: أي `tool_exchange` فيه call بدون result يرمي خطأ. **ما يُرسل call بدون ناتجه أبدًا.**

### 7.2 محول OpenAI (`adapters/openai/responses-model.ts`)

- `client.responses.create({ stream: true, store: false, ... })`.
- **الحد الأقصى للـtokens:** `maxOutputTokensWithTools` (افتراضي 1024) عند وجود أدوات، وإلا `maxOutputTokens`.
- مع الأدوات: `tools` بصيغة `strict: true`، و`parallel_tool_calls: false` (أداة واحدة في الجولة)، و`tool_choice` من الطلب.
- **أحداث البث:**
  - `response.output_text.delta` ← `text_delta` فورًا (لا تأخير على TTS).
  - `response.output_item.done` ← يخزن العنصر النهائي حسب `output_index` (هنا يكون `encrypted_content` نهائيًا).
  - `response.completed` ← `completion(output)`: يستخرج `function_call`، وإذا وُجدت يُرفق `continuation {provider, model, items}`.
  - `response.incomplete` (مثلًا نفاد tokens) ← `completed` بدون أدوات: **ما ننفذ أداة من رد مقطوع** لأن وسائطها قد تكون ناقصة.
  - `response.failed` / `error` ← `ProviderError` بنوع مناسب (quota، rate_limit…).
- **منع التكرار:** أحيانًا يكرر النموذج رسالة `commentary` حرفيًا في `final_answer`؛ الكود يحجز الثانية حتى تكتمل ويحذفها إن طابقت.
- **`toInput`** (تحويل سجل مُجيب إلى مدخلات OpenAI):
  - رسالة نصية ← `{role, content}` (ومع `assistantPhase` تُضاف `phase: 'final_answer'` لرسائل المساعد).
  - `tool_exchange` **لنفس النموذج ونفس المزود:** يعيد `continuation.items` **حرفيًا وبالترتيب** (reasoning، message، function_call) بعد حذف reasoning بلا `encrypted_content` وحذف أي function_call بلا نتيجة، ثم `function_call_output` لكل call.
  - غير ذلك (دور سابق، أو تغير النموذج): يبني `function_call` من البيانات الموحدة بدون reasoning.
- `normalizeError`: يحوّل أخطاء SDK إلى `ProviderError` (`timeout`, `unavailable`, `quota`, `auth`, `rate_limit`, `bad_request`…) ويفرق إلغاءنا المتعمد عن الأخطاء.
- إعادة المحاولة: `maxRetries: 1` للطلب الأولي فقط، والمهلة 30 ثانية.

---

## 8. `AgentTurn`: حلقة النموذج ↔ الأدوات

الملف `src/agent/agent-turn.ts`. لا يعرف شي عن الصوت. يعمل **كمهمة مستقلة** (`this.done = this.run()`) بحيث الجلسة تقدر تتوقف عن الاستماع لمخرجاته (مقاطعة) بينما شغل لازم يكتمل (كتابة مؤكدة) يكمل.

### 8.1 الواجهة مع الجلسة

`AgentToolbox` (ينفذها `AppointmentTools`): `definitions()`, `execute(name, rawArgs, turnCtx)`, `mutates(name)`, `contextNote()`, `onTurnFinalized(...)`, `reconcileUnresolved()`, `drain(ms)`.

المخرجات: `output: AsyncQueue<AgentOutput>` حيث `AgentOutput = {type:'text', text} | {type:'pause'}`.

### 8.2 الحلقة (`run()`)

```
context = tools.contextNote() + notes (ملاحظات النظام)
for round = 0; !aborted; round++:
    mayCallTools = round < maxToolRounds           // افتراضي 5
    request = conversation.request(userText, { currentTurn: this.exchanges, tools, 
                                               toolChoice: mayCallTools ? 'auto' : 'none', context })
    completion = await streamRound(request)        // النص يُدفع للـoutput أثناء البث
    calls = mayCallTools ? completion.toolCalls : []
    if no calls: break
    
    إذا ما قال النموذج شي بعد وفيه waitPhrase: output.push(text: waitPhrase)  // "لحظة أشيك لك."
    output.push({type:'pause'})                    // الجلسة تحوله CHUNK_FLUSH ليُنطق ما عندنا فورًا
    
    for call of calls:
        if aborted: break
        if mutates(call.name) و graceMs>0: await sleep(graceMs, signal)   // 400ms، يُلغى لو المتصل كمّل
        if mutates: this.sideEffects = true
        ran = await runTool(call)
        results.push(...); if ran.speech: speech.push(...)
    
    exchanges.push({ type:'tool_exchange', calls: answered, results, continuation? })
    
    if speech.length > 0 && !aborted:
        systemSpeech.push(...speech)
        output.push(text: speech.join(' '))        // الكلام الرسمي، حرفيًا
        break                                       // الدور ينتهي: النموذج ما يحصل جولة بعده
```

### 8.3 نقاط تصميم مهمة

- **`maxToolRounds`:** بعد الحد، الجولة التالية بـ`toolChoice: 'none'` (الأدوات تبقى ظاهرة للسياق لكن لازم يرد بنص).
- **مهلة أول حدث** لكل جولة (`firstEventTimeoutMs`): تُلغى عند أول حدث، وإلا `ProviderError('timeout')`.
- **الكلام الرسمي (authoritative speech):** إذا نتيجة أداة فيها `speech` (قراءة تأكيد، أو نتيجة كتابة)، `AgentTurn` ينطقها هو بنفسه حرفيًا وينهي الدور. **النموذج ما يصوغ تاريخًا ولا وقتًا أبدًا بعد ذلك.** (سبب إضافتها: النموذج قال مرة "خمسطعش أكتوبر" لموعد يوم 13.)
- **الجولة الجزئية:** إذا أُلغي الدور في منتصف جولة، `exchange` يُسجل فقط للـcalls التي أُجيبت، وبدون `continuation` (لأن عناصر المزود تذكر calls غير مجابة ولا تصلح للإعادة).
- **`runTool`:** يستدعي `tools.execute`، يقيس المدة، ويرسل أحداث `tool` (`start`/`end`) للواجهة. المخرجات للنموذج `JSON.stringify(result.output)`، و`speech` يُعاد منفصلًا.

---

## 9. `AppointmentTools`: أدوات المواعيد

الملف `src/agent/tools/appointment-tools.ts` (~810 سطر). **نسخة لكل جلسة.**

### 9.1 مكوناتها الداخلية

| المكون | الملف | وظيفته |
|---|---|---|
| `SessionRefs` | `session-refs.ts` | مراجع قصيرة للنموذج بدل IDs الحقيقية |
| `DevIdentifierDobVerification` | `patient-verification.ts` | التحقق (هوية/جوال + تاريخ ميلاد) |
| `PendingActions` | `pending-actions.ts` | الإجراء المعلق وقواعد التأكيد |
| `WriteLedger` | `write-ledger.ts` | سجل الكتابات والحسم |
| `confirmation-classifier` | `confirmation-classifier.ts` | فهم "إيه/لا/..." من كلام المتصل |
| `spoken-arabic` | `spoken-arabic.ts` | صياغة التاريخ والوقت والأرقام بالسعودي |
| `normalize` + `core/phone` | | تنظيف الهوية والجوال وتاريخ الميلاد |

### 9.2 مسار `execute(name, rawArguments, turn)`

```
1. الاسم غير معروف أو خارج allowlist  → { status: 'unknown_tool' }
2. parseToolArguments (zod strictObject) → فشل: { status: 'invalid_arguments', problem }
3. dispatch(name, input, turn) داخل try/catch:
     ToolRejection (رفض متوقع)  → { status, hint, ...extra }
     خطأ إلغاء والـsignal ملغي  → يُرمى (الدور مهجور)
     غير ذلك                    → failure(err)  → system_timeout | system_unavailable | not_found | rejected
4. يسجل tool.call (اسم، نتيجة، مدة) ويرجع { output, outcome, speech? }
```

**لا يرمي أبدًا بسبب مشكلة أداة.** كل نتيجة تتحول لـJSON مختصر للنموذج فيه `status` و`hint` (نصيحة بالإنجليزي للنموذج عن الخطوة التالية).

`speech` يمر **بمفتاح Symbol** (`SPEAK`) داخل الـoutput. `JSON.stringify` يتجاهل مفاتيح Symbol، فالنموذج لا يرى الجملة الرسمية كحقل، لكن `AgentTurn` يلتقطها.

### 9.3 المراجع القصيرة (`SessionRefs`)

بادئات: `V` خدمة، `D` طبيب، `S` وقت (slot)، `P` مريض، `A` موعد. (والإجراءات المعلقة `C1`, `C2`… من `PendingActions`.)

- `register(kind, value)`: نفس الكيان (نفس الـID أو نفس token الـslot) يأخذ نفس المرجع طول الجلسة.
- `resolve(kind, ref)`: يرجع القيمة الحقيقية **فقط** إذا المرجع من نفس النوع. مرجع مخترع أو من نوع غلط ← `undefined` ← `ToolRejection('unknown_ref')`.
- **المرضى والمواعيد لا يأخذون مرجعًا إلا بعد التحقق**: `verifiedPatient()` و`ownedAppointment()` تتحققان `verification.isVerified(patientId)`.

### 9.4 الأدوات التسع (ملخص المنطق)

**القراءة:**

| الأداة | المنطق |
|---|---|
| `search_clinic_directory` | تحل `service_ref` لو موجود، تستدعي `searchDirectory` بـ`limit = maxResults (5)`، وترجع `ref` + اسم (+ جنس وخدمات للأطباء) + `more` |
| `search_available_slots` | تحل service/practitioner، تفحص التواريخ (`isLocalDate`)، تجعل `from` ≥ اليوم، وتقص النافذة إلى 14 يوم. إذا `part_of_day` موجود: **نافذة لكل يوم** (حتى لا يزاحم صباح مزدحم المساء المطلوب). الفترات: morning `[0,720)` دقيقة، afternoon `[720,1020)`، evening `[1020,1440)`. كل slot يرجع بـ`ref` + `date/weekday/time` + `spoken` + الطبيب |
| `find_patient` | تطبع الهوية والجوال وتاريخ الميلاد، تبحث عبر `findPatients`، وتقيّم بـ`verification.evaluate` (قسم 9.5) |
| `list_patient_appointments` | `verifiedPatient(patient_ref)` ثم `listAppointments`، حتى 10 مواعيد |

**الاقتراحات** (لا تغيّر أي شي، تخزن إجراءً معلقًا):

| الأداة | شروطها قبل الاقتراح |
|---|---|
| `propose_registration` | الهوية 10 خانات صحيحة، جوال صالح، تاريخ ميلاد صالح؛ ما فيه كتابة غير محسومة لنفس الهوية؛ جملة القراءة تذكر الاسم والهوية والجوال **خانة خانة** وتاريخ الميلاد |
| `propose_booking` | مريض متحقق منه؛ slot معروف؛ **الوقت لم يمض**؛ لا فحص توفر هنا (يُفحص وقت التنفيذ) |
| `propose_reschedule` | موعد يخص مريضًا متحققًا منه؛ نفس الخدمة (`service_change_not_allowed` وإلا)؛ الوقت لم يمض؛ يختلف عن الحالي (`same_time`)؛ يخزن `version` الموعد |
| `propose_cancellation` | موعد مملوك؛ `reason` اختياري؛ يخزن `version` |

كل اقتراح ينتهي بـ`propose(target, readBack, speech, turn)` ← `PendingActions.propose` ← تسجيل `tool.audit` ← يرجع `status: 'confirmation_required'` + `[SPEAK]: speech`.

**التنفيذ:** `confirm_pending_action` ← قسم 10.

### 9.5 التحقق من المريض (`patient-verification.ts`)

السياسة `dev-identifier-dob` — **للتطوير فقط** (`productionGrade = false`):

- `evaluate(candidates, birthDate)`:
  - إذا `locked` (فشل ≥ 3) ← `locked`.
  - المطابقات = المرشحون الذين `birthDate` مثل المدخل. واحد بالضبط ← `verified` ويُحفظ في `verified` map؛ أكثر من واحد ← `multiple` (يطلب الهوية)؛ صفر ← `failures++` ثم `not_verified` أو `locked`.
- **نفس الرد لـ"غير موجود" و"تاريخ ميلاد خطأ"** حتى لا يُستخدم النظام لتخمين وجود مرضى.
- `not_verified` يرجع `checked` (ما استلمناه فقط، منطوقًا خانة خانة) ليقرأه مُجيب على المتصل فيصحح، لأن STT قد يُسقط رقمًا.
- المريض المسجل في نفس الجلسة (`markRegistered`) يُعد متحققًا منه.

### 9.6 `contextNote()` — يُضاف لكل طلب

سطر بالعربي: "التاريخ والوقت الآن في العيادة: <يوم> <تاريخ>، الساعة <وقت> (<المنطقة>)…" (عشان يفهم النموذج "بكرة" و"الأحد الجاي")، وإذا فيه مرضى متحقق منهم: قائمة بمراجعهم وأسمائهم الأولى مع نصيحة ألا يطلب الهوية مرة ثانية (إصلاح لخطأ لوحظ في الاختبار الحي).

### 9.7 صياغة الكلام (`spoken-arabic.ts`)

كل تاريخ ووقت يُطلب من المتصل تأكيده يُصاغ **بالكود** من السجل نفسه:

- `numberWords(n)` 0–9999 بالصيغ السعودية (ثلطعش، سطّعش، ستّين، مية…).
- `spokenDate`: "الثلاثاء ثلطعش أكتوبر" (والسنة فقط لو ليست الحالية).
- `spokenTime`: نظام 12 ساعة مع صباحًا/ظهرًا/مساءً فقط ("منتصف الليل" للـ00:00)، ولا "العصر" ولا "المغرب" (لأن الناس تفهمها بتوقيتات مختلفة). التشكيل اختير بتجارب TTS←STT ("ثُلث" وإلّا).
- `spokenDigits`: الأرقام خانة خانة للهوية والجوال.
- `spokenDoctor`: "الدّكتور/الدّكتورة" حسب الجنس.

---

## 10. أمان الكتابة: التأكيد، السجل، المطابقة

هذا أهم جزء في المرحلة 1. الفكرة: **النموذج اللغوي ما يقدر ينفذ حجزًا بنفسه.** الخادم يفرض كل الشروط.

### 10.1 تسلسل حجز كامل (دورين)

```
=== الدور N: المتصل يقول "أبي موعد جلدية يوم الثلاثاء" ===
LLM جولة 1  → tool: search_clinic_directory   → V1 (الجلدية)
LLM جولة 2  → tool: search_available_slots    → S1, S2, S3
   (عبارة الانتظار "لحظة أشيك لك." نطقها النظام قبل الأدوات إن ما تكلم النموذج)
LLM جولة 3  → رد نصي: يعرض أوقاتًا (spoken من النتائج)
المتصل: "الأول"  [دور N+1 يبدأ... في مثالنا نختصر]
LLM → tool: find_patient (هوية + تاريخ ميلاد) → P1 verified
LLM → tool: propose_booking(P1, S1)
   النظام: PendingActions.propose → C1 {target: booking, patientId, slot}
   النظام يرد speech: "للتأكيد: موعد عبدالله في الجلدية مع الدّكتورة سارة الغامدي،
                       يوم الثلاثاء ثلطعش أكتوبر، الساعة أربع مساءً. أثبّت الحجز؟"
   AgentTurn ينطقها حرفيًا وينهي الدور (لا جولة LLM بعدها)
   finalizeTurn → pending.onTurnFinalized(turnId, heardAnything, playedText)
        → action.heard = (النص المسموع يحتوي الجملة كاملة بلا تاريخ/وقت آخر)

=== الدور N+1: المتصل يقول "إيه ثبّته" ===
LLM → tool: confirm_pending_action(action_ref: "C1", caller_answer: "yes")
   AgentTurn: mutates → ينتظر 400ms (لو المتصل كمّل كلامه يُلغى الدور قبل أي تغيير)
   AppointmentTools.confirm:
      pending.confirm(...)  (الفحوص في 10.2)
      المريض لا يزال متحققًا منه؟
      (تعديل/إلغاء) قراءة الموعد وفحص version والمالك والحالة → stale_action لو تغير
      ledger.execute(...)   // الكتابة تنفذ بمهلتها الخاصة
   النتيجة → "تم الحجز: موعد عبدالله في الجلدية مع ... تبي أخدمك بشي ثاني؟" (من سجل المستشفى نفسه)
```

### 10.2 `PendingActions.confirm` — الفحوص بالترتيب

```
1. الإجراء المعلق موجود وبنفس الـref؟        لا  → closed.get(ref) أو 'unknown_action'
2. now > expiresAt (120 ثانية افتراضيًا)؟     نعم → 'expired'
3. userTurn <= armedInUserTurn؟               نعم → 'caller_confirmation_required'  (نفس دور الاقتراح، لا يُستهلك)
4. userTurn > armedInUserTurn + 1؟            نعم → 'expired'  (تأخر أكثر من دور)
5. classification = classifyConfirmation(كلام المتصل الحرفي من STT, نوع العملية)
   decision = resolveConfirmation(classification, caller_answer من النموذج)
6. decision === 'deny'                        → 'declined' (يُغلق الإجراء)
7. !action.heard                              → 'read_back_required'  (لم يسمع القراءة كاملة)
   أو decision === 'unclear'                  → 'confirmation_unclear'
   في الحالتين: إذا reconfirmations >= maxReconfirmations (2) → 'expired'
   وإلا reconfirmations++، armedInUserTurn = الدور الحالي، heard = false، يُمدَّد الانتهاء
   (النظام يعيد قراءة التفاصيل ويسأل مرة ثانية)
8. غير ذلك → close('already_used') وينجح: يرجع الإجراء للتنفيذ
```

حقيقتان: **إجراء معلق واحد لكل جلسة** (`propose` الجديد يغلق السابق بـ`superseded`)، و**الـref يُستخدم مرة واحدة** (`already_used`).

وفي `onTurnFinalized`: إذا الدور اللي اقترح الإجراء ما سُمع منه شي (المتصل قاطع قبل الصوت) ← الإجراء `expired`.

### 10.3 فهم الرد: `classifyConfirmation` + `resolveConfirmation`

`classifyConfirmation(utterance, action)` يقرأ **كلام المتصل الحرفي** (مو كلام النموذج). يطبّع النص، ويصنف كل كلمة:

| الفئة | أمثلة |
|---|---|
| `affirm` | إيه، ايوه، نعم، أكيد، تمام، صح، موافق، ماشي، يناسبني، توكل، + أفعال بلواحق: ثبّت/ثبّته/ثبّتها/ثبّتلي، أكّد، اعتمد، كمّل، نفّذ، سوّي… |
| `weak` | طيب، خلاص، يلا (تقبل فقط إذا ما معها نفي) |
| `deny` | لا، لأ، مو، ابد، مابي، بلاش، انسى… |
| `hedge` | بس، لحظة، انتظر، خلني أفكر، ممكن، غير، بدل، ثاني، هل، وش، كم، متى، لكن… |
| `detail` | أي وقت/يوم/رقم/اسم دكتور (الساعة، بكرة، الأحد، واحد، ثنين، دكتور…) أو أي خانة رقمية |
| `other_verb` | فعل عملية **ثانية** (مثلًا "ألغيه" أثناء تأكيد حجز) |
| `neutral` | مجاملات (الله يعطيك العافية، شكرًا…) |
| `unknown` | أي كلمة خارج القوائم |

ثم القرار (بالترتيب):

1. يوجد deny: مع affirm ← `unclear/mixed`، وبدونه ← `deny`.
2. يوجد hedge ← `unclear/hedge`.
3. يوجد detail ← `unclear/detail_mentioned`.
4. يوجد other_verb ← `unclear/other_action_verb`.
5. يوجد unknown ← `unclear/unknown_words`.
6. affirm أو weak > 0 ← `affirm`.
7. غير ذلك ← `unclear/no_answer`.

وأفعال العملية الخاصة (`ACTION_VERBS`) مرتبطة بالعملية: "احجز" تأكيد للحجز فقط، "الغي" للإلغاء فقط…

**`resolveConfirmation(words, model)`** — الكلمات تحتفظ بحق النقض:

| قراءة الكلمات | قراءة النموذج | القرار |
|---|---|---|
| `deny` | أي شي | `deny` |
| أي شي | `no` | `deny` (إلا لو الكلمات `affirm` ← `unclear`) |
| `affirm` أو (`unclear` بسبب `unknown_words` فقط) | `yes` | **`affirm`** |
| أي شي آخر | | `unclear` |

يعني تنفيذ الحجز يتطلب: النموذج يقرأ "نعم" **و** كلمات المتصل إما فيها تأكيد صريح أو ما فيها إلا كلمات غير معروفة بدون أي تردد أو تفصيل أو نفي. أي "إيه بس خله الساعة خمس" ← `unclear` ← ما ينفذ.

### 10.4 شرط "سمع القراءة كاملة" (`readBackHeard`)

`heard` يصير `true` فقط إذا نص `playedText` (المبني من alignment حتى آخر مارك مؤكد) **يحتوي جملة التأكيد كاملة** (بعد تطبيع وحذف الفراغات)، **ولا** يحتوي أي كلمة تاريخ/وقت إضافية خارجها (أسماء الأيام والأشهر وكلمة "الساعة"). إذا المتصل قاطع في نصف القراءة ← `heard=false` ← أي "إيه" بعدها ترجع `read_back_required` وتُعاد القراءة.

### 10.5 التنفيذ المفصول عن الدور

بعد نجاح `pending.confirm`:

1. إذا العملية غير تسجيل: المريض لازم يكون `isVerified` (وإلا `not_verified`).
2. `ensureNoUnresolvedWrite(patientKey)`: إذا فيه كتابة `in_flight` أو `unknown` لنفس المريض، يحاول حسمها؛ وإن بقيت ← `previous_action_unresolved`.
3. للتعديل والإلغاء: قراءة الموعد (`detachedRead`، مهلتها فقط لا الدور) ومقارنة: نفس المريض، الحالة booked/pending، `version` ما تغير ← وإلا `stale_action`.
4. `idempotencyKey = "<sessionId>:<action.ref>:<fingerprint>"`.
5. `ledger.execute({ run, reconcile })`.

الـ`fingerprint` = أول 16 خانة من `sha256(JSON([tenantId, sessionId, kind, ...الحقول]))`، ويربط الإجراء بالمستأجر والجلسة والعملية والمريض والهدف.

### 10.6 `WriteLedger` (`write-ledger.ts`)

لكل كتابة سجل `WriteEntry { actionRef, kind, patientKey, idempotencyKey, startedAt, status, reconcileAttempts }` بحالات: `in_flight → succeeded | failed | unknown`.

```
execute(spec):
   entry.status = 'in_flight'
   deadline = withDeadline(undefined, writeTimeoutMs)      // لا يرتبط بإلغاء الدور
   try   result = await spec.run(deadline.signal) → 'succeeded'
   catch err:
        فشل قاطع (SchedulingError، أو ProviderError من نوع auth/bad_request/quota/rate_limit)
              → 'failed'   (الخادم رفض قبل أن يفعل شي)
        غير ذلك (timeout، انقطاع، 5xx، رد غير مفهوم)
              → 'unknown' ثم reconcileEntry فورًا
reconcileEntry: يقرأ النظام (spec.reconcile) بمهلة قراءة:
        applied=true → 'succeeded' | applied=false → 'failed' | فشلت القراءة → يبقى 'unknown'
```

- **لا إعادة محاولة تلقائية للكتابة أبدًا.** الحسم بالقراءة فقط.
- `maxReconcileAttempts: 2`: الأولى فورًا، والثانية في بداية الدور التالي (`reconcileUnresolved`) أو قبل أي كتابة جديدة لنفس المريض.
- `blocking(patientKey)`: أي كتابة جديدة لنفس المريض أثناء `in_flight`/`unknown` تُرفض (`previous_action_unresolved`) فما يصير حجز مزدوج بسبب نتيجة غامضة.
- `drain(timeoutMs)`: يُنتظر به إغلاق الجلسة.

**كيف يحسم `reconcileWrite` كل نوع:**

| العملية | القراءة |
|---|---|
| registration | `findPatients({nationalId})` ← يوجد سجل بنفس تاريخ الميلاد والاسم؟ |
| booking | `listAppointments(patient, from=slot.start)` ← موعد بنفس الوقت ونفس الطبيب؟ |
| reschedule | `getAppointment` ← الوقت والطبيب = الجديد والحالة فعالة؟ |
| cancellation | `getAppointment` ← الحالة `cancelled`؟ |

### 10.7 نتائج الأداة للنموذج بعد التنفيذ

| `status` | المعنى |
|---|---|
| `done` | تم، والنظام نطق النتيجة من سجل المستشفى |
| `slot_unavailable` | الوقت انحجز لحظة التنفيذ، لا تغيير؛ ابحث من جديد |
| `stale_action` | الموعد تغير؛ اقرأ المواعيد من جديد |
| `already_exists` | الهوية مسجلة مسبقًا |
| `outcome_unknown` | غير متأكدين؛ يقول للمتصل بصراحة إن موظفًا بيتأكد، ولا يعيد المحاولة |
| `not_applied` | تأكدنا بالقراءة أن شي ما تغير |
| `previous_action_unresolved` | كتابة سابقة لنفس المريض لم تُحسم |
| `rejected` / `system_unavailable` / `system_timeout` | رفض أو عطل أو مهلة، ولم يتغير شي |

### 10.8 سجل التدقيق

كل اقتراح وتأكيد وتنفيذ يكتب `tool.audit` (مرحلة، `action_ref`، نوع العملية، `fingerprint`، النتيجة) **بدون هوية أو جوال أو اسم**.

---

## 11. `SchedulingSystem` والمحولات

### 11.1 المحول في الذاكرة (`adapters/fakes/memory-scheduling.ts`)

نظام مواعيد كامل من ملف dataset (`config/test-data/demo-clinic.dataset.json`). يُستخدم في الاختبارات والتطوير، وهو أيضًا النسخة الثانية التي تثبت أن الواجهة محايدة.

- **الذرية:** كل "فحص ثم كتابة" ينفذ بشكل متزامن بعد آخر `await`، فحجزان متزامنان لنفس الوقت ما يمكن ينجحان معًا.
- `slotProblem()` يفحص: الطبيب يقدم الخدمة، الوقت ليس بالماضي، داخل ساعات العمل وعلى شبكة المواعيد، وليس محجوزًا أو محجوبًا (إجازة).
- **Idempotency:** خريطة `key → {fingerprint, resultId}`. تكرار نفس المفتاح بنفس الطلب يرجع النتيجة الأولى؛ نفس المفتاح بطلب مختلف ← `invalid_request`. (`capabilities.idempotencyKeys = true`)
- **حقن الأعطال:** `failNext(operation, error, {afterCommit})`. مع `afterCommit: true` تُطبق الكتابة ثم يُرمى الخطأ، وهذا يحاكي بالضبط "النتيجة الغامضة" التي يعالجها `WriteLedger`.
- `version` رقم يزيد مع كل تعديل (للموعد).
- التواريخ في dataset نسبية لليوم (`workday`) فلا يعتمد على تاريخ التشغيل.
- `enter()`: يتحقق من المستأجر (`tenantId`)، والإلغاء، والتأخير الصناعي.

### 11.2 محول Medplum (`adapters/medplum/`)

**بدون SDK.** `fetch` المدمج + `zod`. أربعة ملفات: `client.ts`، `fhir-schemas.ts`، `medplum-scheduling.ts`، `seed.ts`.

#### `MedplumClient` (`client.ts`)

- **المصادقة:** OAuth2 `client_credentials`. التوكن يُخزن ويُجدد قبل انتهائه بـ60 ثانية (`tokenSkewMs`) بطلب واحد مشترك (`tokenRequest`).
- **401:** يجدد التوكن ويعيد الطلب **مرة واحدة** (آمن حتى للكتابة لأن الخادم رفض قبل التنفيذ).
- **القراءات (GET):** تُعاد مرة واحدة عند خطأ عابر (429، 502–504، انقطاع).
- **الكتابات (POST/PUT):** لا تُعاد أبدًا.
- **`readLink`:** يتبع روابط الصفحات فقط إذا بقيت داخل `fhir/R4/` لنفس الخادم.
- **تحويل الأخطاء (`errorFor`):**

| الشرط | النتيجة |
|---|---|
| 401/403 | `ProviderError auth` (غير قابل للإعادة) |
| 429 | `rate_limit` |
| ≥ 500 | `ProviderError unavailable` (**غامض**: قد تكون الكتابة تمت) |
| 404 أو issue `not-found` | `SchedulingError not_found` |
| نص يحوي "not available" | `SchedulingError slot_unavailable` |
| نص "cannot be canceled/rescheduled in" | `invalid_state` |
| 412 | `already_exists` |
| 409 | `invalid_state` |
| غير ذلك مع OperationOutcome | `invalid_request` |

- السجلات (`scheduling.request`) تحتوي الطريقة والعملية (`Appointment/:id/$cancel`) والحالة والمدة، **بدون** IDs أو query strings أو أسرار (`describePath`).

#### `MedplumSchedulingSystem` (`medplum-scheduling.ts`)

- **كاش الدليل:** `Directory { services, practitioners, schedules }` يُحمّل من `HealthcareService` و`Schedule` و`Practitioner` (صفحات 100 × حتى 5)، ويبقى `directoryTtlMs` (300 ثانية). المطابقة النصية عربية محلية (`rankByText` من `core/text-match.ts`) لأن بحث FHIR النصي ضعيف مع العربية.
- **`findAvailability`:**
  - طلب `Appointment/$find` **لكل Schedule على حدة** (حتى 4 بالتوازي عبر `mapLimit`)، ثم دمج وترتيب وقص. السبب: تكرار باراميتر `schedule` في طلب واحد يعني "كل هذه الموارد متاحة معًا" (تقاطع) مو "أي طبيب".
  - `$find` يرجع فقط الأوقات التي **تنتهي** داخل النافذة، بينما الواجهة تطلب ما **يبدأ** فيها؛ لذلك الطلب يمتد بمدة الخدمة ثم تُقص البدايات.
  - عند التعديل يمرر `ignore-appointment`.
- **`SlotToken`:** JSON مشفر base64url: `{v, schedule, practitioner, service, start, appointment}` حيث `appointment` هو الموعد المقترح الذي رجعه `$find`. `decodeToken` يتحقق أن الـtoken يطابق الـslot (الطبيب والخدمة والبداية) قبل أي استخدام.
- **`findPatients`:** هوية ← `identifier=<system>|<id>`. جوال ← بحث واحد بـOR على الصيغ الشائعة (`phoneSearchForms`) ثم مقارنة `samePhone` على كل أرقام السجل (لأن بحث `phone` حرفي والأرقام تُخزن بصيغ مختلفة).
- **`registerPatient`:** `POST Patient` مع `If-None-Exist` بالهوية (إنشاء شرطي). رد 201 = جديد. رد 200 = موجود: إذا يحمل معرّف الـidempotency الخاص بنا فهو إعادة لطلبنا، وإلا `already_exists`.
- **`book`:** يقرأ المريض أولًا (للتأكد من `not_found` حسب العقد) ويحمّل الدليل **قبل** الكتابة (حتى لا يبدو فشل تحميل الدليل بعد كتابة ناجحة كأنه فشل الحجز)، ثم `POST Appointment/$book`. Medplum يعيد فحص التوفر داخل transaction من نوع SERIALIZABLE، والوقت المأخوذ يرجع "not available" ← `slot_unavailable`.
- **`reschedule`:** يتحقق الحالة فعالة ونفس الخدمة، **ويرفض** موعدًا فيه موارد غير المريض والطبيب (لأن `$reschedule` يستبدل مجموعة الـschedules كاملة وقد يحذف غرفة/جهاز بصمت). يرسل الوقت الجديد ومجموعة الـschedules كاملة.
- **`cancel`:** يفحص الحالة قبل الكتابة (Medplum يعطي "Loading slots failed" على موعد ملغى أصلًا بدل خطأ حالة)، ثم `$cancel`.
- **`bookMarked`:** نسخة من `book` تضيف identifiers وtags على الموعد (للـseed فقط، ليست في الواجهة).
- `capabilities.idempotencyKeys = false` (حفظ Medplum للـidentifier مع `$book` غير مضمون)، فالاعتماد على المطابقة بالقراءة.

#### `seed.ts` (يعبّي Medplum ببيانات اصطناعية)

- `buildSeedPlan(dataset, anchorDate, ...)` ← خطة مرتبة حسب الاعتماديات: Organization ← Location ← HealthcareService ← Practitioner ← Schedule ← Patient، ثم حجب الإجازة، ثم المواعيد. المراجع داخل الخطة "شرطية" (`Type?identifier=urn:mujeeb:seed-key|<key>`) وتُستبدل بالـIDs الحقيقية قبل الإرسال.
- `applySeedPlan`: طلب واحد لكل عملية (بدون transaction لأن Medplum يحد الـtransaction الشرطية بـ8 عناصر)، كل مورد يُبحث عنه بالـseed-key ويُنشأ بـ`If-None-Exist`، فإعادة التشغيل لا تكرر شي.
- كل مورد يحمل tag `synthetic-seed` ومعرف `urn:mujeeb:seed-key|<key>`.
- `--reset-appointments` يلغي موعدًا فقط إذا تحققت 5 شروط معًا (يحمل seed-key والtag، حالته فعالة، مستقبلي، لمريض من مرضى الـseed، **ونسخة واحدة في `_history`** أي ما تغير منذ `$book`).
- **الافتراضي dry-run** (يكتب الخطة في `logs/` ولا يتصل بالشبكة). الكتابة تحتاج `--apply`.

---

## 12. الإعدادات والعقود (zod)

### 12.1 `config/settings.ts`

`envSchema` (zod) يقرأ المتغيرات ← `Settings` typed. القيم الفارغة (`KEY=`) تُعامل كأنها غير موجودة. أخطاء التحقق تذكر الأسماء بدون القيم. عند الخطأ أو النقص يرمي `ConfigError`.

| المجموعة | المتغيرات (الافتراضي) |
|---|---|
| أسرار | `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MEDPLUM_CLIENT_ID`, `MEDPLUM_CLIENT_SECRET` |
| النموذج | `MUJEEB_LLM_PROVIDER` (openai|fake)، `MUJEEB_LLM_MODEL`، `..._REASONING_EFFORT`، `..._FIRST_TOKEN_TIMEOUT_MS` (8000)، `..._MAX_OUTPUT_TOKENS`، `..._MAX_OUTPUT_TOKENS_TOOLS` (1024)، `..._ASSISTANT_PHASE` (true) |
| STT | `MUJEEB_STT_PROVIDER`، `..._MODEL`، `..._LANGUAGE` (ar)، `..._COMMIT_STRATEGY` (vad)، `..._VAD_SILENCE_SECS` (0.8، بين 0.2 و3)، `..._CHUNK_MS` (100) |
| TTS | `MUJEEB_TTS_PROVIDER`، `..._MODEL`، `..._VOICE_ID`، `..._FIRST_AUDIO_TIMEOUT_MS` (5000) |
| سلوك الجلسة | `MUJEEB_DUPLEX_MODE` (full)، `..._FALSE_INTERRUPTION_TIMEOUT_MS` (1500)، `..._ECHO_TAIL_MS` (1200)، `..._TOOL_CONFIRM_GRACE_MS` (400) |
| المواعيد | `MUJEEB_SCHEDULING_PROVIDER` (memory|medplum|none)، `..._DATASET`، `..._TIMEOUT_MS` (4000)، `..._WRITE_TIMEOUT_MS` (8000)، `..._DIRECTORY_TTL_SEC` (300) |
| Medplum | `MUJEEB_MEDPLUM_BASE_URL`، `MUJEEB_MEDPLUM_NATIONAL_ID_SYSTEM` |
| الخادم/السجلات | `MUJEEB_AGENT_PROFILE`، `MUJEEB_DEV_HOST` (127.0.0.1)، `MUJEEB_DEV_PORT` (8787)، `MUJEEB_LOG_LEVEL`، `MUJEEB_LOG_DIR`، `MUJEEB_LOG_TRANSCRIPTS` (false) |

`describeSettings()` يعطي نسخة آمنة للعرض (وجود المفتاح فقط، بدون قيمته).

### 12.2 `app/container.ts` (نقطة التركيب)

المكان **الوحيد** الذي يربط الإعدادات بالمحولات الحقيقية: `createProviders` (STT/LLM/TTS)، `createScheduling`، و`buildSessionConfig` (يجمع قيم الجلسة، ومنها ثوابت مثل `playbackGraceMs: 4000`, `clearAckTimeoutMs: 1000`, `sttReconnect: {maxAttempts: 4, baseDelayMs: 250}`).

### 12.3 العقود (`src/contracts/`)

- **`appointment-tools.ts`:** مخطط zod `strictObject` لكل أداة من التسع (كل الحقول مطلوبة، والاختياري `nullable()` كما يتطلب strict function calling). `toolParametersJsonSchema` يحوّلها لـJSON Schema عبر `z.toJSONSchema`. `parseToolArguments` يتحقق من الوسائط الخام ويرجع وصف مشكلة آمن للنموذج.
- **`agent-profile.ts`:** مخطط البروفايل: `tenantId`, `agentId`, `greeting`, `historyMaxTurns` (1–50)، `timezone` (يُتحقق أنها IANA)، و`appointmentTools` (`patientVerification` قيمة واحدة مسموحة الآن `'dev-identifier-dob'`، `maxToolRounds` 1–8، `pendingActionTtlSec` 15–600، `maxReconfirmations` 0–5، `waitPhrase`، `allowedTools`). و`refine`: `timezone` إلزامي مع الأدوات.
- **`dev-client-protocol.ts`:** رسائل المتصفح ← الخادم (`hello`, `mark`, `playback_started`, `playback_cleared`, `pong`) مفحوصة بـzod، والخادم ← المتصفح (`session_started`, `mark`, `clear`, `pause`, `resume`, `ping`, `event`, `error`).
- **`scheduling-dataset.ts`:** مخطط ملف البيانات الاصطناعية.

### 12.4 ملفات العيادة (`config/agents/demo-clinic/`)

- `profile.json`: بيانات العيادة والحدود.
- `instructions.md`: شخصية مُجيب: سعودي أبيض، جملة أو جملتين، لا تشخيص، لا اختراع معلومات، قواعد نطق الأرقام والأوقات.
- `tools.md`: قواعد استخدام الأدوات (يُضاف فقط عند تفعيلها): كل معلومة من الأدوات، التحقق قبل أي شي، خطوتان للكتابة، لا تقول "تم" بنفسك، انطق حقل `spoken` كما هو، وجدول التعامل مع كل `status`.

---

## 13. القياس والسجلات

### 13.1 `TurnTimeline` (`observability/turn-timeline.ts`)

ساعة `performance.now()` (monotonic). `mark(name)` يسجل **أول مرة فقط** (إلا مع `overwrite`). العلامات:

`user_speech_start, user_speech_end, stt_first_partial, stt_committed, llm_request, llm_first_token, llm_done, tts_first_text, tts_first_audio, playback_start, playback_end, barge_in_speech_start, barge_in_candidate, interrupt_requested, playback_stopped, error`

المدد المحسوبة (`durations()`):

| المدة | المعادلة |
|---|---|
| `stt_finalize_ms` | `user_speech_end → stt_committed` |
| `llm_ttft_ms` | `llm_request → llm_first_token` |
| `llm_total_ms` | `llm_request → llm_done` |
| `tts_ttfb_ms` | `tts_first_text → tts_first_audio` |
| `first_audio_after_commit_ms` | `stt_committed → tts_first_audio` |
| `playback_buffer_ms` | `tts_first_audio → playback_start` |
| **`e2e_ms`** | **`user_speech_end → playback_start`** (الإحساس الكلي عند المتصل) |
| `barge_in_reaction_ms` | `barge_in_speech_start → interrupt_requested` |
| `interrupt_stop_ms` | `interrupt_requested → playback_stopped` |
| `tools_ms` | مجموع أزمنة الأدوات (تضيفها الجلسة) |

### 13.2 المخرجات

- `JsonlTurnSink`: سطر JSON لكل دور في `logs/turns-YYYY-MM-DD.jsonl`.
- `latencyPercentiles()` + `npm run report`: p50/p90/p95/max لكل مدة (nearest-rank).
- **الـlogger** (`observability/logger.ts`): JSON lines، مستويات debug/info/warn/error، `child()` لإضافة سياق (`session_id`, `tenant_id`, `turn_id`)، و`sanitize` يخفي أي مفتاح اسمه يطابق `api[_-]?key|token|secret|authorization|password|xi-api-key` (ولهذا سُمّي مفتاح الميزانية `output_budget` لا `max_output_tokens`).
- أحداث `tool.call`, `tool.audit`, `write.*`, `scheduling.request`, `patient.verification` تحمل correlation IDs بدون بيانات مرضى.

---

## 14. واجهة المتصفح

`web/dev-client/` — شاشة عرض وناقل صوت فقط: **لا مفاتيح، لا منطق محادثة، لا prompts**.

### 14.1 الملفات

| الملف | الدور |
|---|---|
| `capture-worklet.js` | التقاط الميكروفون إلى إطارات PCM16 (قسم 5.1) |
| `player-worklet.js` | تشغيل الطابور مع epochs وmarks (قسم 5.5) |
| `app.js` (~980 سطر) | الاتصال، معالجة الرسائل، العرض |
| `index.html` / `style.css` | الواجهة (عربية RTL) |

### 14.2 دورة `app.js`

- `start()`: ينشئ `AudioContext` بـ16kHz، يحمّل الـworklets، `getUserMedia` بالإعدادات المختارة (AEC/NS/AGC)، يوصل المسار، ويفتح `WebSocket('/ws')`. مساران للتشغيل: `direct` (Web Audio مباشرة) و`webrtc-loopback` (الصوت يمر عبر RTCPeerConnection محلي ليستفيد من إلغاء الصدى في Chrome).
- `capture.port.onmessage`: يرسل كل إطار binary للخادم (وعند كتم المايك يرسل **أصفارًا** بنفس الطول للحفاظ على التوقيت).
- `player.port.onmessage`: يحوّل أحداث المشغّل (`mark`, `started`, `cleared`) إلى رسائل JSON للخادم.
- `onServerMessage`: إطار binary ← يقرأ `epoch` من أول 4 بايتات (uint32 LE) ويمرر الباقي للمشغل؛ `mark/clear/pause/resume` ← للمشغل؛ `ping` ← `pong`؛ `event` ← `onSessionEvent`.
- العرض: فقاعات المحادثة، سطر لكل أداة (اسم/نتيجة/زمن)، لوحة المسار اللحظي، بطاقات القياس (الدور الحالي أو الوسيط)، مخطط Gantt للدور، سجل أحداث مع فلتر (MIC/STT/LLM/TTS/PLAY/BARGE/TOOL/STATE/SYS)، لوحة أخطاء، جدول أزمنة مع تصدير CSV.

### 14.3 بروتوكول الرسائل (WebSocket)

```
المتصفح → الخادم:  binary: PCM16 frames (20ms)
                   JSON: hello | mark | playback_started | playback_cleared | pong
الخادم → المتصفح:  binary: [epoch uint32 LE][PCM16]
                   JSON: session_started | mark | clear | pause | resume | ping | event | error
```

---

## 15. الإلغاء والأخطاء

### 15.1 هرم الـAbortSignal

```
lifetime (الجلسة كلها)                   ← يُلغى في close()
  └─ turn.controller (دور واحد)           ← يُلغى عند: مقاطعة | user_continued | فشل | إغلاق
       ├─ طلب LLM  (+ مهلة أول token)
       ├─ سياق TTS (+ مهلة أول صوت)
       ├─ قراءات الأدوات  (withDeadline(turn.signal, readTimeoutMs))
       └─ sleep(graceMs) قبل الكتابة

الكتابة المؤكدة: withDeadline(undefined, writeTimeoutMs)   ← لا ترتبط بأي شي فوق
```

`withDeadline(parent, ms, onTimeout)` (في `core/async.ts`): signal ينتهي بإلغاء الأب أو بالمهلة. تمرير `parent` غير معرّف يعطي مهلة بحتة تتجاهل إلغاء المتصل.

### 15.2 الأخطاء المعيارية (`core/errors.ts`)

| النوع | متى |
|---|---|
| `ProviderError(provider, kind, message, {retryable})` | أي فشل مزود. `kind`: auth, rate_limit, quota, timeout, unavailable, bad_request, bad_response, unknown. القابل للإعادة افتراضيًا: rate_limit, timeout, unavailable |
| `SchedulingError(system, kind, message)` | نتيجة عمل من نظام المواعيد: not_found, slot_unavailable, invalid_state, already_exists, invalid_request |
| `ConfigError` | إعدادات ناقصة أو خاطئة |
| `CancelledError(reason)` | إلغاء متعمد من مُجيب |

`errorSummary()` يعطي شكلًا آمنًا للتسجيل. المنطق ما يرى استثناءات SDK الخام أبدًا.

### 15.3 أدوات async صغيرة (`core/async.ts`)

`AsyncQueue` (جسر من push إلى async iterable)، `sleep(ms, signal)`، `raceAbort(promise, signal)`، `abortReason(signal)`، `withDeadline`.

### 15.4 ماذا يحصل عند كل فشل (من الكود)

| الفشل | السلوك |
|---|---|
| انقطاع STT | إعادة اتصال بتأخير أسي (حتى 4 مرات) ثم إغلاق الجلسة |
| فشل دور (LLM/TTS) | `failTurn`: يلغي، يسجل `turn.failed`، يرسل `error` للواجهة، ويرجع `listening` (الجلسة تبقى سليمة) |
| لا تأكيد تشغيل من المتصفح | مهلة `audioMsSent + playbackGraceMs` ثم يكمل (`playback.ack_timeout`) |
| انقطاع TTS | `onClose` يفشّل كل السياقات؛ يُعاد الاتصال كسولًا عند الدور التالي |
| فشل قراءة أداة | نتيجة `system_timeout`/`system_unavailable` للنموذج، وبدون تغيير |

---

## 16. الاختبارات

أحجام تقريبية، و**452 اختبارًا ناجحًا من 452 في 21 ملفًا** (نتيجة `npm run check` في 2026-10-14؛ الاختبارات الحية مستبعدة افتراضيًا في `vitest.config.ts`).

| المجلد | ماذا يغطي |
|---|---|
| `tests/architecture/` | قواعد الاعتماد والتسرب (القسم 2.2) |
| `tests/unit/` | `normalizeArabic`، سياسة المقاطعة، المقطّع، VAD، `TurnTimeline`، الإعدادات، الجوال (`phone`)، `spoken-arabic`، التقسيمات الداخلية للأدوات (المصنف، الإجراء المعلق، السجل، التحقق)، `Conversation` مع الأدوات |
| `tests/contract/` | **مجموعة واحدة** (`scheduling-system.contract.ts`) تُشغَّل على أي محول: تعارض، حجزان متزامنان (ينجح واحد)، إلغاء مزدوج، تسجيل مكرر، نافذة التوفر. تشتغل على Memory دائمًا وعلى Medplum في الاختبارات الحية |
| `tests/integration/` | محولات OpenAI وElevenLabs وMedplum مقابل خوادم محلية تحاكيها (`fake-medplum.ts`)، الـseed، `VoiceSession` كاملة (مقاطعة، صدى، مقاطعة كاذبة، أخطاء المزود، جلسات متزامنة)، `VoiceSession` مع الأدوات (مقاطعة أثناء الكتابة، نتيجة غامضة)، الخادم الحقيقي مع عميل WebSocket حقيقي |
| `tests/live/` | 8 ملفات مع مزودين حقيقيين (OpenAI/ElevenLabs/Medplum)، منها `voice-e2e.live.test.ts` الذي يحاكي مكالمة صوتية كاملة (حجز ثم تعديل ثم مقاطعة ثم إلغاء). **مغلقة افتراضيًا وتكلف فلوسًا** |
| `tests/support/` | `createHarness` (جلسة كاملة بمزودين وهميين)، `FakeTransport`، `fake-medplum`، `ws-browser-client`، `live-medplum` (حاجز يمنع تعديل أي موعد لا يخص مريضًا سجّله نفس التشغيل) |

**المزودون الوهميون** (`adapters/fakes/`): `FakeSpeechToText` (وضع `scripted` تقود به الاختبارات النصوص، ووضع `energy` لـ`dev:fake`)، `FakeLanguageModel` (خيار `script` يعيد جولات أدوات وcontinuation وهمي)، `FakeTextToSpeech` (نغمات، يتتبع الجمل المنطوقة).

---

## 17. الخصوصية والأمان داخل الكود

| الآلية | أين |
|---|---|
| أسرار من البيئة فقط، لا تُكتب في الكود | `config/settings.ts`, `.gitignore` (يستثني `.env` و`logs/`) |
| إخفاء المفاتيح في السجلات | `observability/logger.ts` (`SECRET_KEY`) |
| النصوص لا تُسجل افتراضيًا | `MUJEEB_LOG_TRANSCRIPTS=false`، و`textFields()` في الجلسة يسجل `text_chars` بدل النص |
| OpenAI لا يحفظ المحادثة | `store: false` في كل طلب |
| ElevenLabs zero retention | يُطلب بالإعداد، **ولا يُطبَّق على خطة Starter** (تحقق منه `probe:elevenlabs` ويسجل `stt.config_mismatch`) |
| الخادم المحلي مقفل | loopback فقط، فحص `Origin`، حد جلسات، CSP صارم |
| النموذج ما يرى IDs المستشفى | `SessionRefs` |
| النموذج ما ينفذ كتابة بنفسه | `PendingActions` + المصنف + شرط السماع (القسم 10) |
| بيانات المرضى اصطناعية فقط | dataset بأرقام هوية بـchecksum خاطئ عمدًا، وtag `synthetic-seed` |
| كشف وجود المرضى | نفس الرد لـ"غير موجود" و"تاريخ ميلاد خطأ"، وقفل بعد 3 محاولات |
| سجل التدقيق بدون هوية | `tool.audit` |
| عزل المستأجر في المحول | `enter()` في كل محول يرفض `tenantId` غير المضبوط عليه (`ProviderError auth`) |

---

## 18. حدود معروفة وملاحظات

هذي أشياء موجودة فعلًا في الكود أو الوثائق، مو افتراضات:

1. **كل حالة الجلسة في الذاكرة.** إعادة تشغيل العملية تفقد الجلسات الجارية. ما فيه حفظ دائم لأي شي غير ملفات `logs/`.
2. **التحقق من المريض للتطوير فقط.** من يعرف الهوية وتاريخ الميلاد يمر. القرار للإنتاج مفتوح (`DECISIONS.md` D2).
3. **Medplum مؤقت وفي مرحلة Beta.** والمحول يرفض تعديل موعد فيه غرف/أجهزة، ويدعم `Practitioner` فقط (لا `PractitionerRole`).
4. **`capabilities.idempotencyKeys=false` في Medplum.** فالحماية من التكرار تعتمد على الحسم بالقراءة، مو على مفتاح يحترمه الخادم.
5. **قوائم المصنّف ثابتة.** قد يصنف عبارة سعودية غير مغطاة `unclear` فيعيد السؤال؛ هذا خطأ آمن (لا تنفيذ).
6. **البحث النصي ما يتحمل أخطاء الإملاء من STT** (اسم دكتور مسموع غلط ما يُلقى)؛ يعتمد على التطبيع والبادئة فقط.
7. **زمن دور الحجز الكامل قد يصل نحو 5 ثوانٍ** (حتى 3 جولات نموذج). التحسين المؤجل: `search_available_slots` تقبل اسم الخدمة مباشرة فتوفر جولة.
8. **اختبار الصدى اليدوي** (`docs/MANUAL_VOICE_TESTS.md`) ما نُفذ على أجهزة حقيقية بعد، واختبارات الحجز اليدوية (`docs/MANUAL_SCHEDULING_TESTS.md`) نُفذ جزء منها فقط.
9. **بيانات Medplum التجريبية بدأت تنتهي** (مواعيد الـseed في الماضي) وتحتاج إعادة تعبئة بـ`--apply --reset-appointments`.
10. **مشكلتا تنسيق صغيرتان في ملفات التعليمات** (دمج سطرين في سطر واحد): في `config/agents/demo-clinic/instructions.md` سطر الأوقات مع التواريخ، وفي `tools.md` سطر `confirmation_unclear` مع `declined`. لا تؤثر على الاختبارات، لكن قد يقرأ النموذج الأسطر المدموجة كجملة واحدة.
11. **ما فيه أي commit في git.** المستودع موجود لكن كل الملفات untracked.
12. **خارج النطاق الحالي عمدًا:** الهاتف/SIP، قاعدة بيانات ومستأجرون، تحويل لموظف، واتساب/SMS، لوحة إدارة، أي نظام مستشفى حقيقي.

---

## 19. كيف تتتبع طلب واحد

مثال: المتصل يقول **"أبي ألغي موعدي"** ثم **"إيه"**. اتبع الكود بهذا الترتيب:

| # | وين | وش يصير |
|---|---|---|
| 1 | `capture-worklet.js` | إطارات PCM16 كل 20ms |
| 2 | `browser-ws-transport.ts` `onMessage` | يفحص الإطار ويصدر `audio` |
| 3 | `session.ts` `onAudio` | VAD + تجميع 100ms ← `sttStream.sendAudio` |
| 4 | `realtime-stt.ts` `onMessage` | `partial_transcript` ثم `committed_transcript` |
| 5 | `session.ts` `onCommitted` → `startUserTurn` → `beginTurn` | دور جديد، epoch جديد، `thinking` |
| 6 | `session.ts` `agentText` → `prepareAgentTurn` | ينتظر كتابات سابقة ويحسم الغامض |
| 7 | `agent-turn.ts` `run` | جولة 1: النموذج يطلب `list_patient_appointments` (لو المريض متحقق منه) |
| 8 | `responses-model.ts` `stream` | طلب OpenAI، `text_delta`، `completed{toolCalls, continuation}` |
| 9 | `appointment-tools.ts` `execute` → `dispatch` → `listAppointments` | ينفذ القراءة، يسجل مراجع `A1`... |
| 10 | `agent-turn.ts` | جولة 2: `propose_cancellation(A1)` |
| 11 | `appointment-tools.ts` `proposeCancellation` → `propose` | `PendingActions.propose` ← `C1` + جملة التأكيد |
| 12 | `agent-turn.ts` | ينطق `speech` حرفيًا وينهي الدور |
| 13 | `session.ts` `speak` + `multi-context-tts.ts` | تقطيع، TTS، `sendAudio` + `sendMark` |
| 14 | `player-worklet.js` | تشغيل، وإرسال `mark` لكل مقطع |
| 15 | `session.ts` `finalizeTurn` → `onTurnFinalized` | `action.heard` يُحسب من النص المسموع |
| 16 | المتصل يقول "إيه" ← خطوات 1–6 بدور جديد | `userTurn` = السابق + 1 |
| 17 | `agent-turn.ts` | `confirm_pending_action(C1, 'yes')` ← انتظار 400ms |
| 18 | `appointment-tools.ts` `confirm` → `pending-actions.ts` `confirm` | فحوص 10.2 + `confirmation-classifier.ts` |
| 19 | `appointment-tools.ts` | قراءة الموعد وفحص `version`، ثم `ledger.execute` |
| 20 | `write-ledger.ts` `execute` → `runWrite` → `scheduling.cancel` | الكتابة بمهلتها الخاصة |
| 21 | `medplum-scheduling.ts` `cancel` + `client.ts` `write` | `POST Appointment/{id}/$cancel` |
| 22 | `appointment-tools.ts` `writeSuccess` | جملة "تم إلغاء ..." من سجل المستشفى |
| 23 | `session.ts` `completeTurn` → `commitHistory` | السجل يحفظ ما سمعه المتصل |
| 24 | `turn-metrics.ts` | سطر `turn.summary` في `logs/turns-*.jsonl` |

### مصطلحات

| المصطلح | المعنى |
|---|---|
| **Port** | واجهة (interface) يملكها مُجيب |
| **Adapter** | كود يطبق Port لمزود معين |
| **Composition root** | المكان الوحيد الذي يربط الإعدادات بالمحولات (`app/container.ts`) |
| **Epoch** | رقم يميز كل رد صوتي من مُجيب؛ يمنع تشغيل صوت دور ملغي |
| **Mark** | علامة بين مقاطع الصوت؛ تأكيدها = "هذا انسمع فعلًا" |
| **Barge-in** | مقاطعة المتصل لكلام مُجيب |
| **Turn / دور** | رد واحد من مُجيب على جملة من المتصل |
| **Round / جولة** | طلب واحد للنموذج داخل الدور (قد يطلب أدوات فتبدأ جولة جديدة) |
| **Continuation** | حالة OpenAI المبهمة داخل الدور الواحد (reasoning وcalls) |
| **Read-back** | الجملة التي يقرؤها النظام على المتصل ليؤكد قبل الكتابة |
| **Pending action** | إجراء مقترح ينتظر تأكيد المتصل |
| **Write ledger** | سجل الكتابات الجارية وحسم النتائج الغامضة |
| **Reconcile** | حسم نتيجة غامضة بقراءة النظام لا بإعادة الكتابة |
| **Idempotency key** | مفتاح يمنع تنفيذ نفس الكتابة مرتين |
| **Synthetic data** | بيانات اصطناعية، ليست لمرضى حقيقيين |
