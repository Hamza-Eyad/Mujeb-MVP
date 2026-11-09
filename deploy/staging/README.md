# خادم الـStaging: ‏ExaCall ← Asterisk ← مُجيب على Oracle Cloud (الرياض)

> **بيئة تجريبية ببيانات اصطناعية فقط، وليست إنتاجًا.**
> - الخطة والقرارات: `plans/2026-11-02-phase-4-oracle-staging.md`، وتعديلات الخادم الحالي `plans/2026-11-09-skyline-staging-adaptation.md`، والقرار المعماري `docs/DECISIONS.md` A19.
> - **الخادم الحالي من Skyline**، وهو VM على Oracle Cloud الرياض نفسه (`me-riyadh-1`)، بمعالج ARM ‏(aarch64). نفس السكربتات تعمل على Oracle مباشرة، وعلى x86_64 وaarch64.
> - المختبر المحلي له ملفاته الخاصة في `deploy/asterisk/lab/`، ولا علاقة لهذه الملفات به.
> - **كل مرحلة تحتاج موافقة المالك.** والمراحل التي فيها تكلفة الخادم أو منافذ مفتوحة للإنترنت أو مزودون حقيقيون لها موافقة صريحة.

```text
جوال ──PSTN──▶ ExaCall SBC ──SIP 5060 + RTP 10000–10199 (عناوين ExaCall فقط)──▶ VM ‏(me-riyadh-1، IP عام محجوز)
   asterisk.service (asterisk -mqf، ومستخدم asterisk)
      ──ws://127.0.0.1:8790/media (اتصال لكل مكالمة)──▶ mujeeb-telephony.service (node، ومستخدم mujeeb)
```

## الملفات

| الملف | الغرض |
|---|---|
| `bootstrap-host.sh` | تجهيز الخادم مرة واحدة: الحزم، وSSH بالمفاتيح فقط، وjournald (‏14 يومًا، وبلا نسخة في syslog)، والمستخدمان، والمجلدات، وNode ‏24.22.2 بـSHA-256 ثابت، و`deploy.env`، والخدمات. **لا يفتح أي منفذ** |
| `deploy-mujeeb.sh` | نشر commit محدد: قفل، ثم فحص المكالمات، ثم البناء، ثم التبديل، ثم مراقبة 30 ث، ثم رجوع تلقائي عند الفشل |
| `rollback-mujeeb.sh` | الرجوع للإصدار السابق بنفس الفحص والمراقبة |
| `lib.sh` | دوال مشتركة: فحص المكالمات الحية، والمراقبة بعد إعادة التشغيل، وتنظيف الإصدارات القديمة |
| `healthcheck.sh` + `systemd/mujeeb-healthcheck.*` | فحص الخادم كل 5 دقائق. **بلا أي فحص لـExaCall** |
| `privacy-scan.sh` | يبحث عن أرقام الجوال وأشكال الهوية والنصوص في كل أماكن السجلات، ويطبع أعدادًا فقط |
| `firewall-sip.sh` | سلسلة iptables ‏`MUJEEB-SIP` لعناوين ExaCall فقط، فوق سطر `REJECT`. و`--check` للمقارنة |
| `systemd/mujeeb-telephony.service` | خدمة مُجيب |
| `mujeeb.env.example` | إعدادات مُجيب على الخادم: مزودون وهميون، وبلا مفاتيح، و`MUJEEB_LOG_TRANSCRIPTS=false` |
| `routes.example.json` | مسار المحاكاة `990300`، ومكان الـDID الحقيقي |
| `../asterisk/staging/setup-asterisk.sh` | يكتب `/etc/asterisk` من `asterisk-host.env`، ويأخذ نسخة قبلها ويستعيدها عند الفشل. و`--conf-dir` للمراجعة |
| `../asterisk/staging/check-asterisk-config.sh` | ثوابت الإعدادات: بلا تسجيل، وبلا مسار صادر، وبلا CDR/CEL/AMI/ARI، وسجل `warning,error` فقط، والـDID كما يصل |
| `../asterisk/staging/host.env.example` | العنوان العام، ونطاق الـVCN، وعناوين ExaCall، وطريقة الربط، والوضع (`echo` أو `mujeeb`) |
| `../asterisk/staging/asterisk.service` | Asterisk كخدمة، و`StandardOutput=null` |
| `../asterisk/staging/trunk-check.sh` | جاهزية ExaCall: الطبقات 1–3. والرابعة مكالمة حقيقية |
| `../asterisk/staging/simulate-trunk-call.sh` + `sipp/inbound-call.xml` | مكالمة "مزود" مُحاكاة بـSIPp من الخادم نفسه |
| `../asterisk/staging/synthetic-calls.sh` | مكالمات اصطناعية متزامنة لاختبار الحمل (Local channels) |

