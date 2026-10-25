# مُجيب: بحث ربط الاتصال الهاتفي (SIP trunk → مُجيب)

> **v1 (2026-10-21):** بحث ومقترح أولي، **غير معتمد**. الاتصال الهاتفي من Phase 4 في `docs/ROADMAP.md`، وهذا الملف لا يغيّر نطاق المرحلة الحالية.
> المرجع السابق: تقييم ExaCall بتاريخ 2026-10-20 (pricing والأسئلة المفتوحة).
> **تحديث 2026-10-21:** نتائج الاجتماع التقني مع ExaCall والتقرير الكامل في `plans/2026-10-21-exacall-integration-report.md`.

---

## 1. الوضع الحالي

- ExaCall تعطي **SIP trunk فقط** (IP allowlist). قالوا إن الـWebSocket "موجود في البنية التحتية"، لكن ما عندهم توثيق تقني.
- مُجيب يستقبل الصوت عبر الـport `AudioTransport` (`src/ports/audio-transport.ts`). الـadapter الوحيد اليوم هو المتصفح (`browser-ws-transport.ts`): ‏PCM 16kHz عبر WebSocket، مع epochs وmarks وclear وpause.
- المشكلة: الـSIP trunk يرسل SIP للإشارة وRTP للصوت، وهذي لغة غير لغة مُجيب. نحتاج **بوابة** في المنتصف تفهم SIP/RTP وتعطي مُجيب صوتًا عبر WebSocket.

## 2. الخيارات التي ظهرت في البحث

| الخيار | الفكرة | مناسب لنا؟ |
|---|---|---|
| **Asterisk + `chan_websocket`** | Asterisk يستقبل الـtrunk، ويرسل صوت المكالمة عبر WebSocket إلى تطبيقنا | **المقترح**. خفيف، ومفتوح المصدر، وأوامره تطابق تصميم `AudioTransport` تقريبًا |
| Asterisk + AudioSocket (TCP) | نفس الفكرة لكن عبر TCP خام، وهو أقدم | بديل. لكن التطبيق مسؤول فيه عن توقيت الإطارات |
| FreeSWITCH + `mod_audio_stream`/`mod_audio_fork` | نفس الفكرة على FreeSWITCH | ممكن، لكن الـmodule خارجي وتوثيقه أضعف |
| jambonz (فعل `listen`) | منصة CPaaS مفتوحة المصدر، BYO carrier، وصوت ثنائي الاتجاه عبر WebSocket | مناسب تقنيًا، لكنه منصة كاملة ومكوناتها كثيرة على مطوّر واحد |
| LiveKit SIP + LiveKit Agents | الـtrunk يدخل غرفة LiveKit والـagent ينضم لها | يفرض بناء المحرك حول rooms، وهذا تغيير أكبر مما نحتاج |
| Twilio / Vapi / Retell / ElevenLabs Agents | منصات مستضافة | **لا**. تستبدل محرك مُجيب أو تُخرج الصوت عن السعودية |

## 3. لماذا `chan_websocket` يطابق تصميمنا

من التوثيق الرسمي (docs.asterisk.org → Channel Drivers → WebSocket):
- متوفر من الإصدارات 23.0.0 و22.6.0 و21.11.0 و20.16.0. صيغة التحكم JSON من 22.8.0 و23.2.0 و20.18.0.
- الصوت binary frames، والتحكم والأحداث text frames.
- Asterisk يعيد تقطيع وتوقيت الصوت المرسل إليه إلى إطارات 20ms، فلا نحتاج pacing في مُجيب (ما عدا passthrough codecs مثل opus).
- نختار codec الـWebSocket بأنفسنا: `c(slin16)` (PCM 16kHz، وهو نفس الذي نستخدمه الآن) أو `c(ulaw)`. Asterisk يتولى التحويل من codec الـtrunk.

| `AudioTransport` | `chan_websocket` |
|---|---|
| `sendAudio(epoch, data)` | binary frame |
| `sendMark(epoch, name)` | `MARK_MEDIA` مع `correlation_id` |
| حدث `mark` | `MEDIA_MARK_PROCESSED` |
| `clear(epoch)` | `FLUSH_MEDIA` |
| `pause()` / `resume()` | `PAUSE_MEDIA` / `CONTINUE_MEDIA` |
| حدث `closed` | `HANGUP` أو إغلاق الـsocket |
| (لاحقًا) أرقام الهاتف | `DTMF_END` |

تحفظات:
- `MEDIA_MARK_PROCESSED` يعني أن العلامة وصلت مقدمة طابور Asterisk، وليس أن المتصل سمعها (ملاحظة من مطوّر Asterisk في المنتدى).
- حجم رسالة WebSocket الأقصى 65500 byte، وإذا تجاوزناه تنقطع المكالمة. ويفضّل أن يكون طول الرسالة مضاعفًا لـ`optimal_frame_size`.
- الطابور حوالي 1000 إطار (~20 ثانية)، وفيه `MEDIA_XOFF`/`MEDIA_XON` للتحكم بالتدفق.
- أوامر mark/flush/pause **غير متاحة في passthrough mode**. لذلك نستخدم `slin16` أو `ulaw`، وليس opus.

## 4. ما نحتاجه وما لا نحتاجه

