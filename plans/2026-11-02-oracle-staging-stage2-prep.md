# Phase 4 — Staging: تحضير المرحلة 2 (الحساب، والتكلفة، وإعدادات الإنشاء)

> **v1 (2026-11-02):** الجزء التحضيري من المرحلة 2 فقط، بموافقة المالك.
> - **لم يُنشأ أي مورد، ولم تُفعَّل أي خدمة مدفوعة.**
> - إنشاء الخادم ينتظر موافقة منفصلة بعد مراجعة هذا الملف.
> - الخطة الأم: `plans/2026-11-02-phase-4-oracle-staging.md` (المرحلة 2، ونقاط القرار ق1 وق2 وق5 وق9).
>
> **التصنيف:** **[مؤكد]** = من وثائق Oracle الرسمية أو قائمة أسعارها. **[غير رسمي]** = مصدر طرف ثالث. **[يحتاج تحقق]** = لا يظهر إلا داخل حسابك.

## 0. حدود ما تحققت منه

- **لا وصول لحسابك من هنا:** لا يوجد OCI CLI ولا `~/.oci` على هذا الجهاز، ولم أطلب أي بيانات دخول.
- **لذلك ما يخص الحساب نفسه يُفحص في الكونسول (القسم 1):** نوع الحساب، والمنطقة الرئيسية، والحدود، وظهور الشكل، والضريبة. أعطيتك خطوات محددة لكل بند، وماذا ترسل لي.
- **كل ما عداه تحققت منه من مصادر عامة،** والتصنيف بجانب كل بند.

## 1. فحوص الحساب (أنت، في الكونسول، بدون إنشاء أي شيء)

| # | ماذا | أين في الكونسول | المطلوب | أرسل لي |
|---|---|---|---|---|
| A1 | نوع الحساب | Billing & Cost Management ← Upgrade and Manage Payment | Free Trial (ومعه الرصيد والأيام الباقية)، أو Always Free فقط، أو Pay As You Go | النوع، والأيام الباقية إن كان Trial |
| A2 | المنطقة الرئيسية | القائمة الجانبية: Governance & Administration ← Tenancy details ← Home region. وقائمة المناطق أعلى الصفحة | **Saudi Arabia Central (Riyadh)** ‏`me-riyadh-1` | اسم المنطقة الرئيسية، والمناطق المشتركة |
| A3 | حدود الحوسبة | Governance ← Limits, Quotas and Usage، ثم Service: Compute، وScope: ‏`RUH-AD-1` | "Cores for Standard.E5 based VM and BM instances" المتاح ≥ 1، و"Memory for Standard.E5…" المتاح ≥ 8 | الرقمان (Available) |
| A4 | حد الـIP المحجوز | نفس الصفحة، Service: Virtual Cloud Network | "Reserved Public IPv4" المتاح ≥ 1 | الرقم |
| A5 | ظهور الشكل | Compute ← Instances ← Create instance ← Change shape ← AMD. **ثم Cancel، بدون Create** | `VM.Standard.E5.Flex` قابل للاختيار بـ1 OCPU و8GB | يظهر أم لا |
| A6 | الضريبة | Billing ← Invoices وTax، أو قسم المالية | هل تُضاف 15% على الفاتورة، أم reverse charge لأن الشركة مسجلة في ضريبة القيمة المضافة | الجواب |

**ما تعنيه نتائج A1 وA2** [مؤكد من وثائق Oracle]:
- **حسابات Trial وFree Tier وPay As You Go محصورة في منطقة واحدة مشتركة، هي المنطقة الرئيسية.** وطلب زيادة الحد متاح لـPay As You Go فقط. والمنطقة الرئيسية لا تتغير بعد التسجيل.
  - **إذا لا يوجد حساب بعد:** اختر Riyadh منطقةً رئيسية عند التسجيل.
  - **إذا كانت المنطقة الرئيسية جدة (`me-jeddah-1`):** ما زالت داخل السعودية، ولها AD واحد مثل الرياض. وهذا قرار لك: جدة للتجربة، أو حساب Pay As You Go وطلب الرياض.
  - **إذا كانت خارج السعودية:** لا تُستخدم. الحل حساب جديد منطقته الرئيسية الرياض، أو Pay As You Go مع طلب زيادة.
