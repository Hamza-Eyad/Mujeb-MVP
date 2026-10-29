# مختبر الهاتف المحلي: MicroSIP ← Asterisk ← مُجيب

> **مختبر محلي على جهاز التطوير فقط، وليس ربطًا تجاريًا.** لا يوجد فيه خط ExaCall ولا رقم حقيقي ولا خادم Oracle، والـSIP مربوط على `127.0.0.1` فقط. القرار: `docs/DECISIONS.md` A19. الخطة: `plans/2026-10-25-phase-4-call-connection.md`.

```text
MicroSIP (Windows) --SIP/RTP 127.0.0.1:5070--> Asterisk 22.11.0 (WSL Ubuntu 24.04)
  --Dial(WebSocket/mujeeb/c(slin16)f(json)n)--> ws://127.0.0.1:8790/media --> npm run telephony (Windows)
```

## الملفات

| الملف | الغرض |
|---|---|
| `build-asterisk.sh` | بناء Asterisk ‏22.11.0 من المصدر. الإصدار والـchecksum ثابتان، والبناء يفشل لو الملف مختلف |
| `setup-lab.sh` | كتابة إعدادات `/etc/asterisk` كاملة، وتوليد كلمات السر خارج المستودع، وتثبيت رسالة الاعتذار |
| `load-calls.sh` | يبدأ عدة مكالمات اصطناعية في نفس اللحظة، لاختبارات الحمل (القسم أدناه) |
| `sounds/unavailable.txt` | نص رسالة الاعتذار المعتمد |
| `sounds/unavailable.sln16` | الرسالة بصوت العيادة، PCM ‏16 kHz. تُولَّد مرة واحدة بـ`npm.cmd run lab:render-unavailable` (طلب ElevenLabs واحد)، وليس عند كل مكالمة |

## التجهيز (مرة واحدة)

1. **WSL2 + Ubuntu 24.04** بشبكة mirrored. في `%USERPROFILE%\.wslconfig`:
   ```ini
   [wsl2]
   networkingMode=mirrored
   ```
   ثم `wsl --shutdown` وافتح Ubuntu من جديد. الشبكة المشتركة تخلي MicroSIP يوصل لـAsterisk، وAsterisk يوصل لمُجيب، كلها على `127.0.0.1`.
2. **بناء Asterisk** (حوالي 10–20 دقيقة):
   ```bash
   sudo bash /mnt/c/Users/<user>/Desktop/Mujeb-MVP/deploy/asterisk/lab/build-asterisk.sh
   ```
   يطبع `BUILD_OK` في النهاية.
3. **الإعدادات:**
   ```bash
   sudo bash /mnt/c/Users/<user>/Desktop/Mujeb-MVP/deploy/asterisk/lab/setup-lab.sh
   ```
   يطبع `CONFIG_OK`. وأول مرة يولّد سرّين في ملفات `root` فقط (`chmod 600`):
   - `/etc/asterisk/lab-softphone-password`: كلمة سر حساب MicroSIP.
   - `/etc/asterisk/mujeeb-telephony-password`: السر المشترك مع مُجيب.

   والملفان اللي فيهما السرّان (`pjsip.conf` و`websocket_client.conf`) لـ`root` فقط (`600`) كذلك، لأن Asterisk في المختبر يعمل كـ`root`. وفي الإنتاج يعمل بمستخدم خاص، فتكون `640 root:asterisk`.

   إعادة التشغيل آمنة: تكتب الإعدادات من جديد وتبقي الأسرار كما هي.
4. **مُجيب:** في `.env` (لا يُرفع إلى git):
   ```dotenv
   MUJEEB_TELEPHONY_PASSWORD=<ناتج: sudo cat /etc/asterisk/mujeeb-telephony-password>
   ```
   باقي القيم الافتراضية في `.env.example` تطابق المختبر: المنفذ `8790`، والمستخدم `asterisk`، والمسارات في `config/telephony/routes.json` (المفتاح `300` ← `config/agents/demo-clinic`).
