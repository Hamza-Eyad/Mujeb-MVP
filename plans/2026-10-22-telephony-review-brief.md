# طلب مراجعة: ربط مُجيب بالهاتف عبر Asterisk

> **v1 (2026-10-22).** موجّه لمراجع تقني خارجي (ChatGPT) قبل كتابة أي كود في Phase 4.
> التفاصيل الكاملة في `plans/2026-10-21-exacall-integration-report.md`، وهذا الملف ملخص مستقل يكفي للمراجعة.

## المطلوب من المراجع

راجع التصميم أدناه **بشكل نقدي**. المطلوب:
- الافتراضات الخاطئة.
- المخاطر الناقصة.
- أي جزء ممكن يطلع كود رمي (throwaway) لا يصلح للمنتج النهائي.
- البدائل الأفضل إن وُجدت.

**القيود الثابتة (لا تقترح ما يخالفها):**
- المحرك الصوتي مبني من عندنا، فلا نستخدم Vapi أو Retell أو Twilio أو ElevenLabs Agents أو أي منصة Voice AI مستضافة.
- لغة التشغيل TypeScript على Node.js 24 فقط، وPython ليست في الـruntime.
- لا نفترض وجود WebSocket streaming عند مزود الاتصالات (ExaCall)، لأنه لم يُؤكد.
- لا نبني بنية موزعة أو طوابير قبل الحاجة: النظام modular monolith.

لكل ملاحظة: افصل بين **المؤكد من التوثيق** و**الرأي**، واذكر المصدر إن أمكن.

---

## 1. عن مُجيب

- **المنتج:** مساعد صوتي ذكي يرد على مكالمات العيادات والمستشفيات في السعودية باللهجة السعودية. يحجز المواعيد ويعدّلها ويلغيها.
- **المعمارية:** modular monolith بأسلوب ports/adapters. كل مزود خارجي خلف واجهة يملكها المشروع.
- **المزودون الحاليون:**
    - ElevenLabs للـSTT والـTTS بالتدفق (streaming).
    - OpenAI للـLLM عبر Responses API.
    - نظام المواعيد خلف port اسمه `SchedulingSystem`، وتجريبيًا على Medplum ببيانات وهمية.
- **ما تم:**
    - **Phase 0:** حلقة صوتية كاملة على جهاز التطوير، مع مقاطعة (barge-in) وقياس زمن كل مرحلة.
    - **Phase 1:** أدوات المواعيد، مع تأكيد إلزامي من المتصل قبل أي كتابة.
- **ما لم يتم:** أي ربط بالهاتف. الصوت حاليًا من مايك المتصفح عبر WebSocket محلي.
- **مبدأ:** الـMVP صغير في النطاق، لكنه ليس كود رمي.

## 2. الواجهة الصوتية الحالية (لن تتغير)

الهاتف يدخل من نفس الـport الذي يستخدمه المتصفح الآن:

```ts
export interface TransportCapabilities {
  readonly pause: boolean;               // pause/resume buffered playback without discarding it
  readonly playbackStartEvents: boolean; // reports when the first sample of an epoch starts playing
}

export type TransportEvent =
  | { type: 'audio'; data: Uint8Array }
  | { type: 'mark'; name: string }
  | { type: 'playback_started'; epoch: number }
  | { type: 'playback_cleared'; epoch: number }
  | { type: 'rtt'; ms: number }
  | { type: 'closed'; reason: string };

export interface AudioTransport {
  readonly inputFormat: AudioFormat;   // today: pcm_s16le @ 16 kHz
  readonly outputFormat: AudioFormat;
  readonly capabilities: TransportCapabilities;
  setHandler(handler: (event: TransportEvent) => void): void;
  sendAudio(epoch: number, data: Uint8Array): void;
  sendMark(epoch: number, name: string): void;
  clear(epoch: number): void;          // stop playback now, drop everything buffered for this epoch and older
  pause(): void;
  resume(): void;
  close(reason: string): void;
}
```

