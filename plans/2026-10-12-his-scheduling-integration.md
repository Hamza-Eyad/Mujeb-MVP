# مُجيب: خطة ربط الـVoice Agent بأنظمة المواعيد (HIS) عبر Adapter، مع Medplum كبيئة اختبار مؤقتة

> **v1 (2026-10-12):** المقترح الأول.
> **v2 (2026-10-12):** بعد مراجعة صاحب المشروع. المعمارية العامة معتمدة مبدئيًا، والتعديلات:
> - dataset أصغر.
> - تأكيد الإجراءات يُفرض في الـbackend.
> - اكتشاف الأطباء والخدمات بأدوات بحث بدل تحميل الدليل في الـcontext.
> - مراجعة إدارة حالة الأدوات في OpenAI مع `store:false`.
> - التحقق من الهوية سياسة تطوير فقط.
>
> **v3 (2026-10-12):** ضمانات إضافية من صاحب المشروع:
> - التأكيد الملتبس آمن، ويمكن طلب تأكيد جديد.
> - الحجز الجديد يُتحقق منه وقت التنفيذ عبر `$book`، ولا يُكتفى بفحص الـversion.
> - الكتابة الجارية لا تُهمل بسبب المقاطعة، وتُتتبع النتائج غير المؤكدة وتُحسم.
>
> **الحالة:** الخطوات 0 إلى 9 منفذة، والاختبار اليدوي بالمايك نجح (2026-10-18): حجز لمريض موجود، وفتح ملف لمريض جديد. انظر "الاختبار اليدوي بالمايك".
> - الخطوة 6 (2026-10-13): نُفّذ الـseed على Medplum، والحالة COMPLETE.
> - الخطوة 7 (2026-10-13): الاختبارات الحية على Medplum وOpenAI نجحت، مع 3 إصلاحات.
> - الخطوة 8 (2026-10-13): أُصلحت قراءة التاريخ في الـread_back بشكل حتمي. المسار الصوتي الكامل نجح آليًا في الزمن الحقيقي. الاختبار اليدوي بالمايك عند صاحب المشروع.
> - الخطوة 9 (2026-10-18): فحوص الاستقلال الخمسة نجحت. نفس السيناريوهات نجحت على الذاكرة وعلى Medplum، والفرق بينهما الإعداد فقط (انظر "نتائج الخطوة 9").

---

## 1. السياق

مُجيب اليوم (Phase 0) حلقة صوتية كاملة تعمل محليًا:
`Mic → ElevenLabs STT → OpenAI (Responses API) → ElevenLabs TTS → Speaker`، وفيها مقاطعة، وقياس أزمنة، و79 اختبارًا (`npm run check`، 2026-10-12).

المطلوب الآن هو الانتقال من "محادثة" إلى "إجراءات" على نظام مواعيد: بحث، وحجز، وتعديل، وإلغاء، وتسجيل مريض جديد. يحدث ذلك من خلال أدوات مستقلة عن المزوّد، وMedplum هو أول HIS تجريبي خلف Adapter. والهدف إثبات أن استبدال Medplum لا يمس الـAgent ولا منطق الأعمال.

**قرارات صاحب المشروع:**
- **التعرّف على المريض:** البحث برقم الهوية أو رقم الجوال، والتحقق بتاريخ الميلاد.
  - هذه **سياسة تطوير فقط (dev-only)**، وليست مصادقة إنتاجية.
- **تسجيل مريض جديد:** ضمن النطاق.
- **التأكيد قبل أي كتابة:** يفرضه الخادم، ولا يُترك للـLLM.
- **اكتشاف الأطباء والخدمات:** ديناميكي من البداية عبر أدوات بحث محايدة.
- **الحفاظ على الموجود:** الـpipeline الصوتي الحالي، والاختبارات، وحدود الطبقات كما هي.

---

## 2. ما هو موجود اليوم (من فحص الكود)

| الموجود | الملاحظة |
|---|---|
| طبقات `core`، `ports`، `agent`، `voice`، `adapters`، `app`، `contracts` | يفرضها `tests/architecture/boundaries.test.ts` |
| `LanguageModel` port | **نص فقط:** لا `tools` في الطلب، ولا حدث `tool_call` |
| `OpenAiResponsesModel` | streaming مع `store:false`، وبلا function calling |
| `Conversation` | رسائل `user` و`assistant` نصية فقط، والقص بالعدد |
| `VoiceSession.llmText()` | طلب LLM واحد لكل دور |
| `normalizeArabic` في `src/voice/arabic-text.ts` | دالة نقية بلا dependencies. نحتاجها في `agent` و`adapters`، وهذه الطبقات لا تستطيع الاستيراد من `voice` |
| `instructions.md` | ينص على أن مُجيب "لا يقدر يحجز". يجب تحديثه |
| `DECISIONS.md` و`ROADMAP.md` و`CLAUDE.md` | تصنّف الحجز وربط HIS كـ"مستثنى". يجب تحديثها |
| لا شيء عن Medplum أو FHIR أو المواعيد | البداية من الصفر |

**Medplum (Beta):** فيه `Appointment/$find` و`$book` و`$reschedule` و`$cancel`. التوفر يُحسب ديناميكيًا من `SchedulingParameters`. و`$book` و`$reschedule` يمنعان الحجز المزدوج داخل transaction من نوع SERIALIZABLE. لذلك الـAdapter رفيع.

---

## 3. المعمارية

```
voice/VoiceSession ──► agent/agent-turn (tool loop) ──► LanguageModel port ──► adapters/openai
        │ (نص المتصل الموثوق + رقم دور المستخدم)
        ▼
agent/tools/AppointmentTools ── pending-actions ── confirmation-classifier ── dev verification policy
        │
        ▼
ports/scheduling: SchedulingSystem      ← عقد محايد (لا FHIR ولا Medplum)
   ▲                         ▲
adapters/fakes/memory-scheduling    adapters/medplum/*  (directory cache داخلي)
```

### 3.1 القرارات الأساسية
1. **Port واحد صغير اسمه `SchedulingSystem` (الـAdapter Pattern):** يُبنى على حالات الاستخدام الحالية فقط.
2. **منطق الأعمال في `AppointmentTools`:**
   - التحقق من الهوية.
   - ربط المواعيد بالمريض.
   - التأكيد.
   - التطبيع.
   - المنطقة الزمنية.
   - تقليص النتائج للصوت.
3. **Session-scoped references:**
   - النموذج لا يرى IDs الخاصة بالـHIS، بل مراجع قصيرة خاصة بالجلسة: `V1` للخدمة، و`D1` للطبيب، و`S1` للـslot، و`P1` للمريض، و`A1` للموعد، و`C1` للإجراء المعلق.
   - لا يستطيع اختراع كائن لم يُرجعه النظام.
4. **اكتشاف ديناميكي عبر أداة بحث (يحل البند 3 من المراجعة):**
   - لا نحمّل دليل المستشفى في الـcontext.
   - الأداة `search_clinic_directory` تبحث في الخدمات والأطباء من الـHIS عبر port محايد: `searchDirectory({ text, kind, serviceId, limit })`.
   - الـcache يقع **داخل الـadapter على الخادم** (TTL قابل للضبط)، وليس في context النموذج.
   - Medplum adapter: يقرأ `HealthcareService` و`Practitioner` و`Schedule` على صفحات، ويخزنها في cache، ويطابق محليًا باللغة العربية (همزات، "عبدالله"/"عبد الله"، حذف "د."/"دكتورة"). السبب أن البحث النصي في FHIR ضعيف مع المتغيرات العربية.
   - أي HIS آخر يستطيع تنفيذ نفس الـport عبر search API خاص به بدون تغيير الأدوات.
   - الحد: 5 نتائج للصوت، ومعها "يوجد أكثر" عند الحاجة.
5. **بدون dependency جديدة:**
   - `fetch` المدمج في Node 24، مع `zod` الموجود.
   - لا `@medplum/core`: نحتاج حوالي 9 endpoints، والـSDK يضيف ارتباطًا بالمزود، والـboundary test يسمح بـ`zod` فقط في الـadapters.
6. **التاريخ والوقت:**
   - `timezone` في الـprofile (`Asia/Riyadh`)، والتحويل بـ`Intl`.
   - كل طلب يحمل سطر "الآن" حتى يفهم النموذج "بكرة" و"الأحد الجاي".
7. **نقل `normalizeArabic` إلى `src/core/arabic-text.ts`:**
   - مع re-export من `src/voice/arabic-text.ts`، فلا يتغير أي import أو اختبار في `voice`.
   - اتجاه `voice → core` مسموح أصلًا.

### 3.2 الأدوات (9 أدوات)
الأدوات التي تغيّر بيانات لا تنفّذ شيئًا مباشرة، بل تنشئ **إجراءً معلقًا**. والتنفيذ يتم فقط عبر `confirm_pending_action`.

| Tool | النوع | المدخلات | المخرجات للنموذج |
|---|---|---|---|
| `search_clinic_directory` | قراءة | `query`، و`kind` (`service`/`practitioner`/`any`)، و`service_ref?` | حتى 5 نتائج: `{ref, name, kind, services?, gender?}` |
| `search_available_slots` | قراءة | `service_ref`، و`practitioner_ref?`، و`date_from`، و`date_to?`، و`part_of_day?`، و`for_appointment_ref?` | حتى 5 أوقات: `{ref, date, weekday, time, doctor}` |
| `find_patient` | قراءة | (`national_id` أو `phone`) + `birth_date` | `verified {ref, first_name}` أو `multiple` أو `not_verified` |
| `list_patient_appointments` | قراءة | `patient_ref` | المواعيد القادمة `{ref, date, time, doctor, service}` |
| `propose_registration` | اقتراح | `full_name`، و`national_id`، و`phone`، و`birth_date`، و`gender` | `confirmation_required {action_ref, read_back}` |
| `propose_booking` | اقتراح | `patient_ref`، و`slot_ref` | `confirmation_required {action_ref, read_back}` |
| `propose_reschedule` | اقتراح | `appointment_ref`، و`new_slot_ref` | `confirmation_required {action_ref, read_back}` |
| `propose_cancellation` | اقتراح | `appointment_ref`، و`reason` (nullable) | `confirmation_required {action_ref, read_back}` |
| `confirm_pending_action` | **تنفيذ** | `action_ref` فقط | `done {...}` أو `confirmation_unclear` أو `declined` أو `expired` أو `caller_confirmation_required` أو `stale_action` أو `slot_unavailable` أو `previous_action_unresolved` أو `outcome_unknown` |

### 3.3 آلية التأكيد في الـbackend (يحل البند 2 من المراجعة)
`PendingAction` يُخزن في الخادم لكل جلسة (`src/agent/tools/pending-actions.ts`) ويحتوي:
- `ref` و`kind`.
- `tenantId` و`sessionId`.
- `patientId`: المريض المُتحقق منه. في حالة التسجيل: بيانات التسجيل نفسها.
- `target`: الـslot token، أو `appointmentId` مع `version`.
- `fingerprint`: hash للحقول السابقة.
- `read_back`.
- `proposedInUserTurn` و`expiresAt`.

**قواعد التنفيذ عند استدعاء `confirm_pending_action`.** كلها فحوص في الكود، وأي فشل يعني عدم التنفيذ:
1. **إجراء واحد معلق لكل جلسة:** أي اقتراح جديد يلغي السابق. والـref صالح لاستخدام واحد فقط، ويجب ألا يكون منتهيًا (الافتراضي 120 ثانية، قابل للضبط).
2. **التأكيد يأتي من المتصل وفي الدور التالي بالضبط:**
   - التأكيد في **نفس الدور** الذي اقتُرح فيه الإجراء يُرفض بـ`caller_confirmation_required`، فالنموذج لا يستطيع أن يقترح ويؤكد بنفسه.
   - التأكيد بعد أكثر من دور واحد يعني أن الإجراء منتهٍ.
3. **التحقق من كلام المتصل الفعلي:**
   - المصدر نص المتصل الموثوق في الدور الحالي، القادم من STT عبر الـagent layer. **النموذج لا يمرره ولا يستطيع تزويره.**
   - `confirmation-classifier.ts` دالة نقية حتمية، تصنّف النص إلى `affirm` أو `deny` أو `unclear`:
     - **إيجابي سعودي:** "إيه"، "ايوه"، "نعم"، "أكيد"، "تمام"، "احجز"، "أوكي"، "يب"، "صح"، "أكّد"...
     - **نفي أو تردد أو تعديل:** "لا"، "لأ"، "مو"، "لحظة"، "انتظر"، "بس"، "غيّر"، "خلني أفكر"...
     - **قاعدة الأمان:** أي خليط من الإيجاب مع النفي أو التعديل يُصنّف `unclear`.
   - **حسب النتيجة:**
     - `affirm`: ننفّذ.
     - `deny`: يُلغى الإجراء.
     - `unclear`: **لا تنفيذ أبدًا**. يرجع `confirmation_unclear`، و**يُعاد تسليح** الإجراء نفسه للدور التالي، ويسأل النموذج سؤال نعم/لا صريح. الحد الأقصى مرتان (`maxReconfirmations`، قابل للضبط)، وبعدهما ينتهي الإجراء ويجب اقتراح جديد.
   - **طلب تأكيد جديد متاح دائمًا:** النموذج يستطيع استدعاء `propose_*` من جديد في أي وقت، فيحصل على `action_ref` جديد و`read_back` جديد، ويُلغى الإجراء السابق. هذا هو المسار الطبيعي إذا عدّل المتصل طلبه ("إيه بس خله الساعة خمس").