ويُعاد استخدام `../asterisk/lab/build-asterisk.sh` (‏22.11.0 بـSHA ثابت) و`../asterisk/lab/sounds/unavailable.sln16` كما هما.

## على الخادم

| المسار | المحتوى |
|---|---|
| `/opt/mujeeb/releases/<sha>/` | إصدار مبني، للقراءة فقط للخدمة. ويُحتفظ بثلاثة |
| `/opt/mujeeb/current` ، `/opt/mujeeb/previous` | روابط للإصدار الحالي والسابق |
| `/opt/node/current` | Node 24 |
| `/etc/mujeeb/mujeeb.env` | إعدادات مُجيب وأسراره (`0640 root:mujeeb`) |
| `/etc/mujeeb/routes.json` | التوجيه: الـDID ← profile |
| `/etc/mujeeb/asterisk-host.env` | قيم الخادم وExaCall (`0600 root`) |
| `/etc/mujeeb/exacall-trunk.env` | بيانات دخول ExaCall إن كان الربط بالتسجيل (`0600 root`) |
| `/etc/mujeeb/deploy.env` | عنوان المستودع (من `git remote`) |
| `/etc/asterisk/` | مولّد بالكامل، `0640 root:asterisk`. والسر المشترك في `mujeeb-telephony-password` |
| `/var/lib/mujeeb/logs/` | `turns-*.jsonl`، تُحذف بعد 30 يومًا |
| `/var/log/asterisk/messages` | التحذيرات والأخطاء فقط، 14 يومًا |
| `/var/backups/mujeeb-asterisk/` | نسخ `/etc/asterisk` قبل كل تغيير |

## المرحلة 2: الخادم (💰 تبدأ التكلفة الشهرية)

1. **إنشاء الخادم (المالك):**
   - **Skyline (الحالي):** المنطقة Riyadh، وUbuntu 24.04 LTS، والدخول بـSSH key فقط، والشبكة Public، والـFirewall ‏"SSH only". وبعد الإنشاء مباشرة: مصدر قاعدة TCP 22 في Firewall لوحة التحكم = عنوانك `/32`. الدخول بـ`ubuntu@<IP>`، لأن root مرفوض.
   - **Oracle مباشرة (بديل):** تقدير التكلفة وBudget (الخطة، المرحلة 2)، ثم VCN، وNSG (SSH من عنوانك فقط)، وReserved IP، وVM ‏Ubuntu 24.04.
2. على الخادم، بحسابك (ليس root)، بعد أن تقرر أي commit تستخدم:
   ```bash
   git clone https://github.com/<owner>/<repo>.git ~/mujeeb-src && cd ~/mujeeb-src && git checkout <sha>
   sudo bash deploy/staging/bootstrap-host.sh        # يطبع BOOTSTRAP_OK
   ```
   - يثبّت التحديثات المعلقة، ويضيف `REJECT` في آخر INPUT إذا لم تكن موجودة (صورة Skyline بلاها).
   - **قبل إغلاق الجلسة:** افتح جلسة SSH ثانية وتأكد أنك تدخل.
   - إذا طبع `REBOOT_REQUIRED`: ‏`sudo reboot`، ثم تأكد من الدخول، ومن أن الـIP العام لم يتغير، ومن `sudo iptables -S INPUT`.
3. **لا `do-release-upgrade`** حتى لو اقترح الخادم نسخة أحدث: كل شيء مبني على 24.04.

## المرحلة 3: Asterisk ومُجيب الوهمي، والاختبارات

```bash
sudo bash deploy/asterisk/lab/build-asterisk.sh                       # BUILD_OK (‏20–40 دقيقة على 2 vCPU)
sudo install -m 600 deploy/asterisk/staging/host.env.example /etc/mujeeb/asterisk-host.env
sudoedit /etc/mujeeb/asterisk-host.env                                # PUBLIC_IP و LOCAL_NET؛ وللمحاكاة: TRUNK_ENABLED=yes و TRUNK_SIGNALING_IPS=127.0.0.1
sudo bash deploy/asterisk/staging/setup-asterisk.sh                   # CONFIG_OK
sudo install -m 640 -g mujeeb deploy/staging/mujeeb.env.example /etc/mujeeb/mujeeb.env
sudoedit /etc/mujeeb/mujeeb.env                                       # MUJEEB_TELEPHONY_PASSWORD فقط
sudo install -m 640 -g mujeeb deploy/staging/routes.example.json /etc/mujeeb/routes.json
sudo bash deploy/staging/deploy-mujeeb.sh <sha>                       # أول مرة: npm run check على الخادم أيضًا
sudo systemctl enable --now mujeeb-healthcheck.timer
```