**كيف تستخدمها الجلسة (`VoiceSession`):**
- **الإرسال:** كل chunk من الـTTS يُرسل بـ`sendAudio`، يتبعه `sendMark`. وانتهاء الدور ينتظر تأكيد آخر mark، بحد أقصى `مدة الصوت + 4000ms`.
- **المقاطعة:** `clear(epoch)`، ثم انتظار `playback_cleared` حتى 1000ms. وعند الاشتباه بمقاطعة، توقّف مؤقت عبر `pause()` إذا كانت `capabilities.pause` صحيحة.
- **كشف الكلام (VAD):** يعمل فقط إذا كان الإدخال `pcm_s16le`.
- **قاعدة السلامة:** تأكيد الموعد يُقبل فقط إذا سمع المتصل القراءة كاملة، و"سمع" تعني حتى آخر mark أكّده الطرف الآخر.

## 3. مزود الاتصالات: ExaCall

شركة سعودية. عرضها الحالي SIP trunk: أرقام 011 و9200 و800، و5 قنوات في الباقة الأساسية.

**ما أكدوه في الاجتماع التقني (2026-10-21)، شفهيًا وبدون توثيق مكتوب:**
- **الربط:** SIP trunk عادي (SIP للإشارة وRTP للصوت). يرسلون بيانات الربط بالإيميل: domain، ومنفذ، وtransport، وusername/password.
- **المصادقة:** IP-based أو Registration، والاختيار لنا.
- **الأرقام:** الـDID ثابت لكل رقم، ونطابق عليه المكالمات، ورقم المتصل يُرسل مع المكالمة.
- **التحويل:** **SIP REFER غير مدعوم**. المتاح Conference أو Warm Transfer، وفيها ساق صادرة.
- **رقم مشترك لعدة مستشفيات:** غالبًا لا يحدد المستشفى الأصلي. لذلك القرار: رقم مخصص لكل مستشفى.
- **البنية:** خوادمهم داخل السعودية، والكودك G.722، والـSBC عندهم مسؤول عن التشفير.
- **غير مؤكد:** هل الخط بين الـSBC وخادمنا مشفّر (TLS وSRTP). سنتحقق في أول مكالمة.

## 4. البوابة المختارة: Asterisk 22 LTS + `chan_websocket`

**الفكرة:** Asterisk يستقبل الـSIP trunk، ويرسل صوت كل مكالمة إلى مُجيب عبر WebSocket (اتصال لكل مكالمة) على نفس الخادم. مُجيب يضيف adapter واحدًا يطبّق `AudioTransport`.

```text
Patient phone → (hospital number forwarded) → ExaCall SBC
  → SIP/RTP over internet (allowlist ExaCall IPs only)
  → Asterisk 22 (pjsip trunk; dialplan per DID → Dial(WebSocket/...c(slin16)f(json)v(call metadata)))
  → loopback WebSocket, one connection per call
  → Mujeeb telephony server → AsteriskWsTransport (AudioTransport) → VoiceSession (unchanged)
```

**المطابقة:**

| `AudioTransport` | `chan_websocket` |
|---|---|
| `sendAudio` | binary frames، ≤ 65,500 byte للرسالة، ومضاعف لـ`optimal_frame_size` (‏640 byte = 20ms من `slin16`) |
| `sendMark` / حدث `mark` | `MARK_MEDIA` مع `correlation_id` ← `MEDIA_MARK_PROCESSED` |
| `playback_started` | mark قبل أول chunk في كل epoch (اقتراح) |
| `clear` / `playback_cleared` | `FLUSH_MEDIA`، ثم إطلاق `playback_cleared` محليًا |
| `pause` / `resume` | `PAUSE_MEDIA` / `CONTINUE_MEDIA` |
| `close` / `closed` | `HANGUP` / إغلاق الـsocket |
| تدفق | `MEDIA_XOFF`/`MEDIA_XON`. طابور Asterisk حوالي 1000 إطار (~20 ثانية)، والـTTS أسرع من الزمن الحقيقي، فنحتفظ بالصوت محليًا عند XOFF |

**البدائل التي رُفضت:**

| البديل | سبب الرفض |
|---|---|
| Asterisk ARI External Media عبر RTP أو AudioSocket | التطبيق مسؤول عن توقيت الحزم، وكود أكثر |
| FreeSWITCH + `mod_audio_stream` | module خارجي، والصوت ثنائي الاتجاه في بعض نسخه تجاري، وإعداد أثقل |
| SIP وRTP مبنيان في Node | كل حالات SIP علينا: re-INVITE وsession timers وNAT وDTMF وTLS |
| jambonz أو LiveKit | منصات كاملة أكبر من حاجتنا، وLiveKit يفرض بناء المحرك حول rooms |
| منصات مستضافة | تستبدل المحرك أو تُخرج الصوت عن السعودية |