5. **MicroSIP:** أضف حسابًا:
   - SIP server وDomain: ‏`127.0.0.1:5070`.
   - Username: ‏`6001`.
   - Password: ناتج `sudo cat /etc/asterisk/lab-softphone-password`.
   - في الكودكات فعّل **G.722** أولًا، لأنه أقرب لخط ExaCall. MicroSIP يختار μ-law افتراضيًا.

## التشغيل

```bash
# WSL: تشغيل Asterisk (بدون systemd في المختبر)
sudo asterisk            # يعمل في الخلفية
sudo asterisk -rvvv      # الكونسول، للمتابعة
```

```powershell
# Windows: مُجيب
npm.cmd run telephony        # المزودون الحقيقيون
npm.cmd run telephony:fake   # مزودون وهميون، بدون مفاتيح
```

ثم من MicroSIP:
- **100**: رسالة ثم صدى صوتك. يختبر مسار الصوت بدون مُجيب.
- **300**: مُجيب. في سجل مُجيب يظهر `call.start`، ورقم المتصل مقنّع.

أوامر مفيدة في الكونسول:
- `pjsip show endpoints`: هل MicroSIP مسجّل.
- `dialplan show lab`: الـdialplan الحالي.
- `core reload`: بعد إعادة `setup-lab.sh`.
- `core stop now`: إيقاف Asterisk.

## رسالة الاعتذار

إذا فشلت المكالمة إلى مُجيب والمتصل ما زال على الخط، يسمع: «عذرًا، ما نقدر نخدمك الحين. فضلًا اتصل مرة ثانية بعد شوي.» ثم تُقفل المكالمة.

- **تُشغَّل في كل الحالات التالية:**
  - مُجيب متوقف.
  - رفض المكالمة: رقم بدون route، أو تجاوز الحد، أو كلمة سر خطأ.
  - الـSTT ما اتصل خلال مهلة التجهيز (`MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS`، ‏7 ث)، والمحاولتان داخلة فيها. مُجيب ما يرد أصلًا، فالمتصل يسمع الرنين ثم الرسالة (`NOANSWER/16`)، بدون صمت بعد الرد.
  - لم يرد خلال 10 ثوانٍ.
  - انتهت جهته بعد الرد لأي سبب.
- **لا تُشغَّل:** إذا قفل المتصل، أو إذا أُقفلت قناة المتصل نفسها (الإنهاء الطبيعي مستقبلًا يكون بهذه الطريقة، عبر التحكم بالمكالمة).
- **السبب:** بعد الرد، كل طرق انتهاء جهة مُجيب تظهر للـdialplan بنفس القيم (`DIALSTATUS=ANSWER` و`HANGUPCAUSE=16`)، فلا يمكن التمييز بينها. القياسات في `plans/2026-10-28-phase-4-step-2-lab.md` (البند 3).
- في سجل Asterisk يظهر السطر `mujeeb: call not completed` ومعه `DIALSTATUS` و`HANGUPCAUSE`.

## مكالمات اصطناعية (اختبارات الحمل)

`load-calls.sh` يبدأ عدة مكالمات في نفس اللحظة بدون softphone. كل مكالمة تقول عبارة قصيرة، ثم صمتًا، وتكرر:

```bash
sudo bash /mnt/c/Users/<user>/Desktop/Mujeb-MVP/deploy/asterisk/lab/load-calls.sh 5 180 3            # خمس مكالمات على 300 لمدة 3 دقائق
sudo bash /mnt/c/Users/<user>/Desktop/Mujeb-MVP/deploy/asterisk/lab/load-calls.sh 4 180 3 300 301    # عيادتان (routes.two-clinics.json)
```

