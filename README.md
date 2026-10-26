# مُجيب (Mujeeb)

مُجيب هو مشروع Voice AI SaaS موجه للقطاع الصحي في السعودية. الهدف النهائي هو استقبال مكالمات المرضى بالعربية واللهجة السعودية، الإجابة من قاعدة معرفة خاصة بكل منشأة صحية، وتنفيذ إجراءات إدارية مثل عرض المواعيد والحجز والتعديل والإلغاء عبر تكاملات آمنة وقابلة للتدقيق.

## الحالة الحالية

- **Phase 0 (منفذة):** حلقة صوتية محلية: `Microphone -> STT -> LLM/Orchestrator -> TTS -> Speaker`.
- **Phase 1 (منفذة):** أدوات المواعيد على نظام مواعيد تجريبي (Medplum sandbox) ببيانات اصطناعية فقط، مع تأكيد المتصل قبل أي كتابة.
- **Phase 4، الخطوة 1 (منفذة، 2026-10-25):** نفس المحرك يستقبل مكالمات عبر Asterisk في **مختبر محلي فقط**. المسار: softphone ‏(MicroSIP) ← Asterisk ‏(WSL) ← `chan_websocket` ← مُجيب.
  - لا يوجد بعد خط اتصالات تجاري، ولا رقم حقيقي، ولا خادم سحابي.
  - القرار: [DECISIONS.md](docs/DECISIONS.md) A19. والخطوات التالية في [ROADMAP.md](docs/ROADMAP.md).

المبدأ: الـMVP صغير في النطاق، لكنه أساس هندسي يُوسَّع، وليس نموذجًا تجريبيًا يُرمى.

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
1. انسخ `.env.example` إلى `.env`، ثم املأ المفاتيح و`MUJEEB_LLM_MODEL` و`MUJEEB_TTS_MODEL` و`MUJEEB_TTS_VOICE_ID` (أو ضع `voiceId` في `profile.json` الخاص بالعيادة، وهو يتغلب على `.env`).
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

**الهاتف في المختبر المحلي (Phase 4):**
- **ليس ربطًا تجاريًا:** ‏Asterisk في WSL على `127.0.0.1` فقط، وMicroSIP كهاتف تجريبي.
- التجهيز الكامل (بناء Asterisk، والإعدادات، وكلمات السر، وMicroSIP) في [deploy/asterisk/lab/README.md](deploy/asterisk/lab/README.md).
- أضف إلى `.env`: ‏`MUJEEB_TELEPHONY_PASSWORD`، وهو السر المشترك مع Asterisk، ويولّده `setup-lab.sh`.
- التشغيل:
  - `npm run telephony` للمزودين الحقيقيين.
  - `npm run telephony:fake` بدون مفاتيح.
- ثم اتصل من MicroSIP على **300**.
- الرقم المتصَل عليه يُوجَّه إلى profile العيادة من [config/telephony/routes.json](config/telephony/routes.json)، والرقم غير المعروف يُرفض.

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
| `src/adapters` | OpenAI وElevenLabs وMedplum والمتصفح وAsterisk (`telephony/asterisk`) والـfakes. الكود الوحيد الذي يعرف المزودين |
| `src/app` | الـcomposition root، وخادم المتصفح المحلي، وخادم المكالمات (`telephony-server.ts`)، والتوجيه، والـCLI |
| `web/dev-client` | واجهة الاختبار: التقاط وتشغيل وعرض فقط، بلا مفاتيح وبلا منطق |
| `deploy/asterisk/lab` | المختبر المحلي: بناء Asterisk وإعداداته، بدون أسرار |

حدود الاستيراد بين المجلدات يفرضها `tests/architecture/boundaries.test.ts`.

## مبدأ أساسي

نحن لا نبني SaaS ضخمًا كاملًا من اليوم الأول، ولا نبني Demo يتم التخلص منه. نبني **Modular Monolith** نظيفًا، مع فصل مزودي الخدمات عن منطق المنتج، ثم نوسع النظام حسب نتائج القياس ومتطلبات العملاء الفعلية.