4. **الربط بالمريض والعملية بالضبط:**
   - التنفيذ يستخدم الـpayload المخزن فقط، وليس مدخلات جديدة من النموذج.
   - المريض المُتحقق منه في الجلسة يجب أن يساوي `patientId`.
   - **الحجز الجديد:** لا نعتمد على أي فحص version أو على بيانات وقت الاقتراح. التوفر يُتحقق منه **وقت التنفيذ** بالفحص الذري للـHIS نفسه:
     - Medplum: `$book` يعيد فحص الـcapacity والحجوبات داخل SERIALIZABLE transaction.
     - memory adapter: نفس الفحص داخل عملية واحدة.
     - أي تعارض يرجع `slot_unavailable`، ويعرض النموذج بحثًا جديدًا.
     - الأداة لا تنفذ "pre-check" منفصلًا ثم تكتب، لأن ذلك يفتح نافذة سباق.
   - **التعديل:** الوقت الجديد يتحقق منه `$reschedule` ذريًا وقت التنفيذ بنفس المبدأ.
   - **الإضافة على التعديل والإلغاء:** نعيد قراءة الموعد من الـHIS قبل التنفيذ. يجب أن يخص نفس المريض، وأن يكون `booked`، وأن يكون `version` لم يتغير. وإلا يُرفض بـ`stale_action`.
     - هذا فحص **إضافي** للمواعيد الموجودة فقط، ولا يحل محل تحقق الـHIS وقت التنفيذ.
5. **إذا لم يسمع المتصل شيئًا:** إذا أُلغي الدور المقترِح قبل أن يُسمع أي صوت منه (`user_continued`)، يُلغى الإجراء المعلق.
   - التنفيذ: hook صغير `onTurnFinalized` من `VoiceSession` إلى الأدوات.
6. **Idempotency وتتبع الكتابات الجارية (write ledger):** في `src/agent/tools/write-ledger.ts`، لكل جلسة:
   - **السجل:** كل كتابة تُرسل للـHIS تُسجَّل قبل الإرسال بالحقول `{action_ref, kind, patientId, idempotencyKey, status, startedAt, result?}`. والحالات الممكنة: `in_flight`، ثم واحدة من `succeeded` أو `failed` أو `unknown`.
   - **لا تُهمل أبدًا بسبب المقاطعة:**
     - طلب الكتابة **لا يرتبط بـAbortSignal الخاص بالدور**، وله مهلة مستقلة (`MUJEEB_SCHEDULING_WRITE_TIMEOUT_MS`).
     - مقاطعة المتصل، أو إلغاء الدور، أو إغلاق الجلسة: لا شيء منها يلغي الطلب.
     - عند إغلاق الجلسة ننتظر انتهاء الكتابات الجارية حتى مهلتها قبل الإغلاق النهائي، ونسجل نتيجتها.
   - **الحسم (reconcile):**
     - لا retry تلقائي للكتابة.
     - عند timeout أو 5xx أو انقطاع الشبكة تصبح الحالة `unknown`، ونحسم فورًا بالقراءة:
       - الحجز: نبحث عن موعد للمريض في نفس الوقت ومع نفس الطبيب.
       - التعديل: نقرأ الموعد ونقارن الوقت.
       - الإلغاء: الحالة `cancelled` تعني نجاحًا.
       - التسجيل: نبحث بالهوية.
     - إذا فشل الحسم الأول، نعيد المحاولة مرة في بداية الدور التالي، وقبل أي كتابة جديدة لنفس المريض.
   - **الحجب:** أثناء `in_flight` أو `unknown` تُرفض أي كتابة جديدة لنفس المريض بـ`previous_action_unresolved`. هذا يمنع الحجز المزدوج بسبب نتيجة غامضة.
   - **الإبلاغ:**
     - النتيجة النهائية تُسجَّل في سجل المحادثة وفي `tool.audit`.
     - إذا بقيت `unknown` يقولها مُجيب بصراحة ("ما قدرت أتأكد إذا انحجز، الموظف بيتأكد لك").
     - ويُكتب الحدث `scheduling.outcome_unresolved` للمتابعة اليدوية. التخزين الدائم للتدقيق مؤجل إلى Phase 2/3.
   - **المفتاح:** مشتق من `ref` و`fingerprint`، والإجراء single-use. وفي التسجيل، الـconditional create بالهوية idempotent بطبيعته.
7. **سجل تدقيق:** `tool.audit` لكل اقتراح وتأكيد وتنفيذ، ويحمل `kind` و`outcome` والـfingerprint hash. بدون PHI.

الـprompt يكمّل هذه القواعد ولا يستبدلها: يقرأ الـ`read_back` على المتصل، ويسأل نعم أو لا، ولا يقول "تم" إلا بعد `done`.

### 3.4 التحقق من هوية المريض: سياسة تطوير فقط
- **اسم صريح في الـprofile:**
  - `"patientVerification": "dev-identifier-dob"`.
  - zod enum بقيمة واحدة الآن، فأي قيمة أخرى تفشل في الإعدادات.
- **سجل عند بدء التشغيل:** `privacy.verification_policy: dev-only`. ويُذكر ذلك في `DECISIONS` كقرار تطوير، و**D2 يبقى مفتوحًا للإنتاج** (خيارات لاحقة مثل OTP أو مطابقة Caller ID أو التحويل لموظف).
- **منع كشف وجود المريض:**
  - `find_patient` يرجع نفس الرد عند "غير موجود" وعند "تاريخ الميلاد لا يطابق".
  - يرجع الاسم الأول فقط، بدون هوية أو جوال.
- **حد المحاولات:** 3 محاولات تحقق فاشلة في الجلسة، ثم تتوقف الأدوات ويقترح مُجيب التواصل مع الموظف.
- **الربط بالجلسة:** أدوات القراءة الخاصة بالمريض وكل الاقتراحات تتطلب `patient_ref` مُتحققًا منه في نفس الجلسة. والاستثناء `propose_registration`، والمريض الجديد يصبح مُتحققًا منه بعد تنفيذ تسجيله.
- **ضمن الـtenant:** الأدوات تُنشأ لكل جلسة من الـcomposition root ومربوطة بـ`TenantContext`، والـprofile فيه allowlist للأدوات.

### 3.5 حالة الأدوات في OpenAI Responses API مع `store:false` (يحل البند 4 من المراجعة)
حسب التوثيق الحالي لـOpenAI:
- يجب إعادة **كل** عناصر الـreasoning والـfunction_call والـfunction_call_output منذ آخر رسالة `user`، **بدون أي تعديل**.
- في الوضع stateless (`store:false`)، عناصر الـreasoning ترجع افتراضيًا ومعها `encrypted_content`.
- عند إعادة رسائل الـassistant يدويًا يجب الحفاظ على قيمة `phase` الأصلية (لعائلتي GPT-5.4 وGPT-5.5).
- الـreasoning المحفوظ يُعاد استخدامه داخل نفس عائلة النموذج فقط.

**التصميم:**
1. **الـport يبقى محايدًا:**
   - `LlmEvent` يضيف `tool_call {callId, name, arguments}` (موحّد).
   - `completed` يحمل `continuation?: { provider, model, items: unknown[] }`، وهو **مبهم** لا يفسّره الـdomain أبدًا. يُخزن ويُعاد كما هو.
2. **المصدر:** `response.completed → response.output`، وهو مصدر كل العناصر بترتيبها: reasoning، ثم message مع `phase`، ثم function_call.
   - النص يبقى يُبث فورًا من `response.output_text.delta` إلى TTS، فلا تأثير على الزمن.
3. **داخل الدور الحالي:** الطلب التالي يحمل:
   - كل `continuation.items` لكل جولة سابقة في نفس الدور، **حرفيًا وبالترتيب**.
   - بعدها `function_call_output` لكل `call_id`.
4. **حراسة الاتساق:**
   - لا يُرسل أي `function_call` بدون الـoutput الخاص به.
   - الجولة التي أُلغيت قبل اكتمال أداتها تُحذف بالكامل، مع الـreasoning الخاص بها.
   - القص في `Conversation` يتم **بحدود الأدوار** فقط.
5. **تغيّر النموذج:** إذا كان `continuation.model` مختلفًا عن النموذج المضبوط، نحذف عناصر الـreasoning ونبني `function_call` من البيانات الموحّدة.
6. **الأدوار السابقة:** تُحفظ كسجل مملوك لمُجيب:
   - نص المستخدم.
   - أزواج `function_call` و`function_call_output`.
   - نص الـassistant **الذي سُمع فعلًا** مع علامة المقاطعة (سلوك Phase 0 الحالي)، مع `phase: final_answer` حيث يدعمه النموذج.
   - الـreasoning من الأدوار السابقة لا يُعاد، وهذا يتوافق مع الافتراضي `current_turn` لعائلة GPT-5.4 المستخدمة حاليًا.
   - **إذا انتقلنا لنموذج افتراضيه `all_turns` (مثل GPT-5.6)** نسجل قرارًا: إما `reasoning.context: "current_turn"` صريحًا، أو حفظ العناصر الكاملة للأدوار السابقة.
7. **إعدادات الطلب:**
   - `parallel_tool_calls: false`.
   - `strict: true`، وكل الحقول `required`، و`additionalProperties: false`، والاختياري بنوع `null`. تُبنى من zod عبر `z.toJSONSchema`.
   - لا `include` إلا إذا أظهر الـlive test أن `encrypted_content` لا يرجع افتراضيًا. القيمة القديمة `reasoning.encrypted_content` ما زالت مقبولة.
8. **كتابة تكتمل بعد مقاطعة:**
   - لا نلغي طلب الـHIS؛ يكمل بمهلته الخاصة ويُتتبع في الـwrite ledger.
   - يُسجَّل نص المستخدم الأصلي، ثم زوج الأداة ونتيجتها (أو `unknown` بعد الحسم)، **قبل** الدور الجديد.
   - في هذه الحالة لا ندمج النص كـcarry-over، حتى يبقى الترتيب صحيحًا ويعرف النموذج أن الإجراء تم.

---

## 4. الملفات

