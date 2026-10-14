# مُجيب (Mujeeb)

مُجيب هو مشروع Voice AI SaaS موجه للقطاع الصحي في السعودية. الهدف النهائي هو استقبال مكالمات المرضى بالعربية واللهجة السعودية، الإجابة من قاعدة معرفة خاصة بكل منشأة صحية، وتنفيذ إجراءات إدارية مثل عرض المواعيد والحجز والتعديل والإلغاء عبر تكاملات آمنة وقابلة للتدقيق.

## الحالة الحالية

نحن حاليًا في مرحلة MVP محلي يختبر قلب تجربة الصوت قبل ربط الهاتف أو الأنظمة الصحية:

`Microphone -> STT -> LLM/Orchestrator -> TTS -> Speaker`

الهدف من هذه المرحلة هو قياس جودة التعرف، الفهم، سرعة الاستجابة، طبيعية الصوت، واستقرار الـstreaming، مع بناء أساس هندسي يمكن توسيعه لاحقًا بدل كتابة نموذج تجريبي يتم التخلص منه.

## ابدأ من هنا

لأي مطور أو Coding Agent جديد:

1. اقرأ `CLAUDE.md`.
2. اقرأ `docs/PROJECT_CONTEXT.md`.
3. اقرأ `docs/DECISIONS.md` لمعرفة ما تم اعتماده وما زال مجرد خيار.
4. اقرأ `docs/ROADMAP.md` حتى لا تخلط بين نطاق الـMVP الحالي والمنتج النهائي.
5. استخدم الـSkills الموجودة في `.claude/skills/` عند تنفيذ المهام.

## التشغيل (Phase 0)

**المتطلبات:** Node.js 24 LTS (يعمل أيضًا على ≥ 22.14)، ومتصفح Chrome أو Edge.

```bash
npm install
npm run check          # typecheck + lint + كل الاختبارات (بدون أي API مدفوع)
```

**بدون مفاتيح (مزودات وهمية):**
```bash
npm run dev:fake       # ثم افتح http://127.0.0.1:8787
```
- الـSTT الوهمي يحوّل أي كلام يلتقطه المايك إلى جمل عربية جاهزة.
- الـLLM الوهمي يرد بنص تجريبي.
- الـTTS الوهمي يُخرج نغمة صوتية.

هذا الوضع مفيد لاختبار المقاطعة والواجهة والأزمنة المحلية.

**مع المزودين الحقيقيين:**
1. انسخ `.env.example` إلى `.env`، ثم املأ المفاتيح و`MUJEEB_LLM_MODEL` و`MUJEEB_TTS_MODEL` و`MUJEEB_TTS_VOICE_ID`.
2. شغّل `npm run probe:elevenlabs`. يتحقق من حساب ElevenLabs الفعلي: هل `turn_prediction` و Zero Retention مطبقة فعلًا، ويختبر TTS مع رحلة ذهاب وعودة TTS→STT.
3. شغّل `npm run dev` وافتح `http://127.0.0.1:8787`.
4. اختبر بسماعة رأس أولًا، ثم نفّذ مصفوفة الاختبار اليدوية في [docs/MANUAL_VOICE_TESTS.md](docs/MANUAL_VOICE_TESTS.md).

**المواعيد (Phase 1):**
- الوضع الافتراضي `MUJEEB_SCHEDULING_PROVIDER=memory`: عيادة اصطناعية في الذاكرة، بدون شبكة.
- مع Medplum sandbox (بيانات اصطناعية فقط):
  1. أضف إلى `.env`: `MUJEEB_SCHEDULING_PROVIDER=medplum` و`MEDPLUM_CLIENT_ID` و`MEDPLUM_CLIENT_SECRET`.
  2. جهّز البيانات: `npm run seed:medplum` (معاينة فقط)، ثم `npm run seed:medplum -- --apply`. عند إعادة التشغيل في يوم آخر أضف `--reset-appointments`.
  3. شغّل `npm run dev` وافتح `http://127.0.0.1:8787`.
- المريض يتحقق برقم الهوية أو الجوال مع تاريخ الميلاد (سياسة تطوير فقط). مرضى الـseed موجودون في `config/test-data/demo-clinic.dataset.json`.
- مصفوفة الاختبار اليدوي بالمايك: [docs/MANUAL_SCHEDULING_TESTS.md](docs/MANUAL_SCHEDULING_TESTS.md).

**القياس:**
- `npm run report` يعرض p50 وp90 وp95 لكل مرحلة، من ملفات `logs/turns-*.jsonl`.
- `npm run test:live` يشغّل اختبارات اختيارية مدفوعة على المزودين الحقيقيين. اختبارات Medplum الحية تحتاج أيضًا `MUJEEB_LIVE_MEDPLUM=1`، وتكتب بيانات اختبار اصطناعية في الـsandbox ثم تلغي مواعيدها.

> لا تستخدم بيانات مرضى حقيقية. النصوص لا تُكتب في الـlogs إلا إذا ضُبط `MUJEEB_LOG_TRANSCRIPTS=true`.

## هيكل الكود

| المجلد | المسؤولية |
|---|---|
| `src/core` | أنواع الصوت والأخطاء والمعرّفات وأدوات async. لا يعتمد على أي شيء |
| `src/ports` | واجهات: `AudioTransport` و`SpeechToText` و`LanguageModel` و`TextToSpeech` |
| `src/voice` | `VoiceSession`: الأدوار والمقاطعة والتقطيع والـVAD وسياسة الـbarge-in |
| `src/agent` | سجل المحادثة وبناء الطلب، بدون أي معرفة بالصوت |
| `src/adapters` | OpenAI وElevenLabs والمتصفح والـfakes. الكود الوحيد الذي يعرف المزودين |
| `src/app` | الـcomposition root والخادم المحلي والـCLI |
| `web/dev-client` | واجهة الاختبار: التقاط وتشغيل وعرض فقط، بلا مفاتيح وبلا منطق |

حدود الاستيراد بين المجلدات يفرضها `tests/architecture/boundaries.test.ts`.

## مبدأ أساسي

نحن لا نبني SaaS ضخمًا كاملًا من اليوم الأول، ولا نبني Demo يتم التخلص منه. نبني **Modular Monolith** نظيفًا، مع فصل مزودي الخدمات عن منطق المنتج، ثم نوسع النظام حسب نتائج القياس ومتطلبات العملاء الفعلية.