- **ملاحظة:** الـcommit يجب أن يكون على GitHub (push)، وهذا يحتاج موافقة المالك (ق11).
- **بعد أول نشر**، الأوامر من `/opt/mujeeb/current/deploy/...`.

**المحاكاة والحمل** (مزودون وهميون فقط، والسكربتات ترفض غير ذلك):

```bash
sudo bash deploy/asterisk/staging/simulate-trunk-call.sh --codec alaw         # trunk معرّف ← mujeeb-call
sudo bash deploy/asterisk/staging/simulate-trunk-call.sh --did 123456         # DID مجهول ← رفض في مُجيب ثم الاعتذار
sudo bash deploy/asterisk/staging/simulate-trunk-call.sh --from 127.0.0.2     # مصدر غير معرّف ← لا قناة
sudo bash deploy/asterisk/staging/synthetic-calls.sh 5 180 4                  # 5 مكالمات متزامنة
```

- اختبار `DID_SOURCE=to`: ‏`--to-user 990300 --did account1` بعد ضبطه في `asterisk-host.env` و`setup-asterisk.sh`.
- **الحدود:** المحاكاة والحمل بالوهمي **لا يثبتان** دقة الـSTT الحقيقي، ولا حمل اتصالات المزودين الحقيقيين (الخطة 3-ز).

**شرط إلزامي: عزل سجلات Asterisk** (لا تنجح المرحلة 3 بدونه):

1. `systemctl show asterisk -p StandardOutput` يطبع `StandardOutput=null`.
2. افتح `sudo asterisk -r` في نافذة ثانية، ثم شغّل `simulate-trunk-call.sh --from 127.0.0.2`.
   - يجب أن يظهر NOTICE ‏`No matching endpoint found` في الـremote console، وفيه الرقم الاصطناعي `0555000123`.
3. `pjsip set logger on`، ثم مكالمة محاكاة، ثم `pjsip set logger off`. يجب أن تظهر الرسائل في الـremote console.
4. `sudo bash deploy/staging/privacy-scan.sh --since "<وقت بداية الاختبار>"`: يجب `PRIVACY_SCAN_OK`.
5. **التجربة الضابطة (تسرب اصطناعي):**
   - `sudo systemctl edit asterisk` ← `[Service]` و`StandardOutput=journal`، ثم `restart`، ثم كرر الخطوة 2.
   - يجب أن يطبع `privacy-scan.sh` ‏`PRIVACY_SCAN_FOUND` ومعه `mobile` أكبر من صفر في journal. هذا يثبت أن الفحص يكشف التسرب.
   - ثم احذف التعديل (`systemctl revert asterisk`)، وأعد التشغيل، و`journalctl --rotate && journalctl --vacuum-time=1s`، ثم أعد الفحص حتى `PRIVACY_SCAN_OK`.

**اختبارات النشر T1–T11** (الخطة 3-و)، كل واحدة بنتيجتها في الخطة:

| # | الطريقة |
|---|---|
| T1 | `deploy-mujeeb.sh <sha2>` ← `DEPLOY_OK` |
| T2 | sha غير موجود على GitHub ← خطأ، و`current` والـPID كما هما |
| T3 | عطّل مؤقتًا `MUJEEB_TELEPHONY_ROUTES` (مسار خاطئ) ثم انشر ← رجوع تلقائي، ثم أعد القيمة |
| T4 | نفس T3 مع مراقبة `NRestarts` و`StartLimitBurst` |
| T5 | `synthetic-calls.sh 1 120 4` ثم انشر ← رفض، والمكالمة مستمرة |
| T6 | نفس T5 مع `--force` ← المكالمة تنقطع وتُسمع رسالة الاعتذار |
| T7 | `systemctl stop asterisk` ثم انشر ← رفض |
| T8 | نشران في نفس اللحظة ← الثاني يُرفض بالقفل |
| T9 | `rollback-mujeeb.sh`، ثم مرة ثانية للرجوع للأمام. وبلا `previous` ← رفض بلا تغيير |
| T10 | `sudo reboot` ← الخدمتان تعودان، ومكالمة محاكاة تنجح |
| T11 | أفسد `asterisk-host.env` مؤقتًا (مثلًا `INBOUND_MODE=x`) ← رفض قبل الكتابة. ثم افحص الاستعادة بإيقاف Asterisk أثناء `setup-asterisk.sh` |