### تعديل على ملفات موجودة
| الملف | التغيير |
|---|---|
| `src/voice/arabic-text.ts` | re-export من `core/arabic-text.ts` فقط، والسلوك لا يتغير |
| `src/ports/language-model.ts` | يُضاف `ToolSpec` و`tool_call`، و`ChatMessage` يصبح union يشمل أزواج الأدوات، و`continuation` مبهم. **الشكل الحالي `{role, text}` يبقى صالحًا** |
| `src/adapters/openai/responses-model.ts` | `tools` مع strict، والتقاط `response.output`، وإعادة العناصر حرفيًا، و`function_call_output`، و`phase`، و`parallel_tool_calls:false`، وفحص عائلة النموذج |
| `src/adapters/fakes/fake-llm.ts` | خيار `script` لإرجاع tool calls وcontinuation وهمي. الرد الافتراضي لا يتغير |
| `src/agent/conversation.ts` | يخزن أزواج الأدوات والـcontinuation للدور الحالي، والقص بحدود الأدوار، وسطر "الآن" |
| `src/voice/session.ts` | التغيير **إضافي فقط**: إذا مُرّرت `tools` يُستخدم `runAgentTurn`، وإلا يبقى المسار الحالي حرفيًا. التفاصيل: timeout لأول token لكل جولة، وتمرير نص المتصل ورقم الدور، و`onTurnFinalized`، وقاعدة الكتابة أثناء المقاطعة، وأحداث `tool` للـobserver |
| `src/observability/turn-timeline.ts` و`turn-metrics.ts` | يُضاف `tools_ms` و`llm_rounds` و`tool_calls[{name, ms, outcome, error_kind}]` (حقول إضافية) |
| `src/core/errors.ts` | `SchedulingError`: `not_found` و`slot_unavailable` و`invalid_state` و`already_exists` و`invalid_request` |
| `src/contracts/agent-profile.ts` و`profile.json` | يُضاف `timezone` و`tools` و`maxToolRounds` و`patientVerification` و`pendingActionTtlSec` (كلها بقيم افتراضية) |
| `config/agents/demo-clinic/instructions.md` | قواعد الأدوات: البحث بدل التخمين، وقراءة الـread_back، وسؤال نعم/لا، وعدم قول "تم" قبل `done`، وعبارة انتظار قصيرة |
| `src/config/settings.ts` و`.env.example` | `MUJEEB_SCHEDULING_PROVIDER=memory\|medplum` (الافتراضي `memory`)، و`MUJEEB_MEDPLUM_BASE_URL`، و`MEDPLUM_CLIENT_ID`، و`MEDPLUM_CLIENT_SECRET`، و`MUJEEB_SCHEDULING_TIMEOUT_MS`، و`MUJEEB_SCHEDULING_WRITE_TIMEOUT_MS`، و`MUJEEB_SCHEDULING_DIRECTORY_TTL_SEC`، و`MUJEEB_SCHEDULING_DATASET` |
| `src/app/container.ts` | `createScheduling(settings)`، وهو المكان الوحيد الذي يعرف `MedplumSchedulingSystem` |
| `src/app/dev-server.ts` | ينشئ `AppointmentTools` لكل جلسة |
| `src/app/cli.ts` و`package.json` | `seed-medplum [--dry-run] [--reset-appointments]` → `npm run seed:medplum` |
| `web/dev-client/app.js` و`style.css` | سطر لكل استدعاء أداة، وحالة الإجراء المعلق (مقترح، أو مؤكد، أو مرفوض، أو منتهٍ) |
| `tests/architecture/boundaries.test.ts` | **إضافات فقط:** فحص تسرب `medplum\|fhir`، وقصر استيراد `adapters/medplum` على `app/container.ts` و`app/cli.ts`، ومنع IDs بصيغة UUID في `src/` و`config/agents/`. جداول `ALLOWED` و`PACKAGES` **لا تتغير** |
| `docs/DECISIONS.md` | **A14** port وAdapter. **A15** Medplum مؤقت بلا SDK. **A16** الأدوات: refs، واكتشاف ديناميكي، وتأكيد في الخادم، ولا retry للكتابات. **A17** بيانات اصطناعية والتحقق dev-only (D2 مفتوح). **A18** إعادة عناصر OpenAI مع `store:false` |
| `docs/ROADMAP.md` و`CLAUDE.md` و`PROJECT_CONTEXT.md` §6 | النطاق الحالي: Phase 1 مع HIS تجريبي. الربط الحقيقي والحجز الحقيقي يبقيان في Phase 3 |

### ملفات جديدة
| الملف | الدور |
|---|---|
| `src/core/arabic-text.ts` | `normalizeArabic` و`tokenize` (منقولة) |
| `src/core/text-match.ts` | مطابقة نصية عربية للبحث: تطبيع، وحذف الألقاب، وترتيب النتائج. يستخدمها الـadapters |
| `src/core/zoned-time.ts` | التاريخ والوقت المحلي من وإلى instant بـ`Intl` |
| `src/ports/scheduling.ts` | `SchedulingSystem`: `searchDirectory`، و`findAvailability`، و`findPatients`، و`getAppointment`، و`listAppointments`، و`registerPatient`، و`book`، و`reschedule`، و`cancel`، مع أنواع محايدة (`Appointment` فيه `version` اختياري) |
| `src/contracts/appointment-tools.ts` | zod schemas للأدوات التسع، ومنها JSON Schema بصيغة strict |
| `src/contracts/scheduling-dataset.ts` | schema الـdataset المحايد |
| `src/agent/agent-turn.ts` | الـtool loop: جولات حتى `maxToolRounds`، وأحداث (`text`، و`tool_started`، و`tool_finished`، و`llm_request`)، بلا معرفة بالصوت |
| `src/agent/tools/appointment-tools.ts` | تنفيذ الأدوات وقواعدها، ويرجع JSON مختصرًا، ويكتب `tool.audit` |
| `src/agent/tools/pending-actions.ts` | تخزين الإجراءات المعلقة والـfingerprint والصلاحية والاستخدام الواحد وإعادة التسليح المحدودة |
| `src/agent/tools/write-ledger.ts` | تتبع الكتابات الجارية بالحالات `in_flight` و`succeeded` و`failed` و`unknown`، والحسم بالقراءة، وحجب الكتابات لنفس المريض، والانتظار عند إغلاق الجلسة |
| `src/agent/tools/confirmation-classifier.ts` | `affirm` أو `deny` أو `unclear` (دالة نقية) |
| `src/agent/tools/patient-verification.ts` | سياسة `dev-identifier-dob` وحد المحاولات |
| `src/agent/tools/session-refs.ts` و`normalize.ts` | المراجع القصيرة، وتطبيع الجوال والهوية |
| `src/adapters/fakes/memory-scheduling.ts` | HIS في الذاكرة: توفر، وتعارض، وversioning، وfault injection |
| `src/adapters/medplum/client.ts` | FHIR client: OAuth client-credentials، وcache للـtoken، وtimeouts، وإلغاء، وتحويل `OperationOutcome` إلى أخطاء |
| `src/adapters/medplum/fhir-schemas.ts` | zod للموارد التي نقرؤها فقط |
| `src/adapters/medplum/medplum-scheduling.ts` | تنفيذ الـport مع directory cache |
| `src/adapters/medplum/seed.ts` | dataset محايد إلى قائمة موارد مرتبة حسب الاعتماديات، كل مورد بطلب conditional create مستقل، ثم حجب الإجازة، ثم `$book` للمواعيد (التفاصيل في "ملاحظات preflight الخطوة 6") |
| `config/test-data/demo-clinic.dataset.json` | بيانات اصطناعية بمفاتيح وصفية |
| `tests/contract/scheduling-system.contract.ts` | suite واحد لكل adapter |
| `docs/MANUAL_SCHEDULING_TESTS.md` | مصفوفة صوتية يدوية |

### تحويل العمليات في Medplum Adapter
| `SchedulingSystem` | Medplum |
|---|---|
| `searchDirectory()` | cache بـTTL من `HealthcareService?active=true` و`Schedule?active=true` (قراءة `service-type-reference`) و`Practitioner`، ثم مطابقة عربية محلية |
| `findAvailability()` | `GET Appointment/$find` لكل `Schedule` على حدة، بالتوازي مع حد أقصى 4 طلبات. السبب أن تكرار الـ`schedule` يعني تقاطع الموارد وليس "أي طبيب". بعدها دمج وترتيب وقص. وعند التعديل نمرر `ignore-appointment`. والنافذة لا تتجاوز 14 يومًا |
| `findPatients()` | `Patient?identifier=<system>\|<id>` أو `Patient?phone=...` |
| `getAppointment()` و`listAppointments()` | `Appointment/{id}` (مع `meta.versionId` كـ`version`)، و`Appointment?patient=…&date=ge…&status=booked,pending` |
| `registerPatient()` | `POST Patient` مع `If-None-Exist` بالهوية |
| `book()` و`reschedule()` و`cancel()` | `$book` بالـAppointment المقترح من `$find`، و`Appointment/{id}/$reschedule`، و`Appointment/{id}/$cancel` |

> الـ`identifier systems` إعدادات للـadapter. وكل الـstatus codes ونصوص الـOperationOutcome تُثبَّت بـfixtures، لأن الـAPI في مرحلة Beta.

---

## 5. بيانات الاختبار (مصغّرة، يحل البند 1 من المراجعة)

ملف **محايد** واحد في `config/test-data/demo-clinic.dataset.json`، يغذي الـmemory adapter وسكربت الـseed معًا. التواريخ فيه نسبية (`dayOffset` + `time`).

| العنصر | المحتوى | السيناريو الذي يغطيه |
|---|---|---|
| المنشأة | عيادة واحدة وموقع واحد | — |
| الخدمات | 3: طب الأسرة (20 دقيقة)، والأطفال (20)، والجلدية (30) | البحث عن تخصص، واختلاف المدد |
| الأطباء | 4: طب الأسرة 1 (مسائي فقط)، والأطفال 2 (طبيب وطبيبة)، والجلدية 1 (طبيبة) | الاختيار بين طبيبين، و"أبي دكتورة"، و"العصر" |
| الحجوبات | إجازة 3 أيام لطبيبة الجلدية | "لا يوجد متاح" واقتراح موعد بديل |
| المرضى | 5: (أ) بموعد قادم واحد، و(ب) بموعدين قادمين، و(ج) أم و(د) طفلها على نفس الجوال، و(هـ) بلا مواعيد | التعديل والإلغاء، و"أي موعد؟"، و`multiple`، وحجز للطفل، وحجز جديد |
| المواعيد | 4 مواعيد مستقبلية تُحجز عبر `$book`: (أ)×1، و(ب)×2، و(د)×1 | عرض المواعيد والتعارض |
| مريض جديد | لا يحتاج بيانات مسبقة، بل هوية جديدة وقت الاختبار | `propose_registration` |

**ضوابط البيانات الاصطناعية:**
- أرقام الهوية بـchecksum خاطئ عمدًا.
- الجوالات بنمط وهمي واضح.
- كل مورد يحمل `meta.tag` (`urn:mujeeb:tag|synthetic-seed`) و`identifier` (`urn:mujeeb:seed-key|<key>`).

**سكربت الـseed** (حُدّث في preflight الخطوة 6):
- **dry-run افتراضيًا:** يكتب الـplan في `logs/` للمراجعة، ولا يتصل بالشبكة.
- **بلا transaction:** كل مورد يُبحث عنه بالـseed-key، ويُنشأ بـ`If-None-Exist` إذا لم يوجد. المراجع تستخدم الـIDs الحقيقية. إعادة التشغيل تكمل من حيث توقف التشغيل السابق، بدون تكرار.
- **حجب الإجازة:** Slot واحد لكل seed-key ثابت، يُنقل في مكانه بتحديث مشروط بالـversion.
- **`--reset-appointments`:** يلغي فقط مواعيد الـseed نفسه، أي التي تحمل الـseed-key والـtag معًا، **ولم تتغير منذ حجزها** (نسخة واحدة في `_history`). ما عدا ذلك يبقى.
- يتحقق تلقائيًا بـ`$find` لكل طبيب.
- **لا يلمس الموارد اليدوية**، ولا يعيد كتابة أي مورد موجود.

**صلاحيات Medplum:**
- **الـruntime:**
  - `Slot`: `create` و`read` و`search` و`delete`، لأن `$reschedule` و`$cancel` يرجعان 403 بدونها.
  - `Appointment`: `read` و`update` و`search`.
  - `Patient`: `read` و`search` و`create`.
  - قراءة الدليل.
- **الـseed يحتاج إضافة إلى ذلك:**
  - `create` و`search` على Organization وLocation وHealthcareService وPractitioner وSchedule.
  - `update` على `Slot`، لنقل حجب الإجازة.
  - `create` على `Appointment`، عبر `$book`.
  - `history` على `Appointment`، للـreset. بدونها لا يُلغى شيء.

نراجع `AccessPolicy` الخاص بـ`Mujeb Backend` قبل تنفيذ الخطوة 6.

---

## 6. خطة التنفيذ المرحلية

كل خطوة تنتهي بـ`npm run check` أخضر، و**عدد الاختبارات الحالية لا ينقص ولا يُعدّل منها شيء**. ولا API خارجي حتى الخطوة 6.

| # | الخطوة | النتيجة |
|---|---|---|
| 0 | ✅ **منفذة (2026-10-12):** تحديث `DECISIONS` (A14 إلى A18) و`ROADMAP` و`CLAUDE.md` و`PROJECT_CONTEXT` | الوثائق متسقة |
| 1 | ✅ **منفذة (2026-10-12):** نقل `normalizeArabic` إلى `core` مع re-export، و`zoned-time`، و`text-match`، و`ports/scheduling.ts`، و`SchedulingError`، والـdataset وschema الخاص به، و`memory-scheduling`، والـcontract suite على الذاكرة. النتيجة: `npm run check` أخضر بـ162 اختبارًا (79 أساسية بدون تغيير + 83 جديدة)، وانظر "ملاحظات تنفيذ الخطوة 1" | HIS وهمي مختبر |
| 2 | ✅ **منفذة (2026-10-12):** الأدوات: `session-refs`، و`normalize`، و`patient-verification`، و`pending-actions`، و`confirmation-classifier`، و`write-ledger`، و`appointment-tools`، مع unit tests للقواعد (القسم 7) | أدوات مُجيب مستقلة |
| 3 | ✅ **منفذة (2026-10-12):** tool calling في الـport والـOpenAI adapter، والـcontinuation، و`fake-llm script`، والـ`Conversation`، مع اختبارات SSE محلية للإعادة الحرفية | النموذج يستدعي الأدوات بحالة صحيحة |
| 4 | ✅ **منفذة (2026-10-12):** `agent-turn.ts` وربطه الإضافي بـ`VoiceSession`، وأحداث الواجهة، و`tools_ms`، و`instructions.md`. واختياريًا `npm run chat` (نصي) | **محطة A:** دورة كاملة بالصوت على HIS الذاكرة |
| 5 | ✅ **منفذة (2026-10-12):** Medplum adapter مع fixtures، وتحديث boundaries، و`seed.ts --dry-run` | adapter جاهز بدون اتصال |
| 6 | ✅ **منفذة (2026-10-13):** مراجعة الـdry-run، ثم تنفيذ الـseed، ثم تحقق `$find`. انظر "ملاحظات preflight الخطوة 6" و"نتائج تنفيذ الخطوة 6" | بيانات في Medplum |
| 7 | ✅ **منفذة (2026-10-13)، انظر "نتائج الخطوة 7":** اختبارات حية: (أ) الـcontract على Medplum بما فيه التعارض والإلغاء المزدوج والتسجيل المكرر. (ب) جولتا أدوات حقيقيتان مع OpenAI و`store:false` للتأكد من عدم وجود خطأ، ومن رجوع `encrypted_content`، ومن الحفاظ على `phase` | تثبيت سلوك Medplum وOpenAI الفعلي |
| 8 | ✅ **منفذة آليًا (2026-10-13)، انظر "نتائج الخطوة 8":** تشغيل الواجهة الصوتية مع `MUJEEB_SCHEDULING_PROVIDER=medplum`، والمصفوفة اليدوية (`docs/MANUAL_SCHEDULING_TESTS.md`، عند صاحب المشروع)، والقياس | **محطة B** |
| 9 | ✅ **منفذة (2026-10-18)، انظر "نتائج الخطوة 9":** التحقق من الاستقلال وعدم الكسر (القسم 8) وتسجيل النتائج | دليل قابلية الاستبدال |

