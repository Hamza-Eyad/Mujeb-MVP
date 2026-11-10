# مختبر الهاتف المحلي: MicroSIP ← Asterisk ← مُجيب

> **مختبر محلي على جهاز التطوير فقط، وليس ربطًا تجاريًا.**
> - لا يوجد فيه خادم Oracle، والـSIP مربوط على `127.0.0.1` فقط.
> - الاستثناء الوحيد خط تجريبي مؤقت من مزود (القسم «خط تجريبي من مزود» أدناه)، وهو مطفي افتراضيًا.
> - القرار: `docs/DECISIONS.md` A19. الخطة: `plans/2026-10-25-phase-4-call-connection.md`.

```text
MicroSIP (Windows) --SIP/RTP 127.0.0.1:5070--> Asterisk 22.11.0 (WSL Ubuntu 24.04)
  --Dial(WebSocket/mujeeb/c(slin16)f(json)n)--> ws://127.0.0.1:8790/media --> npm run telephony (Windows)
```

## الملفات

| الملف | الغرض |
|---|---|
| `build-asterisk.sh` | بناء Asterisk ‏22.11.0 من المصدر. الإصدار والـchecksum ثابتان، والبناء يفشل لو الملف مختلف |
| `setup-lab.sh` | كتابة إعدادات `/etc/asterisk` كاملة، وتوليد كلمات السر خارج المستودع، وتثبيت رسالة الاعتذار. وفيه خط تجريبي اختياري (`MUJEEB_LAB_TRUNK`) |
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
- `core show channels` ثم `core show channel <الاسم>`: الكودك المستخدم في المكالمة (سطر `NativeFormats` في قناة `PJSIP/6001-…`).
- `core reload`: بعد إعادة `setup-lab.sh`.
- `core stop now`: إيقاف Asterisk.

## رسالة الاعتذار

إذا فشلت المكالمة إلى مُجيب والمتصل ما زال على الخط، يسمع: «عذرًا، ما نقدر نخدمك الحين. فضلًا اتصل مرة ثانية بعد شوي.» ثم تُقفل المكالمة.

- **تُشغَّل في كل الحالات التالية:**
  - مُجيب متوقف.
  - رفض المكالمة: رقم بدون route، أو تجاوز الحد، أو كلمة سر خطأ.
  - الـSTT ما صار جاهزًا خلال مهلة التجهيز (`MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS`، ‏7 ث)، والمحاولتان داخلة فيها:
    - الجاهزية هي تأكيد المزود للجلسة (`session_started`)، لا فتح الاتصال.
    - وخطأ مصادقة قبل التأكيد ينهي المحاولة فورًا.
    - مُجيب ما يرد أصلًا، فالمتصل يسمع الرنين ثم الرسالة (`NOANSWER/16`)، بدون صمت بعد الرد.
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

## خط تجريبي من مزود (مؤقت، مطفي افتراضيًا)

> لتجربة رقم تجريبي من مزود لأيام قليلة، بطريقة Registered، **وليس إعداد إنتاج.**
> - لا توجد أي قيمة للخط في المستودع.
> - بدون `MUJEEB_LAB_TRUNK` يكتب `setup-lab.sh` المختبر كما كان حرفيًا.
> - الخطة: `plans/2026-11-09-exacall-demo-lab-trunk.md`.

```text
جوال --> رقم المزود --> SBC المزود <==REGISTER== Asterisk (WSL, 0.0.0.0:5080) --WebSocket--> مُجيب
```

- الخط **وارد فقط**: لا يوجد أي Dial خارج.
- يُعرف بالمكالمة من باراميتر `line` الخاص بالتسجيل، أو من عنوان المزود. وأي مكالمة غيرها تُرفض بـ401.
- حساب MicroSIP ‏(6001) والامتدادات 100 و300 تبقى كما هي.

### التجهيز (مرة لكل رقم)

1. **ملف بيانات الخط:** تكتبه بنفسك. يكون لـroot فقط، ولا يدخل المستودع:
   ```bash
   sudo sh -c 'umask 077 && touch /etc/asterisk/lab-trunk.env'
   sudo nano /etc/asterisk/lab-trunk.env
   ```
   ```dotenv
   TRUNK_HOST=<SIP server من إيميل المزود>
   TRUNK_PORT=<SIP port>
   TRUNK_USERNAME=<username>
   TRUNK_PASSWORD=<password>
   # فقط إذا لم تصل المكالمة أو صار الصوت باتجاه واحد:
   # TRUNK_PUBLIC_IP=<عنوان البيت العام>
   ```
   - السكربت لا ينفّذ الملف، يقرأ هذه المفاتيح فقط.
   - يُسمح بالرمز `;` في كلمة السر.