- مع `npm.cmd run telephony:fake` لا توجد أي تكلفة. والمزودون الحقيقيون يحتاجون موافقة على التكلفة أولًا.
- للقياس: `MUJEEB_TELEPHONY_HEALTH_LOG_MS=5000` (سطر `gateway.health`) و`MUJEEB_TELEPHONY_STATUS_PROBE_MS=1000` (سطر `transport.queue_status`).
- العيادتان تحتاجان `MUJEEB_SCHEDULING_PROVIDER=memory` و`MUJEEB_TELEPHONY_ROUTES=config/telephony/routes.two-clinics.json`. البوابة ترفض العمل بعيادتين على Medplum.

## التسجيل للتشخيص (اختياري، مغلق افتراضيًا)

```bash
sudo env MUJEEB_LAB_RECORD=1 bash /mnt/c/Users/<user>/Desktop/Mujeb-MVP/deploy/asterisk/lab/setup-lab.sh
sudo asterisk -rx 'dialplan reload'
```

- يسجّل مكالمات 300 في `/var/spool/asterisk/monitor/`: صوت المتصل (ما يستقبله الـSTT بالضبط)، وصوت مُجيب، والمزيج. الصيغة WAV ‏16 kHz.
- **للمختبر فقط وببيانات وهمية فقط.** التسجيلات لا تُنسخ إلى المستودع.
- للإيقاف: شغّل `setup-lab.sh` بدون المتغير، ثم `dialplan reload`.

## مشاكل معروفة

| العرض | السبب والحل |
|---|---|
| Asterisk ما يقدر يفتح المنفذ 5060 | MicroSIP ماسكه، والمنافذ مشتركة في وضع mirrored. المختبر يستخدم 5070 |
| مكالمة بدون صوت، أو صوت في اتجاه واحد | MicroSIP يعلن عنوان الشبكة المنزلية، وهو يرجع لـUbuntu نفسه. الحل `rtp_symmetric` و`force_rport` و`rewrite_contact`، وكلها موجودة في `pjsip.conf` |
| رسالة الاعتذار فورًا على 300 | مُجيب مو شغّال، أو كلمة السر غلط (سجل مُجيب: `telephony.connection_refused`)، أو الرقم مو في `routes.json` (`call.refused` بسبب `unknown_route`) |
| `setup-lab.sh` يفشل بـ`Missing .../unavailable.sln16` | ولّد الرسالة أولًا: `npm.cmd run lab:render-unavailable` |
| سجل مُجيب: `transport.format_mismatch` | الـdialplan لازم يطلب `c(slin16)` |

## الفرق عن الإنتاج

هذا المختبر **ليس قالب إنتاج**. قوالب `deploy/asterisk/` للإنتاج خطوة لاحقة في Phase 4، وتشمل:
- trunk الـExaCall يُعرّف بالـIP، وG.722 ثم A-law.
- إعدادات NAT على Oracle.
- قائمة modules محددة بدل `autoload`.
- تشغيل Asterisk كخدمة بمستخدم غير root.
- بدون تسجيل.

الثابت بين المختبر والإنتاج هو **عقد الـdialplan مع مُجيب** فقط:
- المتغيرات الموروثة `__MUJEEB_DID` و`__MUJEEB_CALLER` و`__MUJEEB_CALL_ID`، وتصل في `MEDIA_START` وليس في الرابط.
- الأمر `Dial(WebSocket/<connection>/c(slin16)f(json)n,<مهلة>,g)`:
  - بدون رد تلقائي. مُجيب يرسل `ANSWER` بعد ما يتصل الـSTT، لا قبل.
  - مهلة `Dial` لازم تكون أكبر من `MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS` بهامش يكفي. في المختبر 10 ث مقابل 7 ث.
  - الرجوع من `Dial` والمتصل على الخط يعني فشلًا، فتُشغَّل رسالة الاعتذار.
- اتصال `websocket_client` بـusername/password.

الأسماء معرّفة في الكود في `DIALPLAN_VARIABLES` (`src/adapters/telephony/asterisk/asterisk-ws-transport.ts`).