### ملاحظات تنفيذ الخطوة 1 (انحرافات صغيرة عن النص أعلاه)
- **ملفات إضافية:**
  - `src/core/identifiers.ts`: صيغ الهوية والجوال المعيارية، والـchecksum الذي يضمن أن البيانات اصطناعية.
  - `src/app/scheduling-dataset.ts`: loader بنفس نمط `loadAgentProfile`.
  - الربط بالإعدادات والـcontainer (`MUJEEB_SCHEDULING_PROVIDER` ومسار الـdataset) **لم يتم بعد**، ويأتي مع الخطوة 4.
- **المواعيد في الـdataset تُحدد بـ`workday`** (اليوم رقم N الذي يعمل فيه الطبيب، بدون أيام الحجب)، وليس `dayOffset` تقويميًا.
  - السبب: الإزاحة التقويمية قد تقع جمعة أو سبت حسب يوم التشغيل.
  - الحجوبات بقيت بإزاحة تقويمية.
- **إضافات على الـport:**
  - `capabilities.idempotencyKeys`: لأن حفظ `$book` للـidentifier في Medplum غير مؤكد. اختبار الإعادة في الـcontract يعمل فقط إذا كانت القيمة `true`.
  - أسماء الطبيب والخدمة داخل `AvailableSlot` و`AppointmentRecord`، لقراءة الـread_back بدون استعلام إضافي.
  - الثابتان `MAX_AVAILABILITY_WINDOW_DAYS = 14` و`MAX_RESULTS_LIMIT = 50`.
  - `idempotencyKey` في `registerPatient` أيضًا.
- **الـtenant الخاطئ** يعطي `ProviderError` من نوع `auth` وغير قابل للإعادة.
- **الـfault injection في الـmemory adapter** يدعم `afterCommit`: الكتابة تُطبق ثم يُرمى خطأ. هذا يحاكي النتيجة الغامضة التي يحتاجها الـwrite-ledger في الخطوة 2.
- **قُدّم من الخطوة 5:** فحص التسرب `medplum|fhir` في `boundaries.test.ts`، ويشمل الآن `contracts`. باقي إضافات الـboundaries تبقى في الخطوة 5.
- **قيد معروف:** المطابقة النصية تعتمد على التطبيع وعلى الـprefix فقط، بدون تسامح مع الأخطاء الإملائية من STT (edit distance). نضيف ذلك فقط إذا أظهرت الاختبارات الصوتية حاجة إليه.

### ملاحظات تنفيذ الخطوة 2
- **`src/contracts/appointment-tools.ts` نُفذ هنا:** schemas الأدوات التسع مع JSON Schema بصيغة strict. ربطها بالـLLM يتم في الخطوة 3.
- **إضافة على الـcore:** `withDeadline` في `src/core/async.ts`، لدمج إلغاء الدور مع مهلة، أو مهلة وحدها للكتابات.
- **المصنِّف محافظ عمدًا (قائمة بيضاء):**
  - ينفذ فقط إذا كان الرد كلمات إيجاب ومجاملة.
  - أي كلمة غير معروفة، أو وقت، أو رقم، أو سؤال يعطي `unclear`.
  - أفعال العمليات خاصة بكل عملية: "ألغيه" تأكيد للإلغاء فقط.
  - القوائم ستُضبط من نتائج الاختبار الصوتي.
- **`multiple` يظهر فقط إذا تطابق أكثر من سجل مع تاريخ الميلاد أيضًا.** جوال العائلة يُحسم بتاريخ الميلاد.
- **الجوال:** جوالات سعودية بأي صيغة شائعة، أو أرقام دولية بصيغة E.164. الأرقام الأرضية السعودية تُرفض.
- **الحسم (reconcile):** محاولتان كحد أقصى، الأولى فورًا والثانية لاحقًا عبر `reconcileUnresolved()` أو قبل أي كتابة جديدة لنفس المريض. بعدها تبقى الحالة `unknown` ويبقى المريض محجوبًا طوال الجلسة.
- **مسار الكتابة بعد التأكيد مفصول عن إلغاء الدور بالكامل.** هذا يشمل قراءة التحقق من `version` قبل التعديل أو الإلغاء.
- **قيد معروف (سياسة التطوير):** `already_exists` في التسجيل يكشف أن رقم هوية مسجل. هذا مقبول مع بيانات اصطناعية، ويُراجع ضمن D2.
- **لم يُربط بعد (الخطوة 4):**
  - حقول الـprofile: `timezone`، وallowlist الأدوات، و`patientVerification`، ومدة صلاحية الإجراء المعلق.
  - المهل في الإعدادات.
  - استدعاء `onTurnFinalized` و`reconcileUnresolved` و`drain` من `VoiceSession`.

### ملاحظات تنفيذ الخطوة 3
- **الـtool calls تصل داخل حدث `completed` نفسه**، ومعها الـ`continuation`، ولا يوجد لها حدث مستقل. السببان:
  - الـcalls لا تكتمل إلا بنهاية الجولة أصلًا.
  - الكود النصي الحالي، ومنه `VoiceSession`، يبقى يعمل بدون أي تعديل.
  
  الـ`continuation` يُرفق فقط إذا وُجدت calls، فالطلبات النصية لم يتغير شكلها.
- **مصدر العناصر:** تُؤخذ من `response.output_item.done` حسب توصية الـSDK، لأن `encrypted_content` يكون نهائيًا هناك. وإذا لم تصل هذه الأحداث، تُؤخذ من `response.completed`.
- **عند إعادة الإرسال:** يُحذف أي reasoning بدون `encrypted_content`، لأنه لا يمكن إعادته مع `store:false`. ويُحذف أي `function_call` بدون نتيجة.
- **الرد المقطوع (`response.incomplete`) لا يُنفَّذ منه أي call**، لأن مدخلاته قد تكون مقطوعة.
  - ⚠️ **خطر للخطوة 4:** `MUJEEB_LLM_MAX_OUTPUT_TOKENS=300` يشمل tokens الـreasoning، وجولات الأدوات قد تتجاوزه. يُقاس ويُعدل.
- **`assistantPhase`** خيار في الـadapter، وقيمته الافتراضية `false`. يضيف `phase: 'final_answer'` لنصوص الـassistant السابقة. تفعيله قرار للخطوة 4، ويُتحقق منه حيًا في الخطوة 7.
- **لا يُرسل `include`:** التوثيق يقول إن `encrypted_content` يرجع افتراضيًا في الوضع stateless. يُتحقق من ذلك في الخطوة 7.
- **`ToolExchange` يعلن `role` و`text` كحقلين لا يُضبطان أبدًا (`undefined`).** هذا يسمح للكود النصي الموجود، ومنه اختبارات Phase 0، بالقراءة من أي عنصر بدون تعديل.
- **`Conversation`:**
  - `snapshot()` بقي transcript نصيًا.
  - `entries()` يعطي التاريخ كاملًا.
  - `commitTurn()` يحفظ الدور بشكل مختصر بدون الـcontinuation.
  - `request(..., { currentTurn, tools, context })`.
  - القص يتم بأدوار كاملة.
- **`FakeLanguageModel`:** أُضيف خيار `script` لجولات متعددة فيها tool calls وcontinuation وهمي، والرد الافتراضي لم يتغير.

### ملاحظات تنفيذ الخطوة 4
- **`AgentTurn` يعمل كمهمة مستقلة عن مستهلك الصوت.** عند المقاطعة يتوقف الاستماع لمخرجاته، لكن الكتابة التي بدأت تكتمل وتُسجَّل.
  - لا تبدأ أي أداة جديدة بعد إلغاء الدور.
  - حد الجولات (`maxToolRounds`، الافتراضي 5 من الـprofile): بعده يُطلب رد نصي بـ`toolChoice: none`.
  - مهلة أول حدث تُطبق لكل جولة.
- **مهلة سماح قبل أي كتابة مؤكدة:** `MUJEEB_TOOL_CONFIRM_GRACE_MS`، الافتراضي 400ms. إذا واصل المتصل الكلام ("إيه… بس") خلالها، يُلغى الدور قبل أي تغيير، ويُدمج الكلام مع **نفس رقم الدور**، فيُصنَّف الرد الكامل `unclear`.
- **رقم دور المتصل (`userTurn`):** يزيد مع كل عبارة جديدة، ويبقى كما هو عند دمج الكلام المستمر (carry-over).
  - إذا ألغي دور نفّذ كتابة، **لا يُدمج كلامه**. يُسجَّل الدور كما هو، والكتابة المتأخرة تُسجَّل قبل الدور التالي.
  - `prepareAgentTurn` ينتظر كتابات الدور السابق، ثم يسجلها، ثم يحسم النتائج المجهولة ويبلغ النموذج بـ"تحديث من النظام".
- **`onTurnFinalized`:** يُستدعى مع `heardAnything`، أي هل سُمع أي صوت من الدور.
- **إغلاق الجلسة (`close()`):** ينتظر الكتابات الجارية حتى `toolDrainTimeoutMs`، وقيمتها في الـdev server مهلة الكتابة + مهلتا قراءة.
- **عبارة الانتظار:** `CHUNK_FLUSH` في الـchunker، وهو إضافة لا تؤثر على المسار النصي. تُنطق العبارة قبل انتظار الأداة حتى لو كانت قصيرة أو بدون ترقيم.
- **ميزانية الـtokens:** `MUJEEB_LLM_MAX_OUTPUT_TOKENS_TOOLS=1024` تُستخدم لكل طلب فيه أدوات. أما `MUJEEB_LLM_MAX_OUTPUT_TOKENS=300` فبقي للمسار النصي فقط.
- **`MUJEEB_LLM_ASSISTANT_PHASE=true`** افتراضيًا (عائلة GPT-5.4). يحافظ على `phase` الأصلية في العناصر المعادة حرفيًا، ويضع `final_answer` على نصوص الـassistant السابقة فقط. يُتحقق منه حيًا في الخطوة 7.
- **الإعدادات:** `MUJEEB_SCHEDULING_PROVIDER=memory|none`، والافتراضي `memory`. القيمة `none` تعيد سلوك Phase 0 حرفيًا.
- **الـprofile:** أُضيف `timezone` وقسم `appointmentTools` (allowlist، و`patientVerification`، والحدود). قواعد الأدوات في `tools.md` وتُضاف للتعليمات **فقط** عند تفعيل الأدوات، و`instructions.md` صار صحيحًا في الوضعين.
- **المقاييس:** `turn.summary` يحمل `llm_rounds` و`tool_calls[{name, outcome, ms}]` و`durations_ms.tools_ms`، و`npm run report` يعرض `tools_ms`.
- **الواجهة:** سطر لكل أداة في المحادثة (الاسم، والنتيجة، والزمن)، وبطاقة "زمن الأدوات"، وعمود `tools`، وفلتر `TOOL`، والتفاصيل في صف الدور.
- **ملاحظة جانبية:** الـlogger يخفي أي مفتاح يحتوي "token"، لذلك سُميت مفاتيح الميزانية في `describeSettings` بـ`output_budget`.

### ملاحظات تنفيذ الخطوة 5
- **الملفات:** `src/adapters/medplum/` (`client.ts` و`fhir-schemas.ts` و`medplum-scheduling.ts` و`seed.ts`)، و`src/app/medplum-seed-command.ts`. لا SDK، فقط `fetch` و`zod`.
  - **انحراف عن الخطة:** الذي يستورد الـadapter هو `container.ts` و`medplum-seed-command.ts`، وليس `cli.ts` مباشرة. والـboundaries test يفرض هذا.