## المرحلة 5: ExaCall (🌐 بعد وصول بياناتهم)

```bash
sudoedit /etc/mujeeb/asterisk-host.env      # TRUNK_* بعناوينهم، و INBOUND_MODE=echo، وحذف 127.0.0.1
sudo bash /opt/mujeeb/current/deploy/asterisk/staging/setup-asterisk.sh --restart
sudo bash /opt/mujeeb/current/deploy/staging/firewall-sip.sh
sudo bash /opt/mujeeb/current/deploy/asterisk/staging/trunk-check.sh
```

- وأضف نفس العناوين يدويًا في Firewall لوحة تحكم Skyline (أو الـNSG في Oracle): ‏UDP ‏`SIP_PORT` من عناوين الإشارة، وUDP ‏`RTP_START`–`RTP_END` من عناوين الصوت. الحد هناك 50 قاعدة.
- **قبلها:** ورقة ترخيص ExaCall من الهيئة (CST). Skyline تشترطها قبل أي مكالمات SIP من الخادم.
- **البوابة:** مكالمة من جوالك إلى الرقم: الرسالة ثم صدى صوتك. وأثناءها `core show channels verbose` و`pjsip show channelstats`.
- التشخيص (`pjsip set logger on`) من الـremote console فقط، ثم `off`، ثم `privacy-scan.sh`.

## المرحلة 6: الـDID ← مُجيب (وهمي)

- الـDID في `/etc/mujeeb/routes.json` **كما ظهر في المرحلة 5، بلا تطبيع**.
- ثم `INBOUND_MODE=mujeeb`، و`setup-asterisk.sh`، و`systemctl restart mujeeb-telephony` وقت الخمول.

## الخصوصية: أين قد تُحفظ البيانات، وكيف تُمنع

| المكان | الإعداد | الفحص |
|---|---|---|
| journald ‏`mujeeb-telephony` | المتصل مقنّع، والنصوص `false` | `privacy-scan.sh` |
| journald ‏`asterisk` (stdout) | `StandardOutput=null`. و`-m` وحده لا يكفي في 22.11.0 | `healthcheck.sh` و`privacy-scan.sh` والتجربة الضابطة |
| journald ‏`asterisk` (stderr) | أخطاء بداية التشغيل فقط | `privacy-scan.sh` |
| `/var/log/asterisk/messages` | `warning,error` فقط: لا notice ولا verbose | `check-asterisk-config.sh` و`privacy-scan.sh` |
| سجل `security` وsyslog في Asterisk | غير مفعّلين | `check-asterisk-config.sh` |
| `/var/log/syslog*` | `ForwardToSyslog=no` | `privacy-scan.sh` |
| CDR وCEL وqueue_log | `enable = no`، وبلا modules | `check-asterisk-config.sh` و`healthcheck.sh` و`privacy-scan.sh` |
| التسجيل الصوتي | لا `MixMonitor` ولا modules تسجيل | `check-asterisk-config.sh` و`healthcheck.sh` و`privacy-scan.sh` |
| `turns-*.jsonl` | بلا نصوص، و30 يومًا | `privacy-scan.sh` |
| core dumps | لا `LimitCORE` | — |

## حدود معروفة

- **لا drain في الكود:** إعادة تشغيل مُجيب تقطع المكالمات الجارية. النشر يرفض إذا وُجدت مكالمات، لكن تبقى ثوانٍ قليلة بين الفحص وإعادة التشغيل.
- **الـDID من `To` لا يُقرأ إذا كان `tel:` URI.** المرحلة 5 تسجل ما ترسله ExaCall فعلًا.
- **Firewall المزود (لوحة Skyline أو الـNSG في OCI) لا يُرى من الخادم:** يُقارن يدويًا.
- **لا snapshots ولا نسخ احتياطي في Skyline:** الخادم يُبنى من جديد من المستودع والسكربتات. احتفظ بنسخة من `/etc/mujeeb/*.env` و`routes.json` خارج الخادم في مكان آمن، وليس في المستودع: فيها أسرار.
- **لم يُختبر شيء هنا على خادم حقيقي بعد** (المرحلة 1 فحوص ثابتة فقط): قائمة الـmodules، وسيناريو SIPp، وsystemd، وiptables، و`flock` كلها تُثبت في المرحلة 3.