## 5. نتائج المختبر (مؤكدة بالاختبار، 2026-10-22)

**البيئة:**
- Asterisk 22.11.0، مبني من المصدر، وتأكدنا من checksum الملف.
- WSL2 بـUbuntu 24.04، بشبكة mirrored.
- MicroSIP softphone على ويندوز.
- سكربت Node صغير يستقبل `chan_websocket`.

| الاختبار | النتيجة |
|---|---|
| `Playback` + `Echo()` | الصوت يعمل في الاتجاهين، وتأكدنا من حزم RTP في السجل |
| `Dial(WebSocket/lab_echo/c(slin16)f(json)v(caller=..,dialed=..))` | `MEDIA_START` وصل بـ`format: slin16`، و`optimal_frame_size: 640`، و`ptime: 20`. وأول إطار 640 byte |
| ترتيب البايتات | نغمة 440Hz مكتوبة little-endian سُمعت صافية، فالصيغة تطابق `pcm_s16le` |
| بيانات المكالمة | وصلت في رابط الاتصال: `/media?caller=6001&dialed=200` |
| توقيت `MEDIA_MARK_PROCESSED` | بعد 984–993ms من إرسال ثانية صوت كاملة (3 مكالمات). يعني يُطلق عند **تشغيل** الصوت في Asterisk، وليس عند استلامه |
| الإقفال | الـWebSocket ينغلق بـ`code=1000` |

**ملاحظات خاصة بـWSL ولا تنطبق على الإنتاج:**
- تعارض المنفذ 5060 مع MicroSIP، فاستخدمنا 5070 في المختبر.
- الـsoftphone يعلن عنوان LAN يرجع إلى Ubuntu، فاحتجنا `rtp_symmetric` و`force_rport` و`rewrite_contact`.

## 6. الكود المقترح (دائم، يبقى في المنتج النهائي)

| المكون | المسار المقترح | المسؤولية |
|---|---|---|
| `AsteriskWsTransport` | `src/adapters/telephony/asterisk/` | بروتوكول `chan_websocket` ↔ `AudioTransport`، مع schemas بـ`zod` عند الحدود. **معرفة Asterisk محصورة هنا**، واختبار معماري يفرض ذلك |
| خادم المكالمات | `src/app/telephony-server.ts` | خادم WebSocket على loopback لاتصالات Asterisk. يتحقق بسر مشترك، ويطبّق حدًا أقصى للمكالمات، وينشئ جلسة مستقلة لكل مكالمة |
| `SessionFactory` | `src/app/session-factory.ts` | منطق إنشاء الجلسة مستخرج من خادم المتصفح، ومشترك بين المتصفح والهاتف |
| `CallRouter` | `src/app/call-router.ts` | مفتاح التوجيه ← المستشفى والـprofile. المفتاح هو الرقم المتصَل عليه (DID)، أو عنوان SIP لمستشفى سنترالها IP ويحوّل مباشرة بدون رقم. والمفتاح غير المعروف يُرفض ولا يُخمّن |
| `CallContext` | `src/contracts/` | معرّف المكالمة، ورقم المتصل، والـDID، ورقم التحويل الأصلي. نوع محايد للمزود |
| إعدادات Asterisk للإنتاج | `deploy/asterisk/` | قوالب: trunk يُعرّف بالـIP، وG.722 ثم A-law، و**بدون أي مسار صادر**، وبدون أسرار |
| اختبارات | `tests/` | الـadapter مع خادم `chan_websocket` وهمي: marks وflush وpause وhangup وXOFF وتقسيم الرسائل الكبيرة |

**ما لن يتغير:** ‏`VoiceSession`، وأدوات المواعيد، والمزودون، والـport نفسه.

**قواعد:**
- رقم المتصل **لا يُستخدم للتحقق من الهوية**، لأنه قابل للتزوير.
- أرقام الهواتف **تُقنّع في السجلات**.
- لا تسجيل للمكالمات افتراضيًا.

## 7. ما هو للتجربة فقط (خارج المستودع)

- سكربتات بناء Asterisk وإعداد المختبر.
- سكربت الـecho.
- إعدادات WSL الخاصة: المنفذ 5070 وsymmetric RTP.
- MicroSIP.

