# مُجيب — تقرير اختيار لغات البرمجة (2026-10-08)

**القرار المعتمد:** Option A. TypeScript (strict) على Node.js 24 LTS لكل ما يعمل وقت التشغيل. Python خارج الـruntime. تفاصيل القرار في `docs/DECISIONS.md` (A10).

## الخيارات التي قورنت
- **A:** TypeScript لكل شيء.
- **B:** Python للمحرك والـBackend، وTypeScript للواجهة.
- **C:** TypeScript للمنصة، وPython للخدمات الصوتية.

## الخلاصة
- الكود الذي يميّز مُجيب هو streaming I/O وSaaS: الـorchestration، والـtools، والـtenancy، والتكاملات، والـaudit، ولوحة التحكم. أما STT وLLM وTTS فتعمل عند المزودين. لذلك ميزة Python في الـML لا تُستخدم في الـruntime.
- ميزة TypeScript (لغة واحدة، وعقود zod مشتركة من المحرك إلى اللوحة) نستفيد منها يوميًا، ولا يمكن تعويضها في B لأن اللوحة TypeScript في كل الأحوال.
- **مزايا Python الحقيقية:**
  - الإلغاء التلقائي في asyncio، ونعوّضه في TS بـ`signal` إلزامي في الـports، و`AbortSignal.any/timeout`، وقاعدة `no-floating-promises`.
  - قربها من نماذج الصوت مثل VAD وturn detection، ونعوّضه بـ`onnxruntime-node`، أو `turn_prediction` من المزود، أو sidecar عند الحاجة.
- **C مرفوض الآن:** يضع حدًّا شبكيًا داخل المسار الحرج (الصوت ↔ الأدوات)، وخدمتين، وتتبعًا موزعًا، وكل هذا لمطور واحد. وهذا يخالف A6. الفصل يصبح مبررًا فقط مع عتاد مختلف (GPU) أو عزل مطلوب، وعندها يكون "خدمة inference خلف adapter".
- الفرق بين A وB ليس كبيرًا، وB بديل معقول لو كانت خبرة الفريق Python بشكل أساسي.

## المقارنة المختصرة

| المعيار | الأفضل | السبب |
|---|---|---|
| Real-time streaming وWebSocket | A ≈ B | الاثنان ناضجان. C يضيف hop داخليًا |
| Telephony/SIP | تعادل | لن نكتب SIP/RTP بأنفسنا. الصوت يأتي من gateway عبر WebSocket (Twilio، jambonz، FreeSWITCH، OpenAI SIP) |
| STT/TTS/LLM SDKs | تعادل | OpenAI وElevenLabs رسميان في اللغتين |
| Barge-in والإلغاء | B (فرق بسيط) | الإلغاء في asyncio تلقائي. في TS يُفرض بالـtypes والـlint |
| VAD وturn detection | B | النماذج تصدر لـPython أولًا. وفي TS يمكن ذلك عبر ONNX أو المزود |
| Concurrency والأداء | A (فرق بسيط) | تكلفة اللغة لا تُذكر أمام زمن المزودين. التوسع بإضافة processes في الحالتين |
| Maintainability وDX وDeployment وSaaS | **A** | لغة واحدة، وtoolchain واحد، وimage واحدة، وعقود مشتركة |

## مخاطر قد تغيّر القرار
1. إقامة البيانات (D4) تفرض نماذج داخل السعودية. الحل: خدمة inference بـPython خلف adapter، بدون إعادة كتابة.
2. نموذج صوتي داخل الـprocess بلا مسار ONNX. الحل: sidecar لهذا النموذج فقط.
3. تشبع الـevent loop. الحل: `worker_threads` ثم processes إضافية، بناءً على قياس `event loop delay`.
4. تبنّي Pipecat تحديدًا (Python فقط). الاحتمال منخفض بسبب PROJECT_CONTEXT §9.

## المصادر
- ElevenLabs Realtime STT API: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- ElevenLabs multi-context TTS: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket
- ElevenLabs SDKs: https://github.com/elevenlabs/elevenlabs-js و https://github.com/elevenlabs/elevenlabs-python
- OpenAI libraries: https://developers.openai.com/api/docs/libraries
- Twilio Media Streams: https://www.twilio.com/docs/voice/media-streams/websocket-messages
- jambonz listen: https://docs.jambonz.org/verbs/verbs/listen
- LiveKit turn detector: https://docs.livekit.io/agents/logic/turns/turn-detector
- Smart Turn: https://github.com/pipecat-ai/smart-turn
- onnxruntime-node: https://npmjs.com/package/onnxruntime-node
- Python audioop removal: https://docs.python.org/3/library/audioop