**نحتاج:**
1. ExaCall trunk برقم 011 واحد في البداية (أرخص خيار، والوارد مجاني).
2. خادم Linux بـIP ثابت لأن ExaCall تعمل بـIP allowlist. اللابتوب خلف NAT لا يصلح للـtrunk الحقيقي.
3. Asterisk 22 LTS بإصدار ‎≥ 22.8، باستخدام ملفات الإعداد مباشرة (`pjsip.conf` و`extensions.conf` و`websocket_client.conf`).
4. Adapter جديد في مُجيب: `AsteriskWebSocketTransport` يطبّق `AudioTransport`، مع نقطة دخول تنشئ جلسة لكل مكالمة.
5. Firewall: ‏SIP ‏(5060 أو 5061 TLS) من IPs ExaCall فقط، ونطاق منافذ RTP عبر UDP.

**لا نحتاج الآن:**
- Twilio، وVapi، وRetell، ومنصة ElevenLabs Agents: كلها تستبدل محركنا أو تُخرج الصوت عن السعودية.
- LiveKit وjambonz: منصات كاملة أكبر من حاجتنا لـtrunk واحد.
- FreePBX و3CX: واجهات رسومية لا نحتاجها.
- مشاريع Python الجاهزة (hkjarral/Asterisk-AI-Voice-Agent وPipecat): مرجع للفكرة فقط، لأن Python ليست في الـruntime (قرار A10).
- WebRTC، وKubernetes، وقواعد بيانات، وطوابير.

## 5. أسئلة لاجتماع ExaCall التقني

1. هل الربط SIP فقط، أم عندكم WebSocket media streaming موثّق؟ (إذا عندهم WebSocket موثّق، ممكن نستغني عن Asterisk. لكن لا نبني عليه بدون مواصفات مكتوبة.)
2. عناوين IP للإشارة وللصوت (signaling/media)، والمنافذ، وUDP أو TCP أو TLS.
3. الـcodecs المعروضة بالترتيب: G.722؟ G.711 a-law/µ-law؟ وهل يصل الصوت wideband من الجوال فعلًا؟
4. أين يأتي الرقم المتصَل عليه (DID): في Request-URI أم في `To`؟ وأين يأتي رقم المتصل: في `From` أم في `P-Asserted-Identity`؟
5. المصادقة: IP فقط، أم Register أيضًا؟
6. التحويل (transfer): ‏SIP REFER أم re-INVITE؟ (هذا من Phase 5.)
7. SRTP/TLS: متاح؟
8. هل يمكن رقم تجريبي أو اشتراك شهري للتجربة؟
9. "الاستضافة المحلية": هل يستضيفون لنا خادم Linux (Asterisk + مُجيب) قريبًا من الـSBC؟

## 6. خطوات مقترحة

0. **اجتماع ExaCall** بالأسئلة أعلاه.
1. **مختبر مجاني بدون ExaCall:** ‏Asterisk على Linux (‏WSL2 على اللابتوب أو VPS صغير) + softphone (مثل MicroSIP) كـextension داخلي → `Dial(WebSocket/...)` → سكربت Node صغير يرجّع الصوت (echo). **النجاح** = تسمع صوتك يرجع.
2. **Adapter مُجيب:** `AsteriskWebSocketTransport` (في فرع مستقل وبعد اعتماد خطة Phase 4) → مكالمة كاملة من الـsoftphone مع مُجيب، وقياس الأزمنة بنفس الـlogs الحالية.
3. **الـtrunk الحقيقي:** VPS بـIP ثابت، وendpoint لـExaCall في `pjsip.conf` (identify by IP)، وتوجيه الـDID إلى مُجيب. ثم الاتصال من جوال.
4. **التثبيت:** 5 مكالمات متزامنة (عدد قنوات الباقة)، وتنظيف الجلسة عند إغلاق الخط، وcall-id في كل log، وبدون تسجيل مكالمات افتراضيًا.

## 7. مقاطع للمشاهدة

العناوين والقنوات متحقق منها، لكن محتوى المقاطع **لم تتم مشاهدته**.

1. AstriCon 2025: Conversational AI – Real-Time Voice Interaction with Asterisk Audiosocket (قناة Asterisk الرسمية): https://www.youtube.com/watch?v=rblw8y_BVec
2. Asterisk AI Voice Agent - Connecting to 3CX via SIP Trunk (قناة Jugaar): https://www.youtube.com/watch?v=2yhz_XA-cx4
   ومعه: Asterisk AI Voice Agent 4.6 - Connecting Remote Asterisk: https://www.youtube.com/watch?v=4iuaY7nYZ7E
3. How to connect Asterisk to a Digital Receptionist | VoIP School (‏Flavio E. Goncalves): https://www.youtube.com/watch?v=Z_lfnf4DqvI
4. Indian Phone Number for AI Voice Agents | LiveKit + Vobiz SIP Trunk (‏Vijay Deore): https://www.youtube.com/watch?v=PlK1QXk1-zI
5. Building voice agents with jambonz (قناة drachtio): https://www.youtube.com/watch?v=Iw35U87Aa4E

## 8. مصادر

- Asterisk WebSocket channel driver: https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket
- طلب تأكيد تشغيل الصوت في chan_websocket: https://community.asterisk.org/t/need-mechanism-to-acknowledge-when-queued-audio-chunks-are-played-in-websocket-media-connection/110818
- Asterisk-AI-Voice-Agent (Python، مرجع فقط): https://github.com/hkjarral/Asterisk-AI-Voice-Agent
- jambonz overview: https://docs.jambonz.org/guides/get-started/jambonz-overview
- LiveKit SIP trunk setup: https://docs.livekit.io/telephony/start/sip-trunk-setup/