## 8. ما نتوقع أن يتغير لاحقًا (بدون إعادة كتابة)

- **مصدر بيانات التوجيه:** من ملف إعدادات إلى قاعدة بيانات المستشفيات (Phase 2)، بنفس واجهة `CallRouter`.
- **التحويل لموظف (Phase 5):** عبر ARI، بإنشاء ساق صادرة ثم bridge.
    - ARI يقدر ينشئ قناة WebSocket بنفس البروتوكول (`externalMedia` مع `transport=websocket`)، فالـadapter يبقى كما هو.
    - يتغير فقط **من يبدأ** المكالمة: dialplan الآن، وARI لاحقًا.
- **لو تغيّرت البوابة يومًا:** يُستبدل الـadapter فقط.

## 9. خطة التنفيذ المختصرة

1. ✅ مختبر محلي: Asterisk + softphone + سكربت echo.
2. خطة Phase 4 مكتوبة ومعتمدة.
3. بناء المكونات في القسم 6 مع اختبارات آلية، ثم محادثة كاملة من الـsoftphone مع مُجيب.
4. خادم Oracle في منطقة سعودية بـIP ثابت، ورقم ExaCall تجريبي (011)، ومكالمة من جوال حقيقي.
5. اختبارات: مكالمة محوّلة من رقم آخر، و5 مكالمات متزامنة، وتوقف مُجيب أثناء مكالمة، وقياس زمن الاستجابة ومدة توقف الصوت عند المقاطعة.

## 10. المخاطر المعروفة

| الخطر | كيف نتعامل معه |
|---|---|
| احتيال المكالمات الصادرة: الباقة فيها in/out | allowlist لعناوين ExaCall، وdialplan بدون أي مسار صادر، وطلب إيقاف الصادر من المزود |
| الخط بين الـSBC وخادمنا غير مشفّر | التحقق في أول مكالمة، وقرار قبل أي بيانات حقيقية |
| الصوت من الجوال narrowband رغم G.722 على الـtrunk | قياس دقة التفريغ في الهاتف مقابل المايك |
| رقم المتصل الأصلي في المكالمة المحوّلة يعتمد على مزود المستشفى | اختبار عملي |
| `MEDIA_MARK_PROCESSED` لا يشمل تأخير الشبكة إلى أذن المتصل | قياس، ثم قرار بإضافة مهلة أو لا |
| خادم واحد | رقم بديل عند المزود، وفحص صحة |
| `chan_websocket` حديث، صدر 2025 | تثبيت الإصدار، واختبارات، وAudioSocket/RTP كبديل |
| مزودو STT وLLM وTTS خارج السعودية | قرار منفصل (D4)، والهاتف وحده لا يحل إقامة البيانات |
| تشغيل Asterisk مسؤولية جديدة على مطوّر واحد | runbook، وأقل عدد من الـmodules، وتحديثات أمنية |

## 11. أسئلة محددة للمراجع

1. هل `chan_websocket` اختيار صحيح للإنتاج، مقارنة بـARI External Media عبر RTP أو AudioSocket؟ وما مدى نضجه؟
2. نبدأ بـ`Dial(WebSocket)` من الـdialplan، وننتقل لـARI عند الحاجة للتحويل. أم نبدأ بـARI من الآن لتجنب إعادة العمل؟
3. هل توقيت `MEDIA_MARK_PROCESSED` كافٍ لقاعدة "سمع المتصل القراءة كاملة"؟ أم نحتاج مهلة إضافية؟
4. الأمان: الـWebSocket على loopback مع سر مشترك، وSIP مفتوح لعناوين المزود فقط، وبدون مسار صادر. ما الناقص؟
5. التزامن: Asterisk واحد وعملية Node واحدة لعدد قليل من المكالمات. أين حدود هذا التصميم، ومتى نحتاج فصلهما؟
6. التوجيه بالـDID لكل مستشفى: ما المزالق، مثل تنسيق الأرقام أو المكالمات المحوّلة؟
7. هل في التصميم شيء قد يصير كود رمي في المنتج النهائي؟
8. إقامة البيانات: ما المسار الواقعي لـSTT وTTS وLLM داخل السعودية، مع الإبقاء على التصميم الحالي؟