- **Free Trial:** رصيد $300 لمدة 30 يومًا كحد أقصى. **"Paid resources that were provisioned with your credits during your free trial are reclaimed by Oracle unless you upgrade your account."** فإذا انتهت التجربة وسط الاختبارات حُذف الخادم. **المقترح:** الترقية إلى Pay As You Go قبل إنشاء الخادم، أو قبول أن عمره ينتهي مع التجربة.
- **Always Free وحده:** E5 ليس من الموارد المجانية، فيحتاج ترقية.
- **الحدود (A3 وA4):** إذا كان المتاح صفرًا، يُطلب رفع الحد من نفس الصفحة (Request a service limit increase)، قبل يوم الإنشاء.

**توفر E5.Flex في الرياض:**
- [غير رسمي] قائمة Northflank لـ`me-riyadh-1` تذكر `VM.Standard.E5.Flex` و`E4.Flex` و`E6.Flex`، مع تنبيه منهم أن التوفر "depends on your account and region".
- [مؤكد] الرياض فيها AD واحد، فلا بديل AD عند نقص السعة. البدائل: fault domain آخر، أو `E6.Flex` بنفس السعر، أو `E4.Flex` الأرخص.
- **الحسم في A5.**

## 2. التكلفة

**المصدر:** واجهة أسعار Oracle العامة بالريال، وأعدت جلبها اليوم. تاريخ القائمة 2026-10-08، وليس فيها أي تغيير منذ 25 أكتوبر. الأسعار **بدون ضريبة**.

### الأسعار الأساسية [مؤكد]

| البند | السعر |
|---|---|
| E5 ‏OCPU (`B97384`) | 0.112512 ريال للساعة (E6 بنفس السعر) |
| E5 ذاكرة (`B97385`) | 0.0075008 ريال لكل GB في الساعة |
| قرص Balanced | 0.0956352 لكل GB شهريًا + ‏10 VPU × 0.00637568 = **0.159392 ريال لكل GB شهريًا** |
| Always Free Block Volume | **200GB (boot + block) و5 نسخ احتياطية، في المنطقة الرئيسية فقط، وللحسابات المدفوعة والتجريبية أيضًا** |
| الخروج للإنترنت من الشرق الأوسط | 0 لأول 10TB شهريًا |
| Object Storage | 0 لأول 10GB، ثم 0.0956 لكل GB شهريًا |
| Monitoring | 0 لأول 500 مليون datapoint |
| Notifications بالإيميل | 0 لأول 1,000 إيميل |
| الـIP العام المحجوز | **لا يوجد بند في قائمة الأسعار.** مدونة Oracle عند إطلاق الميزة: "no charge to use this feature" (بلا تاريخ). ومصدر غير رسمي يذكر حوالي $7.3 شهريًا **عندما يكون غير مرتبط** بخادم |

### الخادم المقترح: E5.Flex بـ1 OCPU و8GB، وقرص 50GB