- **الـclient:**
  - OAuth `client_credentials` مع token محفوظ، يُطلب بطلب واحد مشترك، ويُجدد قبل انتهائه.
  - عند 401 يُجدد الـtoken ويُعاد الطلب مرة واحدة فقط، وهذا آمن لأن الخادم رفض الطلب قبل تنفيذه.
  - القراءات تُعاد مرة واحدة عند أخطاء عابرة: 429 أو 502 إلى 504 أو انقطاع الاتصال.
  - **الكتابات لا تُعاد أبدًا.**
  - الإلغاء يتم بالـ`AbortSignal`.
  - الـlogs لا تحتوي IDs ولا query strings ولا أسرار.
- **تحويل الأخطاء:** يعتمد على الـstatus مع نص الـ`OperationOutcome`:
  - "not available" → `slot_unavailable`.
  - "cannot be canceled/rescheduled in" → `invalid_state`.
  - 404 → `not_found`.
  - 412 → `already_exists`.
  - 401 و403 → `auth`.
  - 5xx → `ProviderError unavailable`، وهذا خطأ غامض يُحسم بالقراءة.
  - **يُثبت حيًا في الخطوة 7.**
- **`$find`:** طلب لكل Schedule على حدة، بحد أقصى 4 طلبات بالتوازي، ثم دمج النتائج. السبب أن عدة `schedule` في طلب واحد تعني تقاطع الموارد.
- **`$reschedule`:** يُرسل الوقت الجديد ومعه **مجموعة الـschedules الكاملة** للوقت المقترح (الـschedules في الـSlots المضمّنة + الـschedule الذي وُجد عليه الوقت).
  - يرفض الـadapter تعديل موعد فيه موارد غير المريض والطبيب (Location أو Device)، حتى لا تُحذف هذه الموارد بصمت. **هذا قيد معروف.**
- **أشكال الردود:**
  - `$book` و`$reschedule` → Bundle.
  - `$cancel` → Appointment مباشرة.
  - القراءة متسامحة إذا اختلف الشكل ووُجد Appointment. وإذا لم يوجد Appointment → `bad_response`، وهذا خطأ غامض يُحسم بالقراءة.
- **الـidempotency:**
  - `capabilities.idempotencyKeys=false`.
  - `$book` يُرسل له `identifier` بمفتاح الـidempotency، لكن حفظه غير مؤكد.
  - التسجيل idempotent: `If-None-Exist` بالهوية، والرد 200 يعني `already_exists`، إلا إذا كان السجل يحمل مفتاحنا نفسه.
- **طلبات إضافية:** `book` و`listAppointments` يقرآن الـPatient أولًا، لضمان `not_found` حسب العقد. هذا طلب GET إضافي.
- **الدليل:** cache بـ`MUJEEB_SCHEDULING_DIRECTORY_TTL_SEC`. يُدعم فقط actor من نوع Practitioner، وليس PractitionerRole (**قيد معروف**).
- **نظام هوية المريض:** قابل للضبط عبر `MUJEEB_MEDPLUM_NATIONAL_ID_SYSTEM`، والـseed يستخدم نفس القيمة.
- **الـseed:**
  - **الافتراضي dry-run** ولا يتصل بالشبكة. الكتابة تتطلب `--apply` صراحة، وهذا انحراف عن صياغة الخطة (`--dry-run`) لزيادة الأمان. و`--reset-appointments` يتطلب `--apply`.
  - ~~transaction واحدة من conditional creates~~. **استُبدلت في preflight الخطوة 6** بإنشاء متسلسل، لأن Medplum يحد الـtransaction التي فيها عمليات مشروطة بـ8 entries. المواعيد تُحجز عبر الـadapter نفسه (`$find` ثم `$book`)، ثم يُتحقق من وجود أوقات متاحة.
  - **لم يُنفذ على Medplum.**
- **الإعدادات:**
  - `MUJEEB_SCHEDULING_PROVIDER=medplum` يتطلب `MEDPLUM_CLIENT_ID` و`MEDPLUM_CLIENT_SECRET`. رسالة الخطأ تذكر الـprovider، وهي سبب نجاح اختبار من الخطوة 4 كان يتوقع رفض `medplum`؛ قصد ذلك الاختبار تجاوزته هذه الخطوة.
  - الـTTL موجود في `settings.medplum`.
- **لم يُختبر حيًا (الخطوة 7):**
  - الـstatus الفعلي للتعارض.
  - حفظ الـidentifier في `$book`.
  - وجود `serviceType` في نتائج `$find`.
  - بحث `phone` و`_id` بقائمة مفصولة بفواصل.
  - ~~سلوك الـtransaction مع `ifNoneExist` ومراجع `urn:uuid`~~. لم يعد مستخدمًا (preflight الخطوة 6).
  - صلاحيات `AccessPolicy` (حذف Slot).
- **مراجعة نهائية قبل التسليم (إصلاحات مع اختبار لكل منها):**
  - `book` و`reschedule` و`cancel` تحمّل الدليل **قبل** الكتابة. بدون ذلك، فشل تحميل الدليل بعد كتابة ناجحة كان سيجعلها تبدو فاشلة.
  - `listAppointments` لا يرسل `status=` فارغًا.
  - token الـslot التالف يعطي `invalid_request` بدل `ZodError` خام.
  - `$find` يقبل Bundle مباشرة إلى جانب `Parameters`.
  - الـseed يأخذ أول resource من النوع المطلوب في نتيجة البحث، ولا يتأثر بوجود `OperationOutcome`.
  - فشل فحص التوفر في الـseed يُسجَّل في التقرير ولا يُفشل التنفيذ كله.
  - أمر الـseed يستخدم مدة الـcache العادية بدل 0.
  - الـlog يصف طلب الـtransaction بـ`(transaction)`.
- ~~**قيد معروف في الـseed:** حجب الإجازة مرتبط بيوم التشغيل…~~ **حُلّ في preflight الخطوة 6:** صار Slot واحدًا يُنقل في مكانه.

### ملاحظات preflight الخطوة 6 (2026-10-13)
لا اتصال بـMedplum ولا `--apply`. التحقق محلي فقط: dry-run وfake داخل العملية.

- **سبب تغيير الاستراتيجية:** حسب توثيق Medplum (fhir-batch-requests):
  - الـtransaction التي فيها عمليات مشروطة (`ifNoneExist`) **محدودة بـ8 entries**، وتعطي `400` إذا تجاوزتها. الـseed كان يرسل 18.
  - الـtransactions تتطلب أن يفعّل super admin الـflag `transaction-bundles` للمشروع، وبدونه تُعالج كـbatch بلا atomicity.
  - سلوك `urn:uuid` عندما يطابق الـconditional create موردًا موجودًا غير موثق.
- **الـplan (dry-run):** صار يحتوي `resources`، وهي قائمة مرتبة حسب الاعتماديات (Organization ← Location ← HealthcareService ← Practitioner ← Schedule ← Patient)، و`blocks`، و`appointments`.
  - لكل مورد `key` و`dependsOn`.
  - المراجع داخل الـplan تُكتب كـconditional references (`Type?identifier=urn:mujeeb:seed-key|<key>`)، وتُستبدل بـ`Type/<id>` الحقيقي قبل الإرسال.
  - لا `urn:uuid` ولا `transaction`.
- **التنفيذ:** طلب واحد لكل عملية، ولكل عملية مهلة مستقلة (15s افتراضيًا)، والتشغيل كله محدود بـ180s.
  - **الموارد:** بحث بالـseed-key. إذا وُجد مورد واحد يُعاد استخدامه **ولا يُعاد كتابته**. إذا وُجد أكثر من مورد يُسجّل `failed` ولا يُلمس شيء. إذا لم يوجد يُنشأ بـ`POST` مع `If-None-Exist`.
  - **النتائج:** كل عملية تُسجَّل كـ`failed` (لم تُطبق قطعًا) أو `uncertain` (قد تكون طُبقت). الرد الغامض (timeout أو 5xx) يُحسم بقراءة واحدة. أي عمل يعتمد على مورد غير محسوم يُتخطى.
  - **التقرير:** فيه `complete`، والـCLI يرجع exit code 1 إذا لم يكتمل التشغيل.
- **حجب الإجازة:**
  - seed-key ثابت بلا تاريخ.
  - إذا لم يوجد الـSlot يُنشأ. إذا اختلفت التواريخ يُنقل بـ`PUT` مع `If-Match: W/"<versionId>"`، ويتغير فقط ما يديره الـseed (schedule وstatus وstart وend وcomment)، وتبقى باقي الحقول.
  - تعارض الـversion (412) يعطي `failed` "changed since it was read"، ولا يُنقل الحجب.
  - Slot يحمل الـseed-key بلا الـtag يُترك، لأن ملكيته غير واضحة.
- **مواعيد الـseed:**
  - تُحجز بـ`bookMarked()`، وهي method خاصة بـMedplum وليست في الـport. تضيف identifier `urn:mujeeb:seed-key|appointment:<key>` والـtag `synthetic-seed`.
  - `book()` العادي، أي حجوزات مُجيب، لا يحمل أي marker.
  - بعد الحجز يُقرأ الموعد: إذا لم يحتفظ Medplum بالـmarkers يُسجَّل في `unmarked`.
  - إعادة التشغيل في يوم آخر لا تضيف مواعيد، إذ يبقى موعد seed قادم واحد لكل key.
- **`--reset-appointments`:** يُلغى الموعد فقط إذا توفرت الشروط الخمسة معًا:
  1. يحمل الـseed-key والـtag.
  2. حالته booked أو pending.
  3. مستقبلي.
  4. يخص مريضًا من مرضى الـseed.
  5. **له نسخة واحدة في `_history`**، أي أنه لم يتغير منذ `$book`.

  ما عدا ذلك يبقى ويُذكر سببه في `kept`:
  - تعديل عبر مُجيب أو يدويًا.
  - تاريخ غير مقروء، وهذه حالة غامضة لا يُلغى فيها شيء.

  المواعيد التي لم ينشئها الـseed لا تُلمس أبدًا (`notSeeded`). إلغاء غير مؤكد يُسجَّل `uncertain`، ولا يُعاد حجز ذلك الموعد في نفس التشغيل.
- **الاختبارات:** [tests/integration/medplum-seed.test.ts](../tests/integration/medplum-seed.test.ts) بـ22 اختبارًا، تغطي:
  - الإنشاء المتسلسل بـIDs حقيقية.
  - إعادة التشغيل بدون كتابة أو تكرار.
  - رفض مورد وإكماله في تشغيل لاحق.
  - رد ضائع لإنشاء أو حجز يُحسم بالقراءة.
  - حالات الـreset: مواعيد مُجيب، وموعد معدّل، وتاريخ غير مقروء، وإلغاء غامض، وmarkers لم تُحفظ.
  - نقل حجب الإجازة مع `If-Match`، وتعارض الـversion، والملكية غير الواضحة.

  الـfake يرفض أي جسم فيه `urn:uuid` أو مرجع غير محسوم أو مرجع لمورد غير موجود.
- **غير مؤكد حيًا (أول `--apply`):**
  - قبول `If-None-Exist` على كل نوع.
  - حفظ `$book` للـidentifier والـ`meta.tag`. التقرير يكشفه عبر `unmarked`.
  - عدد النسخ في `_history` بعد `$book`. إذا كانت أكثر من نسخة، فالـreset يُبقي كل شيء، وهذا سلوك آمن.
  - دعم `If-Match` في `PUT`.
- **إرشاد:** عند إعادة التشغيل في يوم آخر استخدم `--reset-appointments`. بدونه ينتقل حجب الإجازة بينما تبقى مواعيد الـseed في تواريخها القديمة.

### نتائج تنفيذ الخطوة 6 (2026-10-13)
- **البيئة:**
  - Node v24.21.0 / npm 11.19.0، نسخة رسمية بمستوى المستخدم في `%LOCALAPPDATA%\Programs`. تفعيلها على النظام كله ما زال معلّقًا وينفذه صاحب المشروع.
  - `npm run check` على Node 24: 316/316.
- **قبل التنفيذ:**
  - المصادقة: المشروع `Mujeb-MVP`، والهوية `ClientApplication / Mujeb Backend`، وليست admin.
  - الـAccessPolicy الفعلية تغطي كل ما يلزم.
  - dry-run بتاريخ 2026-10-13، وفحصه المستقل نجح، والـplan المنفذ مطابق له حرفيًا.
- **`--apply`** بدون reset: **COMPLETE**.
  - **الموارد:** 18 موردًا أُنشئت (Organization 1، وLocation 1، وHealthcareService 3، وPractitioner 4، وSchedule 4، وPatient 5)، وحجب إجازة واحد.
  - **المواعيد:** 4 محجوزة. لا failed ولا uncertain ولا unmarked.
  - **الـCredentials:** مُررت كمتغيرات بيئة للعملية فقط، ولم تُحفظ في `.env`.