## 12. نتيجة المراجعة (2026-10-25)

**حكم المراجع (ChatGPT):** موافقة مشروطة. نبدأ التنفيذ، لكن الإنتاج غير معتمد بعد. وبعد مقارنة ملاحظاته بالكود الفعلي، هذا ما نعتمده.

**نقبله ويدخل في خطة Phase 4:**
1. **طابور إرسال واحد مرتب** للصوت والـmarks في الـadapter، يحترم XOFF/XON. لا تُرسل mark قبل كل الصوت الذي يسبقها.
2. **تجميع الصوت لإطارات كاملة** (مضاعفات 640 byte)، والباقي يُحمل للرسالة التالية، والذيل الأخير يُكمّل بصمت قبل آخر mark.
3. **تأكيد المسح من Asterisk نفسه، لا محليًا:** `FLUSH_MEDIA` ثم `GET_STATUS`، والأوامر تُنفّذ بالترتيب، و`playback_cleared` يُطلق عند وصول `STATUS` بـ`queue_length = 0`. يُختبر في المختبر.
4. **دورة حياة صريحة للمكالمة:** ‏`Dial(...n)` بدون رد تلقائي، و`ANSWER` فقط بعد إنشاء الجلسة بنجاح. ورفض المكالمة الزائدة أو الرقم المجهول قبل الرد.
5. **بيانات المكالمة لا تمر في رابط الـWebSocket**، لأن الرقم يظهر في السجلات. نختبر نقلها كـ`channel_variables` في `MEDIA_START`، والتحقق من الاتصال بـusername/password في `websocket_client.conf`.
6. **`CallControl` منفصل عن نقل الصوت.** وتجربة صغيرة (spike) في المختبر: نقل مكالمة حية من `Dial(WebSocket)` إلى `Stasis()` (ARI) قبل إغلاق Phase 4.
7. **إعدادات NAT على Oracle** تُعتمد بعد اختبار SDP وRTP الفعلي، ولا تُعتبر خاصة بـWSL فقط.
8. **بناء Asterisk قابل للتكرار داخل المستودع:** الإصدار، والـmodules، والتحقق من الـchecksum.
9. **اختبارات قبول إضافية:** مكالمة 30 دقيقة، و5 مكالمات تتكلم فعلًا، ومقاطعات متكررة، وXOFF، وقطع الـWebSocket، وإعادة تشغيل Node أثناء مكالمة. مع قياس p95 للزمن، وتأخر الـevent loop، و`queue_length`.
10. **مهلة بعد آخر mark** لتغطية تأخير الشبكة إلى أذن المتصل: تُقاس على مكالمات حقيقية، ثم يُقرر.

**نعدّل حكم المراجع فيه بعد قراءة الكود:**
- **"انتهاء مهلة انتظار الـmark يتحول لنجاح":** لا يحدث في قرار التأكيد. ما سمعه المتصل يُحسب من الـmarks المؤكدة فقط (`playedText` في `src/voice/session.ts`)، وقراءة الموعد لا تُعتبر مسموعة بدونها (`readBackHeard` في `pending-actions.ts`). انتهاء المهلة ينهي الدور فقط.
- **`playback_cleared` كخطر P0:** القرار لا يعتمد عليه. بعد المقاطعة الجلسة تتجاهل أي mark متأخرة (`onMark` يقبل الدور الحالي فقط)، فالمسموع يُحسب بتحفظ. الحدث يُغلق الدور أسرع ويقيس زمن التوقف. ومع ذلك نعتمد البند 3 لدقة القياس.
- **`playback_started` كخطر P0:** يُستخدم للقياس (`e2e_ms`)، ولمعرفة هل سمع المتصل أي شيء لإسقاط اقتراح لم يُسمع. ولا يدخل في قبول التأكيد. نُبقيه من mark قبل أول chunk، ونوثّق معناه: بداية التشغيل في Asterisk. وأولويته P2.

**أسئلة المراجع التي تحتاج قرار مالك المشروع:**
- هل التحويل لموظف (Warm Transfer) مطلوب في أول نسخة تجارية؟
- سياسة البيانات: هل الممنوع التخزين خارج السعودية فقط، أم المعالجة أيضًا؟

**أسئلة تنتظر ExaCall:** التأكيد الكتابي للعناوين والتشفير، وطريقة حساب القنوات.