| البند | 744 ساعة (شهر 31 يومًا) | الحالة |
|---|---|---|
| الحوسبة | **128.35** (حوالي 0.1725 ريال للساعة، و4.14 في اليوم) | [مؤكد] |
| القرص 50GB | **0** إذا كانت المنطقة الرئيسية الرياض (ضمن الـ200GB). وإلا **7.97** | [مؤكد] السعر، والانطباق من A2 |
| الـIP المحجوز | **0 متوقع** ما دام مرتبطًا بالخادم | [يحتاج تحقق] في Cost Estimator، وفي Cost Analysis بعد 24–48 ساعة |
| النسخ الاحتياطية (يدوية، 1–2 نسخة) | **0** ضمن النسخ الخمس المجانية في المنطقة الرئيسية. وإلا أقل من حوالي 1 | [مؤكد] الحصة، والحجم تقديري (البيانات المستخدمة فقط، حوالي 6–10GB) |
| الخروج | **0** (المتوقع حوالي 150MB لكل ساعة مكالمة) | [مؤكد] |
| المراقبة والتنبيهات | **0** | [مؤكد] |
| **المجموع بدون ضريبة** | **حوالي 128** (المنطقة الرئيسية الرياض)، **أو حوالي 137** (منطقة أخرى) | |
| **مع 15% ضريبة** (إن أُضيفت، A6) | **حوالي 148، أو حوالي 158** | [يحتاج تحقق] |

- **للمقارنة:** 2 OCPU و8GB = 212.06 للحوسبة. وE4 ‏1 OCPU و8GB = 103.24.
- **الإيقاف:** إيقاف الخادم يوقف أجرة الـOCPU والذاكرة في الأشكال العادية، ويبقى القرص والـIP **[يحتاج تحقق]**.
- **الحذف:** حذف الـIP المحجوز يعني فقدان العنوان الذي أُعطي لـExaCall، فلا يُحذف.
- **رصيد التجربة:** $300 تغطي حوالي 6,500 ساعة من هذا الخادم (حوالي $0.046 للساعة). فالحد الفعلي هو **الثلاثون يومًا، لا الرصيد**.
- **خارج Oracle** (للعلم، لا يبدأ الآن): ExaCall ‏1,647 ريالًا كل ربع، و500 مرة واحدة، و15% ضريبة. والمزودون الحقيقيون من المرحلة 7 فقط.

## 3. الـBudget **ليس سقف إنفاق**

- **ما يفعله [مؤكد]:** Budget في OCI **يرسل تنبيهًا فقط**. لا يوقف خادمًا، ولا يمنع إنشاء مورد، ولا يحد الفاتورة.
- **حساب Pay As You Go ليس له سقف إنفاق إجباري.** الحد الوحيد الفعلي هو رصيد التجربة المسبق، وهو مرتبط بمدتها.
- **ما نضعه:**
  1. **Budget على compartment الـStaging:** ‏200 ريال شهريًا، وتنبيهات عند 50% و80% و100% من الفعلي، و100% من المتوقع (forecast)، إلى إيميلك. للإنذار المبكر فقط.
  2. **Quotas على الـcompartment (اختياري، مقترح):** تمنع **إنشاء** أكثر من المخطط له. لا توقف ما يعمل، ولا تحد الفاتورة. الصيغة تُراجع في محرر الـQuota في الكونسول، لأن أسماء الحصص **[يحتاج تحقق]**:
     ```text
     zero compute-core quotas in compartment mujeeb-staging
     set compute-core quota standard-e5-core-count to 1 in compartment mujeeb-staging
     set compute-memory quota standard-e5-memory-count to 8 in compartment mujeeb-staging
     set vcn quota reserved-public-ip-count to 1 in compartment mujeeb-staging
     ```
  3. **المراجعة اليدوية:** ‏Cost Analysis بعد 24–48 ساعة من الإنشاء. **وإذا زادت التكلفة الفعلية عن التقدير بأكثر من 10%: توقف وتقرير** (شرط المرحلة 2).
- **[غير رسمي، للعلم]:** Oracle تنشر نمطًا لسقف شبه إجباري، فيه Budget وEvent وFunction تنشئ Zero Quota. **لا يوقف** الموارد العاملة، وهو أكبر من حاجة خادم واحد، فلا نقترحه.

## 4. إعدادات الإنشاء المقترحة (للمراجعة، لا تُنفَّذ قبل موافقتك)