2. **في MicroSIP:** عطّل حساب المزود وارجع لحساب Lab، حتى لا يكون هناك جهازان مسجّلان على نفس الحساب.
3. **التشغيل:**
   ```bash
   sudo env MUJEEB_LAB_TRUNK=echo bash /mnt/c/Users/<user>/Desktop/Mujeb-MVP/deploy/asterisk/lab/setup-lab.sh
   sudo asterisk                        # وإذا كان يعمل: sudo asterisk -rx 'core restart now' (transport جديد)
   sudo asterisk -rvvv
   ```
   في الكونسول، `pjsip show registrations` يجب أن يظهر `Registered`.

### البوابات بالترتيب

1. **`MUJEEB_LAB_TRUNK=echo`:** اتصل من جوالك على الرقم. تسمع hello-world ثم صدى صوتك.
   - في الكونسول يظهر سطر `trunk: exten=... to=...`. وقيمة `exten` هي مفتاح الـroute.
   - أثناء المكالمة: `core show channels verbose` (الكودك) و`pjsip show channelstats` (RTP في الاتجاهين).
2. **`MUJEEB_LAB_TRUNK=mujeeb` مع `npm.cmd run telephony:fake`:**
   - **ملف routes محلي:** `config/telephony/routes.local.json`، وهو مستبعد من git. المفتاح فيه هو `exten` من البوابة 1:
     ```json
     { "routes": [ { "key": "<exten>", "agentProfile": "config/agents/demo-clinic", "note": "Demo trunk, temporary" } ] }
     ```
   - **وفي `.env`:** ‏`MUJEEB_TELEPHONY_ROUTES=config/telephony/routes.local.json`.
   - **ثم:** `setup-lab.sh` بالوضع `mujeeb`، و`dialplan reload`. الـreload يكفي هنا لأن الـtransport نفسه.
3. **المزودون الحقيقيون:** مكالمة واحدة، بعد تقدير التكلفة والموافقة.

### الخصوصية
- أثناء تشغيل الخط، ملف السجل الوحيد هو `/var/log/asterisk/messages`، وفيه warnings وerrors فقط.
- أرقام المتصلين تظهر في الكونسول فقط.
- التسجيل (`MUJEEB_LAB_RECORD=1`) مرفوض مع الخط.

### الإيقاف والتنظيف بعد انتهاء الرقم

```bash
sudo bash /mnt/c/Users/<user>/Desktop/Mujeb-MVP/deploy/asterisk/lab/setup-lab.sh   # المختبر كما كان حرفيًا
sudo asterisk -rx 'core restart now'
sudo rm /etc/asterisk/lab-trunk.env
```

ثم احذف `config/telephony/routes.local.json`، وسطر `MUJEEB_TELEPHONY_ROUTES` من `.env`.

### مشاكل متوقعة

| العرض | السبب والحل |
|---|---|
| `Rejected` في `pjsip show registrations` | بيانات `lab-trunk.env`. التسجيل يتوقف بعد 401/403 حتى لا يحظرنا المزود. صحّح الملف ثم أعد `setup-lab.sh` و`core restart now` |
| `Registered`، لكن الجوال لا يرن أو يقول «الرقم غير مستعمل» | المكالمة لم تعبر الـNAT في البيت. ضع `TRUNK_PUBLIC_IP` |
| صوت باتجاه واحد | NAT، أو Hyper-V firewall حق WSL يحجب RTP. ضع `TRUNK_PUBLIC_IP`، وإذا لم يكفِ فالحل قاعدة firewall لمنافذ RTP ‏10000–10100 |
| `pjsip show contacts` يظهر `Unavailable` | المزود لا يرد على OPTIONS. الـOPTIONS هنا لإبقاء الـNAT مفتوحًا فقط، ولا يؤثر على المكالمات الواردة |
| «الرقم غير مستعمل» وAsterisk متوقف | طبيعي مع Registered: لا يوجد جهاز مسجّل |

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
  - بدون رد تلقائي. مُجيب يرسل `ANSWER` بعد ما يؤكد مزود الـSTT الجلسة، لا قبل.
  - مهلة `Dial` لازم تكون أكبر من `MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS` بهامش يكفي. في المختبر 10 ث مقابل 7 ث.
  - الرجوع من `Dial` والمتصل على الخط يعني فشلًا، فتُشغَّل رسالة الاعتذار.
- اتصال `websocket_client` بـusername/password.

الأسماء معرّفة في الكود في `DIALPLAN_VARIABLES` (`src/adapters/telephony/asterisk/asterisk-ws-transport.ts`).