- **التحقق بعد التنفيذ (قراءة فقط):**
  - **الموارد اليدوية سليمة:** HealthcareService 1، وPractitioner 2، وSchedule 1، وPatient 1، ولم يتغير أي مورد غير موسوم منذ بداية الـseed.
  - **`$book` يحفظ الـidentifier والـ`meta.tag`:** الـreset يجد مواعيد الـseed.
  - **كل موعد بعد `$book` له نسخة واحدة في `_history`:** شرط الـreset يعمل، وصلاحية `history` مؤكدة.
  - **`$book` ينشئ Slot مشغولًا غير موسوم لكل موعد:** هذا متوقع، والـSlot يُحذف مع `$cancel`.
  - **حجب الإجازة:** `$find` لا يعرض أي وقت للجلدية من 14 إلى 16 أكتوبر.
  - **الأوقات المحجوزة:** لم تعد تُعرض.
  - **سلوكيات أخرى مؤكدة:** `If-None-Exist` لكل الأنواع، و`Practitioner?_id=` بعدة IDs، و`_tag:not`.
- **لم يُختبر بعد (الخطوة 7):**
  - نقل الإجازة بـ`If-Match`.
  - مسار الـreset.
  - تعارض `$book` (`slot_unavailable`).
  - `$reschedule` و`$cancel` عبر الأدوات.
  - تسجيل مريض عبر الـadapter.
- **ملاحظة:** الدليل يعرض أيضًا موارد يدوية قديمة: خدمة "Dental Consultation" وطبيبها. الـseed لم يلمسها، والقرار بشأنها مؤجل للخطوة 7.

### نتائج الخطوة 7 (2026-10-13)
**الاختبارات الحية:** معطلة افتراضيًا. تعمل فقط بـ`npm run test:live` مع `MUJEEB_LIVE_MEDPLUM=1` وبيانات Medplum. وأي حاجز في `tests/support/live-medplum.ts` يرفض تعديل أو إلغاء موعد لا يخص مريضًا سجّله التشغيل نفسه، ثم تُلغى حجوزات التشغيل في النهاية.

| الملف | ماذا يختبر | النتيجة |
|---|---|---|
| `tests/live/medplum-contract.live.test.ts` | عقد `SchedulingSystem` كاملًا على Medplum، واعتماد مرفوض | 32 ✓، و1 متخطى بالتصميم (idempotency) |
| `tests/live/medplum-tools.live.test.ts` | 4 سيناريوهات تفصيلها بعد الجدول | 4 ✓ |
| `tests/live/agent-tools.live.test.ts` | OpenAI الحقيقي (`gpt-5.4-mini`) مع الأدوات على Medplum | 4 ✓ |

سيناريوهات `medplum-tools`:
- التحقق، والمراجع، والملكية.
- تسجيل ثم حجز ثم تعديل ثم رفض ثم إلغاء، مع تكرار التأكيد وتكرار التسجيل.
- تعارض بين الاقتراح والتأكيد.
- رد ضائع بعد تطبيق الكتابة، ورد ضائع قبل الإرسال، مع الحسم بالقراءة وبدون retry.

**تعديل الـcontract:** اختبارات الكتابة صارت تسجّل مريضها وتحجز موعدها بنفسها، فلا تُلمس سيناريوهات الـdataset. وأُضيف `persistent` للتنظيف. الـmemory adapter يمر بنفس المسار.

**ما ثبت حيًا:**
- `$find` و`ignore-appointment`.
- `$book` ورفضه للوقت المأخوذ (`slot_unavailable`)، والحجزان المتزامنان (ينجح واحد فقط).
- `$reschedule` إلى وقت مأخوذ، وتحرير الوقت بعد التعديل والإلغاء.
- التسجيل المكرر (`already_exists`).
- `not_found` وauth.
- OpenAI مع `store:false`:
  - جولات أدوات متعددة في الدور الواحد (حتى 4).
  - إعادة `message` بـ`phase: commentary`، وإعادة `reasoning` مع `encrypted_content` (effort=low).
  - `phase: final_answer` على السجل.
  - strict schemas.

**أخطاء أُصلحت (مع regression tests):**
1. **Medplum adapter `cancel()`:** إلغاء موعد ملغى يعطي من Medplum "Loading slots failed" (لأن الـSlots حُذفت) بدل خطأ الحالة. الحل: فحص الحالة قبل الكتابة كما في `reschedule()`، فيرجع `invalid_state`.
2. **Medplum adapter `findAvailability()`:** `$find` يرجع فقط الأوقات التي تنتهي داخل النافذة، والـport يطلب ما **يبدأ** في [from, to). الحل: الطلب حتى `to` + مدة الخدمة، ثم قص البدايات. أُضيف contract test لهذا.
3. **Agent tools:** النموذج أعاد طلب الهوية من مريض متحقق منه في نفس المكالمة، فتعطّل التعديل. الحل:
   - `contextNote()` يذكر مراجع المرضى المتحقق منهم، من حالة الخادم نفسها.
   - توضيح في `tools.md`.

**ملاحظات مفتوحة (قبل الخطوة 8):**
- ⚠️ **تاريخ خاطئ في الـread_back:** النموذج قال "خمسطعش أكتوبر" لموعد يوم 13 (رصد مرتين). الخادم ينفذ الـpayload المخزن، لكن المتصل وافق على تاريخ مسموع خاطئ. المقترح: صيغة منطوقة حتمية للتاريخ والوقت تُبنى في الأدوات ويقرؤها النموذج حرفيًا. يحتاج قرارًا بخصوص صيغ اللهجة، مثل حدود "العصر" و"المغرب".
- **جودة النطق:** "ثلاث عشرة" بدل "ثلطعش"، ونسيان الشدّة أحيانًا.
- **ادعاء قبل الأداة:** قال مرة "عندك مواعيد" قبل استدعاء `list_patient_appointments`.
- **الزمن:**
  - كل جولة LLM تأخذ حوالي 0.8–2.3 ثانية حتى أول event، والأدوات 0.2–1.2 ثانية.
  - دور الحجز الأول (4 جولات) يأخذ حوالي 6–8 ثوانٍ.
  - عبارة "لحظة أشيك لك" تأتي عادة خلال ~1 ثانية، لكنها لا تُنطق دائمًا، وأحيانًا أول نص يتأخر 2.5–6 ثوانٍ.
  - التحسين المؤجل (`search_available_slots` يقبل نص الخدمة) يوفر جولة واحدة، حوالي 1–1.6 ثانية.
- **بيانات الاختبار:** كل تشغيل كامل للاختبارات الحية يسجّل حوالي 13 مريض اختبار، ولا يمكن حذفهم بالصلاحيات الحالية. المواعيد تُلغى.
- **الموارد اليدوية:** ("Dental Consultation") بقيت، ولم تسبب أي فشل.

### نتائج الخطوة 8 (2026-10-13)
**1. الـread-back الحتمي.** إصلاح ملاحظة الخطوة 7: النموذج قال الخامس عشر لموعد يوم 13.
- **الصياغة:** `src/agent/tools/spoken-arabic.ts` يصوغ التاريخ والوقت بالسعودي من السجل نفسه، بتوقيت `Asia/Riyadh`. مثال: "يوم الثلاثاء ثلطعش أكتوبر، الساعة أربع مساءً".
  - الفترات صباحًا وظهرًا ومساءً فقط، و"منتصف الليل" للساعة 00:00.
  - التشكيل اختير بتجارب TTS→STT: "ثُلث" لأن "ثلث" بدونها سُمعت "ثلاث"، و"إلّا".
- **من يقرأ:** `AppointmentTools` تبني جملة التأكيد وجملة النتيجة (`speech`). `AgentTurn` ينطقها كما هي وينهي الدور، فلا توجد جولة للنموذج بعدها.
- **التنفيذ مشروط بالسماع:** الإجراء المعلق لا يُنفذ إلا إذا سمع المتصل الجملة كاملة، بلا تاريخ أو وقت آخر في نفس الدور. المصدر هو النص المتطابق مع TTS حتى آخر mark أكده المتصفح، ويمرره `VoiceSession` إلى `onTurnFinalized`. وإلا يرجع `read_back_required` ويعيد النظام القراءة.
- **الإعلان عن النتيجة:** "تم الحجز/التعديل/الإلغاء" تُقال من سجل Medplum نفسه.
- **الملفات الأخرى:**
  - `tools.md` و`instructions.md`: حقل `spoken`، ولا العصر ولا المغرب.
  - A16 في DECISIONS.
  - الـport: `practitionerGender` اختياري، للقب الدّكتور أو الدّكتورة.

**2. إصلاحات من القياس الحي:**
- **OpenAI adapter:** رسالة `final_answer` تكرر رسالة `commentary` حرفيًا في نفس الاستجابة (رُصدت بـprobe). صارت تُحجز وتُحذف إذا كانت مكررة.
- **عبارة انتظار حتمية (`waitPhrase` في الـprofile):** تُقال قبل أول أداة إذا لم يتكلم النموذج. أول صوت صار حوالي 1.4 ثانية بدل 4.5 ثانية.
- **`tools.md`:**
  - تعديل أو إلغاء بدون تحديد موعد: يُستدعى `list_patient_appointments`، ويكمّل مباشرة إذا كان عند المريض موعد واحد.
  - النموذج لا يقول عبارة الانتظار بنفسه.

**3. التحقق الآلي:**
- **`npm run check` على Node 24:** 374/374.
- **الاختبارات الحية (معطلة افتراضيًا):**
  - `spoken-dates.live` (ElevenLabs TTS→STT): 13 سُمعت 13، و15 سُمعت 15، و"إلّا ثُلث" سُمعت صحيحة.
  - `agent-tools.live` (OpenAI مع Medplum): 4/4، وجملة التأكيد والنتيجة تطابقان موعد Medplum.
  - `medplum-tools.live`: 4/4.
- **`voice-e2e.live`:** الخادم كما يركّبه `npm run dev`، مع عميل WebSocket يحاكي الصفحة بصوت متصل مولَّد في الزمن الحقيقي. ✅ نجح:
  - سؤال عن التخصصات.
  - حجز (STT التقط رقم الهوية خانة خانة) ثم "إيه".
  - تعديل ثم "إيه".
  - مقاطعة أثناء قراءة جملة الإلغاء: "إيه ألغيه" لم تُنفذ، وأُعيدت القراءة، ثم "إيه" ألغى.
- **صفحة المتصفح:** HTTP 200، و0 أخطاء console، و0 طلبات فاشلة.
- **بيانات الـseed:** المواعيد الأربعة سليمة (نسخة واحدة لكل منها)، والموارد اليدوية لم تتغير.

**4. الزمن (12 دورًا صوتيًا حيًا):**

| المقياس | الوسيط | الأقصى |
|---|---|---|
| e2e (نهاية كلام المتصل حتى بداية الرد) | 2.69 ث | 2.85 ث |
| أول صوت بعد الـcommit | 1.44 ث | — |
| `stt_finalize` | ~1.24 ث | — |
| أول رد من LLM | ~1.16 ث | — |
| الأدوات | ~0.72 ث | — |
| TTS حتى أول صوت | ~0.19 ث | — |
| الدور كاملًا (حتى 3 جولات) | — | ~5 ث |

**عنق الزجاجة:**
- `stt_finalize`: صمت VAD مدته 0.8 ثانية، ويمكن ضبطه.
- جولات الـLLM المتتالية.

**5. ملاحظات مفتوحة:**
- **الاختبار اليدوي:** بالمايك والسماعة الحقيقيين، وصدى سماعة اللابتوب (`docs/MANUAL_SCHEDULING_TESTS.md`).
- **دقة اتباع التعليمات (`gpt-5.4-mini`، reasoning none):** أحيانًا يسأل "أي موعد؟" مع وجود موعد واحد. وأحيانًا تتكرر عبارة الانتظار، وعولج ذلك في `tools.md`.
- **مرضى الاختبار:** تراكم حوالي 78 مريض اختبار من التشغيلات الحية.
- **انتهاء الـseed:** الـseed يبدأ الانتهاء يوم 14 أكتوبر، فأعده مع `--reset-appointments`.

### إصلاح مطابقة رقم الجوال (2026-10-13، بعد الاختبار اليدوي)
**العَرَض في الاختبار اليدوي:** `find_patient → not_verified` تكرر حتى `locked`، ومرة `invalid_arguments`.

**الأسباب:**
- **تحويل صامت خاطئ:** "+966 05…" و"00966 05…" صارت `+9660500000103`، وقُبلت كرقم دولي.
- **رفض:** علامات الاتجاه المخفية (LRM/RLM)، والأرقام المنطوقة كلمات.
- **حد الـschema:** `phone` محدود بـ32 حرفًا، فرُفض الرقم المنطوق قبل التطبيع.
- **في Medplum:** البحث `phone` مطابقة نصية حرفية، والمقارنة كانت حرفية على أول جوال فقط.