**الترتيب:** المتطلبات المسبقة (A1–A6 والترقية إن لزمت) ← compartment ← budget ← VCN ← NSG ← reserved IP ← instance ← ربط الـIP ← فحص المنافذ من الخارج. وكلها بيدك في الكونسول.

### الحساب والحوكمة

| المورد | القيمة |
|---|---|
| Compartment | `mujeeb-staging` تحت الـroot |
| Tags (free-form) | `project=mujeeb`، و`env=staging` على كل مورد |
| Budget | حسب القسم 3 |
| Notifications topic | `mujeeb-staging-alerts`، واشتراك إيميلك (يحتاج تأكيدًا من الإيميل) |
| Quotas | القسم 3 (اختياري) |

### الشبكة

| المورد | القيمة | السبب |
|---|---|---|
| VCN | `mujeeb-staging-vcn`، ‏`10.0.0.0/16`. **يدويًا، لا بالمعالج (wizard)** | المعالج ينشئ subnet خاصة وNAT Gateway وService Gateway لا نحتاجها |
| Internet Gateway | `mujeeb-staging-igw` | الوصول للإنترنت |
| Route table (الافتراضي) | `0.0.0.0/0` ← Internet Gateway | |
| Subnet | `mujeeb-staging-public`، ‏`10.0.0.0/24`، عامة، regional | `LOCAL_NET` في `host.env` = ‏`10.0.0.0/16` |
| Default Security List | **احذف قاعدة TCP 22 من `0.0.0.0/0`** التي تُنشأ تلقائيًا. وأبقِ: الخروج كله، وICMP type 3 code 4 من `0.0.0.0/0` (لـPath MTU)، وICMP type 3 من `10.0.0.0/16` | كل الدخول يكون من الـNSG فقط، في مكان واحد |
| NSG ‏`mujeeb-staging-nsg` | **دخول:** TCP 22 من `<عنوانك>/32` فقط. **خروج:** الكل | apt وnpm وGitHub وnodejs.org، ثم المزودون في المرحلة 7 |
| NSG في المرحلة 5 (لاحقًا) | UDP 5060 (وTCP إن طُلب) من عناوين إشارة ExaCall، وUDP ‏10000–10199 من عناوين الصوت | `firewall-sip.sh` يكرر نفس القائمة على الخادم |

- **ق2: هل عنوانك ثابت؟** إذا كان يتغير، فبديل الـ`/32` هو OCI Bastion. وجوده في قائمة الأسعار وتكلفته [يحتاج تحقق]. أو تعدّل القاعدة عند كل تغيير.

### الخادم

| الإعداد | القيمة |
|---|---|
| الاسم والـhostname | `mujeeb-staging-1` |
| المنطقة والـAD | `me-riyadh-1`، و`RUH-AD-1` (الوحيد). والـfault domain تختاره Oracle |
| الصورة | **Canonical Ubuntu 24.04** (x86_64)، الإصدار العادي لا Minimal. هذا ما يتحقق منه `bootstrap-host.sh` |
| الشكل | `VM.Standard.E5.Flex`، ‏**1 OCPU و8GB**، **بلا burstable**، لأن الصوت لحظي ولا يتحمل خنق الـCPU |
| الشبكة | `mujeeb-staging-vcn` و`mujeeb-staging-public`، ومعها `mujeeb-staging-nsg` |
| IP خاص | ثابت، `10.0.0.10` (اختياري، يسهّل القراءة) |
| IP عام | **لا ephemeral عند الإنشاء.** يُربط الـReserved IP بعده |
| مفتاح SSH | مفتاحك العام (ed25519). **المفتاح الخاص لا يغادر جهازك ولا يمر عبري** |
| Boot volume | 50GB، وBalanced (10 VPU)، وتشفير بمفتاح Oracle، و**in-transit encryption مفعّل** |
| Instance Metadata | **Require an authorized header (IMDSv2 فقط)** |
| Oracle Cloud Agent | Compute Instance Monitoring **مفعّل** (مقاييس مجانية). ومُطفأ: Custom Logs Monitoring (السجلات تبقى على الخادم)، وManagement Agent، وOS Management، وBastion plugin (إلا إذا اخترت Bastion في ق2) |
| Shielded instance | مُطفأ (افتراضي). لا حاجة له في الـStaging، ويُراجع قبل الإنتاج |
| بعد الصيانة | Restore instance lifecycle state: مفعّل |
| نسخ احتياطية مجدولة | **لا** (ق5: يدوية قبل كل تغيير كبير) |