**الإصلاح:**
- **`src/core/phone.ts` (مستقل عن أي HIS):** فيه `parsePhone` و`canonicalPhone` و`samePhone` و`phoneSearchForms`.
  - يقبل: كل البادئات السعودية، والفواصل، والأرقام العربية والفارسية، وعلامات الاتجاه، والأرقام المنطوقة.
  - يرفض بدل أن يخمّن: الأطوال الخاطئة، والأرضي، والكلمات الأخرى.
  - الرقم الدولي غير السعودي يُقبل فقط ببادئة `+` أو `00`.
- **الأدوات:** تطبّع قبل البحث.
- **الـport:** يوثّق القاعدة.
- **Medplum:** بحث واحد محدود بـOR على الصيغ الشائعة، ثم مقارنة `samePhone` على كل جوالات السجل.
- **memory adapter:** يقارن بـ`samePhone`.
- **`phone` في الـschema:** 160 حرفًا.

**التحقق:**
- **`tests/live/medplum-phone.live.test.ts`:** أرقام مخزنة بصيغة محلية ومجمّعة. بحث Medplum الحرفي وجد 0، ومُجيب وجد الاثنين. التحقق بتاريخ الميلاد نجح لثلاث صيغ منطوقة.
- **`npm run check`:** 425/425.

### إصلاح فهم ردّ التأكيد (2026-10-13، بعد الاختبار اليدوي)
**العَرَض:** "ثبّت الحجز" و"إيه ثبّت" رجعت `confirmation_unclear` ثلاث مرات في `logs/turns-2026-10-13.jsonl`، فسمع المتصل "ما فهمت ردّك".

**السبب:** المصنّف يقبل فقط قائمة كلمات ضيقة، وفعل "ثبّت" ما كان فيها، مع إن سؤال النظام نفسه "أثبّت الحجز؟". وأي كلمة خارج القائمة كانت تكفي لرفض الرد.

**الإصلاح (DECISIONS A16 محدّث):**
- **قراءة الـLLM:** `confirm_pending_action` صار فيه حقل إلزامي `caller_answer` (yes/no/unclear). هو حكم الـLLM على الرد، وليس نصًا.
- **قائمة أوسع:** صيغ "ثبّت/أكّد/اعتمد/كمّل/سوّه/مشّه" بلواحقها (ـه، ـها، ـلي …)، و"توكل على الله"، و"على بركة الله"، و"يناسبني". و"خلاص/طيب/يلا" تقبل فقط إذا ما كان معها نفي.
- **الكلمات تحتفظ بحق النقض:** الشرط أو السؤال، والوقت أو اليوم أو اسم الدكتور، وفعل عملية ثانية، والنفي، كلها لا تُقبل كتأكيد أبدًا. الكلمات غير المعروفة بدون أي علامة من هذي يُؤخذ فيها بقراءة الـLLM.
- **تعليمات الأدوات:** إذا طلب المتصل تغيير، لا يُستدعى التأكيد. يُبحث عن الجديد ويُقترح مباشرة.

**التحقق:**
- **`npm run check`:** 452/452.
- **live مع OpenAI وMedplum:** الحجز بـ"ثبّت الحجز"، والتغيير بـ"إيه ثبّت"، والإلغاء بـ"توكل على الله". كل عملية نفذت من أول رد.

### نتائج الخطوة 9 (2026-10-18)
**الهدف:** إثبات القسم 8، أي أن Medplum يمكن استبداله دون لمس الـagent أو منطق الأعمال.

| # | الفحص (القسم 8) | النتيجة | الدليل |
|---|---|---|---|
| 1 | لا `medplum` ولا `fhir` خارج الـadapter، ولا UUIDs في الكود | ✅ | `tests/architecture/boundaries.test.ts` ضمن `npm run check` |
| 2 | Contract واحد ونتيجتان | ✅ الذاكرة (كل `npm run check`) وMedplum (2026-10-18: ‏32 ✓، و1 متخطى بالتصميم) | `tests/contract/memory-scheduling.test.ts` و`tests/live/medplum-contract.live.test.ts` |
| 3 | نفس السيناريوهات مع `memory` ومع `medplum`، والفرق في الإعدادات فقط | ✅ ‏3/3 على كل نظام، في نفس التشغيل وبنفس البيئة | السيناريوهات الجديدة (تفصيلها بعد الجدول) |
| 4 | لا IDs تصل للنموذج | ✅ على الاثنين | نفس السيناريوهات |
| 5 | حذف `src/adapters/medplum/` لا يكسر الطبقات الداخلية | ✅، مع تصحيح لنص القسم 8 (بعد الجدول) | تجربة في نسخة مؤقتة (worktree) |

**السيناريوهات المشتركة (الفحصان 3 و4):**
- **الملفات:**
  - `tests/contract/agent-scheduling.scenarios.ts`: الـsuite المشترك.
  - `tests/contract/agent-scheduling-memory.test.ts`: على الذاكرة، ضمن `npm test`.
  - `tests/live/agent-scheduling-swap.live.test.ts`: الذاكرة وMedplum في نفس التشغيل وبنفس البيئة، والفرق فقط `MUJEEB_SCHEDULING_PROVIDER`.
- **التركيب:** نظام المواعيد يبنيه `createScheduling()` من الإعدادات (نفس مسار `npm run dev`). الأدوات تُبنى بنفس خيارات `dev-server.ts`. ويعمل `AgentTurn` و`Conversation` الحقيقيان مع نموذج scripted، فلا يوجد أي استدعاء لـOpenAI. ويتأكد الاختبار أن `system.name` يطابق الـprovider المضبوط.
- **السيناريوهات الثلاثة:**
  - تحقق بتاريخ ميلاد خاطئ ثم صحيح، ثم المواعيد، ثم الجوال العائلي، ثم البحث في الدليل.
  - تسجيل، ثم حجز، ثم تعديل، ثم "لا" للإلغاء، ثم إلغاء. كل كتابة بعد "إيه" في الدور التالي، ويتأكد الاختبار من النظام نفسه بعد كل خطوة.
  - وقت يأخذه شخص آخر بين الاقتراح والتأكيد، والنتيجة `slot_unavailable`.
- **فحص عدم وصول الـIDs (4):** غلاف يسجّل كل `id` و`serviceId` و`practitionerId` و`patientId` و`token` يرجعها النظام للأدوات. بعدها يُبحث عنها حرفيًا في كل طلب للنموذج (التعليمات والسجل ومخرجات الأدوات) وفي كل ما قيل للمتصل، إضافة لأنماط UUID و`Patient/…` و`mem-…`.
  - الفحص يغطي الـslot tokens أيضًا، وهي base64 ولا يكشفها أي نمط ثابت.
  - **تأكدت أن الفحص يكشف التسريب فعلًا:** وضعت token مؤقتًا في ما يراه النموذج، ففشل الاختبار. ثم أزلته.
- **مراجعة الكود:** أخطاء النظام لا تصل نصوصها للنموذج. `failure()` و`writeFailure()` في `AppointmentTools` يحوّلانها إلى `status` و`hint` ثابتين.

**الفحص 5 (حذف المجلد في نسخة مؤقتة ثم typecheck):**
- **لم يتأثر:** `core` و`ports` و`agent` و`voice` و`contracts` و`config` و`observability`، كلها بدون أي خطأ.
- **ما انكسر في `src/app`:**
  - `container.ts`: سطرا import (متوقع).
  - `medplum-seed-command.ts`: 3 imports. أمر الـseed خاص بـMedplum أصلًا، والـboundaries test يسمح به.
  - `cli.ts`: خطآن `implicit any` في تنسيق مخرجات أمر الـseed فقط، وسببهما غياب أنواع `medplum-seed-command`.
- **ما انكسر في `tests`:** اختبارات Medplum نفسها، و`tests/support/live-medplum.ts` و`fake-medplum.ts`، واختباران حيّان يستخدمانها (`agent-tools.live` و`voice-e2e.live`).
- **تصحيح القسم 8، البند 5:** النص قال "يكسر `container.ts` و`cli.ts` فقط". الواقع أنه يكسر أيضًا `medplum-seed-command.ts`، وهو أداة Medplum بطبيعتها. فإزالة Medplum تعني حذف فرع الـprovider في الـcontainer، وأمر `seed-medplum` وسكربته في `package.json`. لا شيء آخر.

**التحقق:** `npm run check` على Node 24: ‏455/455 (452 + 3 جديدة).

**تعديل صغير في دعم الاختبارات:** `guard` في `tests/support/live-medplum.ts` صار `guardWrites` ومُصدَّرًا، ليحمي الكتابات على النظام الذي يبنيه الـcontainer في الاختبار الحي.

**التشغيل الحي على Medplum (2026-10-18):**
- **الـseed:** أُعيد بواسطة صاحب المشروع (anchor 2026-10-18، COMPLETE: ‏4 مواعيد محجوزة، والإجازة نُقلت).
  - صلاحيات الجلسة الآلية رفضت تنفيذه، لأنه يلغي مواعيد على نظام خارجي.
  - يُكتب `npm.cmd run seed:medplum -- --apply --reset-appointments` وليس `npm`. في PowerShell، الـnpm العادي (Node 22) يحذف `--`، فصار أول تشغيل dry run بصمت (ظهر ملف plan فقط بدون report).
- **الأمر:**
  ```
  MUJEEB_LIVE_MEDPLUM=1 npx vitest run --config vitest.live.config.ts tests/live/agent-scheduling-swap.live.test.ts tests/live/medplum-contract.live.test.ts
  ```
- **النتيجة:** 38 ✓، و1 متخطى بالتصميم (idempotency). بدون OpenAI. وكل تشغيل للسيناريوهات يسجّل 3 مرضى اختبار جدد، ولا يمكن حذفهم بالصلاحيات الحالية.
- **فشل أول تشغيل متوازٍ، وأُصلح (تعارض بين الاختبارات، وليس خللًا في Medplum أو مُجيب):**
  - **السبب:** إجازة الدّكتورة سارة تغطي الأيام 1–3 بعد الـseed، فأول وقت جلدية متاح هو اليوم 4، سواء بدأ البحث من اليوم 1 أو 3. واختبار التعارض في الـcontract يحجز هذا الوقت نفسه، فأخذه أثناء التشغيل المتوازي قبل حجز "المنافس" في السيناريو.
  - **الدليل:** نجحت السيناريوهات 6/6 لما شُغّلت وحدها.
  - **الإصلاح:** سيناريوهات الكتابة تبحث من اليوم +12 و+16، بعيدًا عن الأسبوع الأول الذي تحجز فيه الـsuites الأخرى. وبعدها نجح التشغيل المتوازي.

### الاختبار اليدوي بالمايك (2026-10-18)
**المكالمة 1 (بدون نص الكلام في السجل):** 25 دورًا، ولا كتابة.
- الحماية صمدت: رُفضت هوية غير صالحة، ومرجع مريض اخترعه النموذج (`unknown_ref`)، وانقفل التحقق بعد 3 محاولات.
- اقتراح التسجيل لم يُؤكَّد: ردّ المتصل على "أفتح الملف؟" (35 حرفًا) لم يؤدِّ إلى `confirm_pending_action`. السبب غير معروف بدون نص الكلام.

**المكالمة 2 (مع `MUJEEB_LOG_TRANSCRIPTS=true`)، مريض موجود يحجز:** ✅ نجح الحجز في Medplum من أول "إيه" (STT سمعها "إي، ثبت الحبس"). جملة التأكيد ونتيجة الحجز طابقتا السجل. لكن المكالمة احتاجت 13 دورًا، والأسباب:
1. **STT وتكرار الأصفار:** الهوية `1000000100` سُمعت 9 خانات، ثم 11 مرتين، ثم صحيحة. آلية إعادة الخانات المسموعة (`heard`) نجحت في التصحيح، لكنها كلّفت 4 أدوار. هويات الـseed فيها 6 أصفار متتالية، وهذا أصعب من الهويات الحقيقية غالبًا.
2. **النموذج طلب من المتصل صيغة التاريخ:** قال "أرسلها لي بصيغة سنة شهر يوم" لما سمع "14 مارس 1990"، بدل أن يحوّلها بنفسه.
   - **الإصلاح (`tools.md`):** يحوّل النموذج التاريخ المنطوق إلى YYYY-MM-DD بنفسه، ولا يطلب صيغة، ولا يقول "أرسل" أو "اكتب".
3. **نسي النموذج الطلب الأصلي:** سأل بعد التحقق "وش تبي تسوي على الموعد؟" مع أن المتصل طلب حجز طب أسرة في البداية.
   - **الإصلاح (`tools.md`):** بعد التحقق يكمل الطلب الأصلي مباشرة.
4. **المقاطعة:** الأرقام المنطوقة كلمة واحدة في الـtranscript، فتبقى المقاطعة `candidate` (إيقاف مؤقت) حتى الـcommit. وزمن إيقاف الصوت يحدده تأخر أول partial من STT (~1–1.8 ث). تحسينه بالـVAD المحلي فيه مقايضة مع الصدى، فهو بند مستقل.

**إصلاحات صياغة:** بندان مدموجان في سطر واحد (`declined` في `tools.md`، و"التواريخ" في `instructions.md`).

**ملاحظة:** حجز المكالمة 2 كان لمريض من الـseed (عبدالله)، وهذا مخالف لقاعدة `docs/MANUAL_SCHEDULING_TESTS.md` بسبب خطأ في تعليمات الاختبار. الموعد اليوم الساعة 16:00، فيصير في الماضي ولا يؤثر على السيناريوهات بعدها.

**المكالمة 3 (مع نص الكلام)، مريض جديد يفتح ملف ثم يحجز:** ✅ انفتح الملف وانحجز موعد جلدية في Medplum. احتاجت المكالمة 14 دورًا. ما ظهر فيها:
1. **⚠️ النموذج اخترع تاريخ ميلاد:** المتصل لم يذكره، فاستدعى `propose_registration` بـ`1900-01-01`. جملة التأكيد كشفته فرفض المتصل. السبب أن الـschema الصارم يُلزم كل الحقول، فيملأ النموذج الناقص بتخمين.
   - **الإصلاح (كود):** `find_patient.birth_date` وكل حقول `propose_registration` صارت nullable. الناقص يرجع `missing_information` مع قائمة `missing`، ولا يستهلك محاولات التحقق.
   - الجنس غير المذكور يُسجَّل `unknown`، ولا يُستنتج من الاسم.
2. **تصحيح أثناء القراءة:** قال المتصل "لا، تاريخ الميلاد…"، فسأل النموذج تأكيدًا بنفسه بدل اقتراح جديد. ثم رجع `expired`، فشرح النموذج للمتصل "انتهت صلاحية الطلب" وسأل من جديد. كلّف هذا 5 أدوار.
   - **الإصلاح (`tools.md`):** أي تصحيح يعني `propose_*` جديدًا مباشرة. وبعد `expired` يعيد الاقتراح بدون ذكر الصلاحية.
3. **نتيجة التسجيل قالها النموذج** ("تم يا حمزة")، لأن التسجيل وحده بين عمليات الكتابة لم يكن له نطق من النظام.
   - **الإصلاح (كود):** "تم فتح الملف باسم … تبي أخدمك بشي ثاني؟" يُبنى من السجل المحفوظ، مثل الحجز.
4. **عبارة الانتظار تكررت** ("لحظة أشيك لك. لحظة أشيك لك."): قالها النظام، ثم بدأ بها النموذج الجولة التالية لأنه يراها في السجل.
   - **الإصلاح (كود، `AgentTurn`):** إذا سُمعت العبارة في الدور، تُحذف من بداية الجولات اللاحقة.
5. **مورد يدوي قديم في Medplum:** خدمة "Dental Consultation" (لاحظناها في الخطوة 6) ظهرت للمتصل كـ"استشارة الأسنان". البحث عن "طب الأسنان" لم يجدها، ثم ظهرت في قائمة الخدمات. هذا تنظيف للـsandbox، وليس خللًا في الكود.

**التحقق:** `npm run check`: ‏458/458. الاختباران الجديدان في `appointment-tools.test.ts` واختبار عبارة الانتظار في `agent-turn-and-config.test.ts` تفشل كلها على الكود القديم.

**المكالمة 4 (بعد الإصلاحات)، تسجيل:** ✅ انفتح الملف.
- **ما تأكد من الإصلاحات:**
  - طلب المعلومات الناقصة مرتين (`missing_information`) بدل التخمين.
  - عبارة الانتظار لم تتكرر.
  - النظام نفسه أعلن "تم فتح الملف باسم خالد".
  - سُجّل المريض بجنس `unknown` على Medplum بنجاح.
- **لم يُختبر:** التصحيح أثناء قراءة التأكيد، لأن المتصل وافق مباشرة.
- **ما ظهر:**
  1. **⚠️ تاريخ الميلاد:** نص الـSTT "واحد، واحد، ألف وتسعمية وسبعة وتسعين"، والنموذج حوّله إلى 1 نوفمبر 1997. المقصود 1 يناير (أكده صاحب المشروع)، لكنه لم ينتبه للقراءة ووافق. فالسجل فيه تاريخ خاطئ، وهذا يبيّن أن شبكة الأمان تعتمد على انتباه المتصل.
     - **الإصلاح (`tools.md`):** قاعدة صريحة: الأول اليوم، والثاني الشهر، والثالث السنة، ولا دمج لرقمين. مع أمثلة، منها هذه الحالة نفسها.
     - **إذا تكرر:** تُقسم `birth_date` في الأدوات إلى يوم وشهر وسنة، والخادم يركّب التاريخ. هذا مؤجل لأنه يغيّر ~70 استدعاء في الاختبارات.
  2. **سنة 1433 (هجرية):** **قرار صاحب المشروع: الميلادي فقط حاليًا.**
     - النموذج يطلب "تاريخ ميلادك بالميلادي".
     - **كود:** السنة 1300–1500 ترجع `hijri_birth_date` ليطلب النموذج الميلادي، بدل الرفض العام. ولا تستهلك محاولات التحقق.
     - دعم الهجري بند منتج مستقبلي.
  3. **تأخر الـcommit من STT:** بعد "افتح الملف" وصل الـcommit بعد 4.2 ثانية من نهاية الكلام (المعتاد ~1.2 ث). كرر المتصل العبارة مرتين، وكل تكرار ألغى الدور ودمجه (`user_continued`، وهذا سلوك صحيح)، فتأخر التنفيذ. يدخل ضمن بند زمن الـSTT.

**التحقق بعد إصلاحات المكالمة 4 (2026-10-19):** `npm run check` على Node 24: ‏459/459.

---

## 7. الاختبار والتحقق

- **Unit:**
  - التطبيع.
  - `zoned-time`.
  - المطابقة العربية.
  - `confirmation-classifier`: جدول عبارات سعودية مثل "إيه" و"إيه بس خله الساعة خمس" (unclear) و"لا خلاص" و"أكيد احجز".
  - `pending-actions`:
    - رفض التأكيد في نفس الدور.
    - انتهاء الصلاحية.
    - الاستخدام الواحد.
    - الاقتراح الجديد يلغي السابق.
    - مريض مختلف.
    - موعد تغيّر `version`.
    - ref مخترع.
    - `unclear` يعيد التسليح مرتين ثم ينتهي الإجراء.
    - اقتراح جديد بعد تعديل المتصل.
  - `write-ledger`:
    - timeout يعطي `unknown`، والحسم بالقراءة يحوله إلى `succeeded` أو `failed`.
    - حجب كتابة ثانية لنفس المريض أثناء `in_flight` أو `unknown`.
    - إغلاق الجلسة ينتظر الكتابة الجارية.
  - حد محاولات التحقق.
  - قص السجل بحدود الأدوار.
- **Contract:** suite واحد. يعمل دائمًا على الـmemory adapter، ويعمل على Medplum في `test:live` فقط. والبيانات تُحل من الـdataset بالبحث، وليس بـIDs. ومن حالاته:
  - slot يُحجز من طرف آخر بين `$find` و`book()`، والنتيجة `slot_unavailable` وقت التنفيذ.
  - حجزان متزامنان لنفس الوقت ينجح واحد فقط.
- **Integration (بدون شبكة):**
  - OpenAI: الطلب الثاني يحمل العناصر **حرفيًا وبالترتيب** (reasoning مع `encrypted_content`، ثم message مع `phase`، ثم function_call، ثم function_call_output). والجولة الملغاة لا تُرسل. وتغيّر النموذج يحذف الـreasoning.
  - Medplum adapter مقابل fixtures.
  - Agent turn:
    - مسار كامل: بحث، ثم اقتراح، ثم دور تالٍ فيه "إيه"، ثم تنفيذ.
    - رفض "لا".
    - "إيه بس..." تعطي unclear.
  - VoiceSession:
    - بدون `tools` السلوك مطابق للحالي.
    - عبارة الانتظار تُنطق.
    - المقاطعة أثناء القراءة تلغيها.
    - المقاطعة أثناء الكتابة لا تلغيها، والنتيجة تُسجَّل.
    - المقاطعة أثناء كتابة تنتهي بـtimeout تؤدي إلى `unknown` ثم الحسم، ويُبلغ النموذج في الدور التالي.
    - إلغاء الدور المقترِح قبل الصوت يلغي الإجراء المعلق.
- **Live (معطل افتراضيًا):** الـcontract على Medplum، وسيناريوهات نصية بلهجة سعودية مع OpenAI الحقيقي.
- **يدوي:** حجز، وتعديل، وإلغاء، وتسجيل، ولا متاح، وطبيبان في نفس التخصص، وجوال عائلي، وتاريخ ميلاد خاطئ، و"إيه بس..."، ومقاطعة أثناء قراءة الـread_back، وانقطاع Medplum.
- **المراقبة:** `tool.call` و`tool.audit` و`scheduling.request` مع `session_id` و`turn_id` و`tenant_id`. **لا هوية ولا جوال ولا أسماء في الـlogs.**

---

## 8. الاستقلال عن Medplum وعدم كسر الموجود

**الاستقلال:**
1. **Boundaries test:**
   - لا `medplum` ولا `fhir` في `core` و`ports` و`agent` و`voice` و`contracts` و`config/agents`.
   - فقط `container.ts` و`cli.ts` يستوردان `adapters/medplum`.
   - لا IDs بصيغة UUID في الكود أو الـprofile.
2. **Contract واحد ونتيجتان:** `memory` و`medplum`.
3. **تبديل بالإعدادات فقط:** نفس السيناريوهات تنجح مع `MUJEEB_SCHEDULING_PROVIDER=memory` ومع `=medplum`.
4. **لا IDs للنموذج:** اختبار يتأكد أن مخرجات الأدوات وطلبات الـLLM فيها مراجع قصيرة فقط.
5. **حذف `src/adapters/medplum/`** يكسر `container.ts` و`cli.ts` فقط.

**عدم الكسر:**
- الاختبارات الحالية (79، في 9 ملفات) تبقى بدون تعديل، وتنجح في كل خطوة.
- جداول الطبقات والحزم في `boundaries.test.ts` لا تتغير، والإضافات قيود جديدة فقط.
- `VoiceSession` بدون `tools` يتبع المسار الحالي حرفيًا.
- لا dependency جديدة.

---

## 9. مخاطر ونقاط مفتوحة

- **Medplum Scheduling في مرحلة Beta:** الأثر محصور في الـadapter، والـfixtures تكشف أي تغيير.
- **HTTP status للتعارض وحفظ `$book` للـidentifier غير موثقين:** نثبتهما في الخطوة 7، ونعتمد الـreconcile بالقراءة كحل بديل.
- **الزمن:** دورة الحجز الكاملة فيها عدة جولات أدوات، وكل جولة تضيف TTFT للنموذج (حوالي 1 ثانية) إضافة إلى زمن الـHIS. المعالجات:
  - cache للدليل في الـadapter.
  - عبارة انتظار.
  - مخرجات مختصرة.
  - التأكيد مدمج طبيعيًا في دور المتصل التالي.
  
  نقيس بـ`tools_ms` و`e2e_ms`. **تحسين مؤجل حسب القياس:** أن يقبل `search_available_slots` نص الخدمة مباشرة، فيوفر جولة.
- **حدود المصنِّف الحتمي:** قد يصنف بعض العبارات `unclear` فيعيد السؤال. هذا خطأ آمن (لا تنفيذ)، والقائمة تتوسع من نتائج الاختبار اليدوي.
- **نماذج `all_turns` (GPT-5.6):** تتطلب قرارًا موثقًا قبل اعتمادها (القسم 3.5، البند 6).
- **التحقق من الهوية dev-only:** D2 ما زال مفتوحًا، ولا يُستخدم هذا التصميم مع بيانات حقيقية.
- **البيانات المرسلة للمزودين:** بيانات اصطناعية فقط، وD4 (إقامة البيانات) مفتوح.

## المصادر
- Medplum:
  - https://www.medplum.com/docs/scheduling
  - https://www.medplum.com/docs/scheduling/appointment-find
  - https://www.medplum.com/docs/scheduling/appointment-book
  - https://www.medplum.com/docs/scheduling/appointment-reschedule
  - https://www.medplum.com/docs/scheduling/appointment-cancel
  - https://www.medplum.com/docs/scheduling/defining-availability
  - https://www.medplum.com/blog/scheduling-beta
- OpenAI:
  - https://developers.openai.com/api/docs/guides/function-calling
  - https://developers.openai.com/api/docs/guides/reasoning