### الـIP المحجوز

| الإعداد | القيمة |
|---|---|
| الاسم | `mujeeb-staging-ip`، في `mujeeb-staging` |
| الربط | VNIC الأساسي ← IPv4 Addresses ← الـIP الخاص ← Edit ← Reserved public IP |
| القاعدة | **لا يُحذف أبدًا بعد إعطائه لـExaCall.** وإذا أُعيد إنشاء الخادم، يُنقل الـIP نفسه |

### تنبيهات المراقبة (اختيارية في هذه المرحلة)

- `CpuUtilization` > 80% لمدة 5 دقائق.
- `MemoryUtilization` > 85%.
- غياب المقاييس 10 دقائق (الخادم متوقف).
- كلها إلى `mujeeb-staging-alerts`.

### ما لا يُنشأ

Bastion (إلا بقرار ق2)، وVault، وLogging، وLoad Balancer، وNAT Gateway، وDNS، وFile Storage، وأي مورد ثانٍ.

### القبول بعد الإنشاء (من الخطة الأم، المرحلة 2)

- **فحص منافذ من شبكة أخرى:** لا شيء مفتوح. ومن عنوانك: 22 فقط.
- **القاعدة المحذوفة:** لا قاعدة 22 من `0.0.0.0/0` في الـSecurity List.
- **الربط:** الـIP المحجوز مربوط، ولا يوجد ephemeral.
- **التكلفة:** ‏Cost Analysis بعد 24–48 ساعة ضمن ±10% من هذا التقدير، بندًا بندًا (الحوسبة، والقرص، والـIP، والنسخ).
- **بعدها فقط:** `bootstrap-host.sh` (بموافقتك، ويحتاج push للفرع، ق11).

## 5. ما ينتظر منك

1. **نتائج A1–A6.**
2. **قرارات:**
   - **ق1:** المواصفات. المقترح 1 OCPU و8GB.
   - **ق2:** عنوان ثابت `/32`، أم Bastion.
   - **الترقية إلى Pay As You Go** إذا كان الحساب Trial.
   - **جدة:** إذا كانت المنطقة الرئيسية جدة، هل تُستخدم.
   - **Quotas:** هل تُضاف.
3. **موافقة صريحة على الإنشاء** بعد ما سبق.

## المصادر (روجعت 2026-11-02)

- أسعار OCI (SAR): `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=SAR`
- المناطق، وعدد الـADs، وحد المنطقة الواحدة: https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
- Free Tier وانتهاء التجربة: https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm
- Always Free (200GB و5 نسخ، والمنطقة الرئيسية): https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- الـReserved IP: https://blogs.oracle.com/cloud-infrastructure/release-announcement-reserved-public-ips-are-now-available-on-oracle-cloud-infrastructure ، و https://docs.oracle.com/iaas/Content/Network/Tasks/managingpublicIPs.htm
- Budgets لا توقف الإنفاق: https://docs.cloud.oracle.com/iaas/Content/Billing/Tasks/create-alert-rule.htm ، و https://blogs.oracle.com/cloud-infrastructure/enforced-budgets-on-oci-using-functions-and-quotas
- الأشكال في `me-riyadh-1` [غير رسمي]: https://northflank.com/cloud/oci/regions/me-riyadh-1
