// Mujeeb local test client. Thin by design: captures mic audio, plays engine audio, and displays
// what the engine reports. No API keys and no conversation logic live here.

const SAMPLE_RATE = 16000;
const $ = (id) => document.getElementById(id);

const ui = {
  start: $('start'), stop: $('stop'), mute: $('mute'), volume: $('volume'), state: $('state'),
  connDot: $('conn-dot'), connText: $('conn-text'), notice: $('notice'), settingsToggle: $('settings-toggle'),
  route: $('route'), aec: $('aec'), ns: $('ns'), agc: $('agc'), micLevel: $('mic-level'), micDb: $('mic-db'), wave: $('wave'),
  audioInfo: $('audio-info'), sessionInfo: $('session-info'), sttConfig: $('stt-config'), settingsDetails: $('settings-details'),
  chatScroll: $('chat-scroll'), transcript: $('transcript'), partial: $('partial'), chatEmpty: $('chat-empty'), clearChat: $('clear-chat'),
  pipeline: $('pipeline'), pipeTurn: $('pipe-turn'), gantt: $('gantt'),
  metrics: $('metrics'), metricHelp: $('metric-help'), counters: $('counters'),
  events: $('events'), eventFilter: $('event-filter'), clearEvents: $('clear-events'),
  errors: $('errors'), clearErrors: $('clear-errors'),
  timings: $('timings'), medians: $('medians'), timingsToggle: $('timings-toggle'), timingsBody: $('timings-body'), exportCsv: $('export-csv'),
  loopbackAudio: $('loopback-audio'),
};

// ───────────────────────────── definitions ─────────────────────────────

/** Same spans as the engine's TurnTimeline.durations(). The engine's turn summary stays authoritative. */
const SPANS = {
  stt_finalize_ms: ['user_speech_end', 'stt_committed'],
  llm_ttft_ms: ['llm_request', 'llm_first_token'],
  llm_total_ms: ['llm_request', 'llm_done'],
  tts_ttfb_ms: ['tts_first_text', 'tts_first_audio'],
  first_audio_after_commit_ms: ['stt_committed', 'tts_first_audio'],
  playback_buffer_ms: ['tts_first_audio', 'playback_start'],
  e2e_ms: ['user_speech_end', 'playback_start'],
  barge_in_reaction_ms: ['barge_in_speech_start', 'interrupt_requested'],
  interrupt_stop_ms: ['interrupt_requested', 'playback_stopped'],
};

const METRICS = [
  { key: 'e2e_ms', label: 'التأخير الكلي E2E', primary: true,
    info: 'التأخير الذي يحسه المتصل: من لحظة سكوته حتى يسمع أول صوت من مُجيب. أهم رقم لتقييم السرعة.', formula: 'playback_start − user_speech_end' },
  { key: 'stt_finalize_ms', label: 'إنهاء التفريغ STT',
    info: 'من نهاية كلامك (حسب VAD المحرك) حتى وصول النص النهائي. يشمل مدة الصمت المطلوبة لإنهاء الجملة (vad_silence) ومعالجة المزود.', formula: 'stt_committed − user_speech_end' },
  { key: 'llm_ttft_ms', label: 'أول رد من النموذج',
    info: 'من إرسال الطلب للنموذج حتى وصول أول جزء من الرد (Time To First Token).', formula: 'llm_first_token − llm_request' },
  { key: 'llm_total_ms', label: 'توليد الرد كاملًا',
    info: 'من إرسال الطلب حتى اكتمال الرد. لا يؤثر مباشرة على التأخير المحسوس لأن الصوت يبدأ قبل اكتماله.', formula: 'llm_done − llm_request' },
  { key: 'tools_ms', label: 'زمن الأدوات',
    info: 'مجموع زمن تنفيذ أدوات المواعيد في الدور (البحث، التحقق، الحجز...). يظهر فقط في الأدوار التي استخدمت أداة، ويضاف لزمن الرد.', formula: 'Σ tool.ms' },
  { key: 'tts_ttfb_ms', label: 'أول صوت من TTS',
    info: 'من إرسال أول مقطع نص لـ TTS حتى وصول أول جزء صوتي (Time To First Byte).', formula: 'tts_first_audio − tts_first_text' },
  { key: 'first_audio_after_commit_ms', label: 'أول صوت بعد النص',
    info: 'المعالجة الداخلية بعد وصول النص النهائي: النموذج + التقطيع + TTS حتى أول صوت.', formula: 'tts_first_audio − stt_committed' },
  { key: 'playback_buffer_ms', label: 'من الاستلام للتشغيل',
    info: 'من وصول أول صوت للمحرك حتى بدء تشغيله فعليًا في المتصفح (النقل + التخزين المؤقت).', formula: 'playback_start − tts_first_audio' },
  { key: 'barge_in_reaction_ms', label: 'اكتشاف المقاطعة',
    info: 'من بدء كلامك أثناء حديث مُجيب (حسب VAD المحرك) حتى قرار المقاطعة. يعتمد على سرعة وصول النص الجزئي من STT.', formula: 'interrupt_requested − barge_in_speech_start' },
  { key: 'interrupt_stop_ms', label: 'إيقاف التشغيل',
    info: 'من قرار المقاطعة حتى تأكيد المتصفح أنه أوقف الصوت وفرّغ المخزن.', formula: 'playback_stopped − interrupt_requested' },
  { key: 'transport_rtt_ms', label: 'RTT الاتصال',
    info: 'زمن ذهاب وعودة رسالة ping بين المحرك والمتصفح (تُقاس كل ثانيتين). يمثل تأخير نقل الصوت المحلي.', formula: 'pong − ping (WebSocket)' },
];

const COUNTERS = [
  ['turns', 'الأدوار', 'عدد الأدوار التي بدأها مُجيب (تشمل التحية والأدوار الملغاة).'],
  ['interruptions', 'المقاطعات', 'عدد المرات التي أُلغي فيها رد مُجيب بسبب كلام المتصل.'],
  ['falseInterruptions', 'مقاطعات كاذبة', 'إيقاف مؤقت بسبب صوت لم يتأكد أنه كلام، ثم استُؤنف التشغيل.'],
  ['echoSuppressed', 'صدى تم تجاهله', 'نصوص طابقت كلام مُجيب نفسه (صدى السماعة) فتم تجاهلها.'],
  ['backchannelsIgnored', 'كلمات موافقة', 'كلمات مثل «اها» و«ايه» أثناء كلام مُجيب لم تُعتبر مقاطعة.'],
  ['sttReconnects', 'إعادة اتصال STT', 'عدد مرات إعادة الاتصال بخدمة التفريغ بعد انقطاع.'],
  ['staleChunksDropped', 'صوت قديم مرفوض', 'أجزاء صوت وصلت من رد ملغى ورفضها المحرك قبل أن تصل لك.'],
  ['framesIn', 'إطارات صوت مستلمة', 'عدد إطارات المايك (20ms) التي استلمها المحرك.'],
  ['framesDroppedNoStt', 'دفعات بلا STT', 'دفعات صوت لم تُرسل لأن اتصال STT لم يكن جاهزًا.'],
];

const MARK_LOG = {
  user_speech_start: ['MIC', 'بدأ كلام المتصل (VAD)'],
  user_speech_end: ['MIC', 'انتهى كلام المتصل (VAD)'],
  stt_first_partial: ['STT', 'أول نص جزئي'],
  stt_committed: ['STT', 'النص النهائي جاهز'],
  llm_request: ['LLM', 'إرسال الطلب للنموذج'],
  llm_first_token: ['LLM', 'أول جزء من الرد'],
  llm_done: ['LLM', 'اكتمل الرد'],
  tts_first_text: ['TTS', 'أول مقطع نص إلى TTS'],
  tts_first_audio: ['TTS', 'أول صوت من TTS'],
  tts_done: ['TTS', 'اكتمل توليد الصوت'],
  playback_start: ['PLAY', 'بدأ التشغيل في المتصفح'],
  playback_end: ['PLAY', 'انتهى التشغيل'],
  barge_in_speech_start: ['BARGE', 'كلام أثناء حديث مُجيب (VAD)'],
  barge_in_candidate: ['BARGE', 'إيقاف مؤقت: مرشح مقاطعة'],
  interrupt_requested: ['BARGE', 'قرار المقاطعة'],
  playback_stopped: ['PLAY', 'توقف التشغيل (تأكيد المتصفح)'],
  error: ['ERROR', 'خطأ في الدور'],
};

const STATUS_TEXT = { off: 'متوقف', idle: 'في الانتظار', active: 'نشط', done: 'مكتمل', interrupted: 'قوطع', error: 'خطأ', muted: 'مكتوم', skip: 'غير مستخدم' };

const TABLE_COLUMNS = ['stt_finalize_ms', 'llm_ttft_ms', 'llm_total_ms', 'tools_ms', 'tts_ttfb_ms', 'first_audio_after_commit_ms', 'playback_buffer_ms', 'e2e_ms', 'barge_in_reaction_ms', 'interrupt_stop_ms'];

// ───────────────────────────── state ─────────────────────────────

let call = null;
const summaries = []; // engine turn summaries, in order
const live = {
  turns: new Map(), // turnId → { id, kind, marks, summary }
  pending: {}, // marks recorded before a turn exists (caller speaking)
  latestTurnId: null,
  state: 'idle',
  offset: Infinity, // client clock − engine clock (ms), min over events
  rtt: null,
  micDb: -Infinity,
  lastVoiceAt: 0,
  levels: new Array(120).fill(-90),
  counters: null,
};
const agentLines = new Map();
const toolLines = new Map(); // `${turnId}:${callId}` → transcript line
/** Tool outcomes that mean "worked as intended" (everything else is shown as a warning). */
const TOOL_OK = new Set(['ok', 'verified', 'confirmation_required', 'done']);
let metricMode = 'current';
let openHelp = null;
const eventLog = [];

// ───────────────────────────── call lifecycle ─────────────────────────────

ui.start.addEventListener('click', () => {
  start().catch((err) => {
    addError('error', 'start_failed', err.message);
    stop();
  });
});
ui.stop.addEventListener('click', () => stop());
ui.mute.addEventListener('click', () => {
  if (!call) return;
  call.muted = !call.muted;
  ui.mute.setAttribute('aria-pressed', String(call.muted));
  ui.mute.textContent = call.muted ? 'إلغاء الكتم' : 'كتم المايك';
  logEvent('MIC', call.muted ? 'تم كتم المايك (يُرسل صمت)' : 'أُلغي كتم المايك');
});
ui.volume.addEventListener('input', () => {
  if (call) call.gain.gain.value = Number(ui.volume.value);
});

async function start() {
  ui.start.disabled = true;
  resetSessionView();
  setConn('connecting', 'يتصل…');
  const constraints = { echoCancellation: ui.aec.checked, noiseSuppression: ui.ns.checked, autoGainControl: ui.agc.checked };
  const route = ui.route.value;

  let ctx;
  try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }); }
  catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
  await ctx.audioWorklet.addModule('/capture-worklet.js');
  await ctx.audioWorklet.addModule('/player-worklet.js');

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, channelCount: 1 } });
  const applied = stream.getAudioTracks()[0].getSettings();
  ui.audioInfo.textContent = `context ${ctx.sampleRate}Hz · AEC=${applied.echoCancellation} NS=${applied.noiseSuppression} AGC=${applied.autoGainControl} · route=${route}`;

  const source = ctx.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(ctx, 'capture-processor', { processorOptions: { targetRate: SAMPLE_RATE } });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(capture).connect(mute).connect(ctx.destination); // keep the capture node pulled

  const player = new AudioWorkletNode(ctx, 'player-processor', { processorOptions: { inputRate: SAMPLE_RATE }, outputChannelCount: [1] });
  const gain = ctx.createGain();
  gain.gain.value = Number(ui.volume.value);
  player.connect(gain);
  let loopback = null;
  if (route === 'webrtc-loopback') {
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    loopback = await createLoopback(dest.stream);
    ui.loopbackAudio.srcObject = loopback.remoteStream;
    await ui.loopbackAudio.play();
  } else {
    gain.connect(ctx.destination);
  }

  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  call = { ctx, stream, ws, player, capture, gain, loopback, muted: false };
  setAudioControlsLocked(true);

  ws.onopen = () => {
    send({ type: 'hello', userAgent: navigator.userAgent, playbackRoute: route, contextSampleRate: ctx.sampleRate,
      audioConstraints: { echoCancellation: !!applied.echoCancellation, noiseSuppression: !!applied.noiseSuppression, autoGainControl: !!applied.autoGainControl } });
    setConn('on', 'متصل');
    ui.stop.disabled = false;
    ui.mute.disabled = false;
  };
  ws.onclose = (e) => {
    addError('warning', 'connection_closed', `الاتصال أُغلق (${e.code}${e.reason ? `: ${e.reason}` : ''})`);
    setState('closed');
    setConn('off', 'غير متصل');
    stop();
  };
  ws.onerror = () => {
    setConn('error', 'خطأ في الاتصال');
    addError('error', 'websocket_error', 'تعذّر الاتصال بالمحرك المحلي');
  };
  ws.onmessage = (e) => onServerMessage(e.data);

  capture.port.onmessage = (e) => {
    const buffer = e.data;
    trackLevel(buffer);
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(call && call.muted ? new ArrayBuffer(buffer.byteLength) : buffer); // muted: keep timing, send silence
  };
  player.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'mark') send({ type: 'mark', name: m.name });
    else if (m.type === 'started') {
      send({ type: 'playback_started', epoch: m.epoch });
      logEvent('PLAY', `المتصفح بدأ تشغيل الصوت (epoch ${m.epoch})`);
    } else if (m.type === 'cleared') {
      send({ type: 'playback_cleared', epoch: m.epoch });
      logEvent('PLAY', `المتصفح فرّغ الصوت المخزن (epoch ${m.epoch})`);
    }
  };
}

function stop() {
  if (!call) {
    ui.start.disabled = false;
    ui.stop.disabled = true;
    ui.mute.disabled = true;
    setAudioControlsLocked(false);
    return;
  }
  const { ctx, stream, ws, loopback } = call;
  call = null;
  try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'user_stop'); } catch { /* ignore */ }
  stream.getTracks().forEach((t) => t.stop());
  if (loopback) loopback.close();
  ui.loopbackAudio.srcObject = null;
  ctx.close();
  ui.start.disabled = false;
  ui.stop.disabled = true;
  ui.mute.disabled = true;
  ui.mute.setAttribute('aria-pressed', 'false');
  ui.mute.textContent = 'كتم المايك';
  ui.micLevel.style.width = '0%';
  ui.micDb.textContent = '–';
  setAudioControlsLocked(false);
  if (live.state !== 'closed') setState('idle');
  setConn('off', 'غير متصل');
  renderPipeline();
}

function send(message) {
  if (call && call.ws.readyState === WebSocket.OPEN) call.ws.send(JSON.stringify(message));
}

// ───────────────────────────── server messages ─────────────────────────────

function onServerMessage(data) {
  if (data instanceof ArrayBuffer) {
    const epoch = new DataView(data).getUint32(0, true);
    const pcm = data.slice(4);
    call?.player.port.postMessage({ type: 'audio', epoch, buffer: pcm }, [pcm]);
    return;
  }
  const msg = JSON.parse(data);
  switch (msg.type) {
    case 'session_started':
      ui.notice.textContent = msg.notice;
      renderSessionInfo(msg);
      logEvent('SYS', `جلسة ${msg.sessionId} · stt=${msg.providers.stt} llm=${msg.providers.llm} tts=${msg.providers.tts}`);
      break;
    case 'mark':
      call?.player.port.postMessage({ type: 'mark', epoch: Number(msg.name.split(':')[0]), name: msg.name });
      break;
    case 'clear':
      call?.player.port.postMessage({ type: 'clear', epoch: msg.epoch });
      break;
    case 'pause':
    case 'resume':
      call?.player.port.postMessage({ type: msg.type });
      break;
    case 'ping':
      send({ type: 'pong', id: msg.id });
      break;
    case 'event':
      onSessionEvent(msg.event);
      break;
    case 'error':
      addError('error', 'server_error', msg.message);
      break;
  }
}

function onSessionEvent(ev) {
  switch (ev.type) {
    case 'state':
      setState(ev.state);
      logEvent('STATE', `الحالة: ${ev.state}`);
      break;
    case 'stt_ready':
      ui.sttConfig.textContent = JSON.stringify(ev.effective, null, 2);
      logEvent('STT', 'اتصال STT جاهز');
      break;
    case 'timeline':
      onTimeline(ev);
      break;
    case 'transport':
      live.rtt = ev.rttMs;
      break;
    case 'pending_reset':
      live.pending = {};
      logEvent('SYS', 'تم تجاهل علامات كلام لم يصبح دورًا (صدى أو ضوضاء)');
      break;
    case 'user_partial':
      showPartial(ev.text);
      logEvent('STT', `نص جزئي: «${ev.text}»`);
      break;
    case 'user_committed':
      adoptPending(ev.turnId, 'user');
      hidePartial();
      addBubble('user', ev.text);
      logEvent('STT', `المتصل: «${ev.text}»`);
      break;
    case 'assistant_segment': {
      ensureTurn(ev.turnId);
      let li = agentLines.get(ev.turnId);
      if (!li) {
        li = addBubble('agent', '');
        agentLines.set(ev.turnId, li);
      }
      const body = li.querySelector('.body');
      body.textContent = body.textContent ? `${body.textContent} ${ev.text}` : ev.text;
      scrollChat();
      break;
    }
    case 'barge_in': {
      const text = ev.text ? ` «${ev.text}»` : '';
      logEvent('BARGE', `${ev.action} (${ev.reason})${text}`);
      if (ev.action === 'interrupt') agentLines.get(ev.turnId)?.classList.add('interrupted');
      break;
    }
    case 'tool':
      onTool(ev);
      break;
    case 'turn_summary':
      onSummary(ev.summary);
      break;
    case 'counters':
      live.counters = ev.counters;
      renderCounters();
      break;
    case 'warning':
      addError('warning', ev.code, ev.message);
      break;
    case 'error':
      addError('error', ev.code, ev.message);
      break;
  }
  renderPipeline();
}

function onTool(ev) {
  const key = `${ev.turnId}:${ev.callId}`;
  if (ev.phase === 'start') {
    toolLines.set(key, addToolLine(ev.name));
    logEvent('TOOL', `بدأت الأداة ${ltr(ev.name)}`);
    return;
  }
  const li = toolLines.get(key) ?? addToolLine(ev.name);
  li.classList.remove('running');
  li.classList.add(TOOL_OK.has(ev.outcome) ? 'ok' : 'warn');
  li.querySelector('.body').textContent = ltr(`${ev.name} → ${ev.outcome} · ${Math.round(ev.ms)} ms`);
  logEvent('TOOL', `${ltr(ev.name)} → ${ltr(ev.outcome)} · ${ltr(`${Math.round(ev.ms)} ms`)}`);
}

// ───────────────────────────── live timeline ─────────────────────────────

function onTimeline(ev) {
  live.offset = Math.min(live.offset, performance.now() - ev.t);
  const marks = ev.turnId === null ? live.pending : ensureTurn(ev.turnId).marks;
  marks[ev.mark] = ev.t;
  const entry = MARK_LOG[ev.mark];
  if (entry) {
    const origin = Math.min(...Object.values(marks));
    logEvent(entry[0], `${entry[1]} · ${ltr(`+${Math.round(ev.t - origin)} ms`)}`);
  }
}

function ensureTurn(id) {
  let turn = live.turns.get(id);
  if (!turn) {
    turn = { id, kind: null, marks: {}, summary: null };
    live.turns.set(id, turn);
  }
  live.latestTurnId = id;
  return turn;
}

function adoptPending(turnId, kind) {
  const turn = ensureTurn(turnId);
  turn.kind = kind;
  turn.marks = { ...live.pending, ...turn.marks };
  live.pending = {};
}

function serverNow() {
  return Number.isFinite(live.offset) ? performance.now() - live.offset : null;
}

/** Which marks the pipeline shows: a forming user turn while the caller talks, else the latest turn. */
function displayTurn() {
  const pendingActive = Object.keys(live.pending).length > 0 && (live.state === 'listening' || live.state === 'idle');
  if (pendingActive) return { id: null, kind: 'user', marks: live.pending, summary: null, forming: true };
  return live.latestTurnId ? live.turns.get(live.latestTurnId) : null;
}

function durationsOf(turn) {
  if (!turn) return {};
  if (turn.summary) return turn.summary.durations_ms; // authoritative engine values
  const out = {};
  for (const [key, [from, to]] of Object.entries(SPANS)) {
    const a = turn.marks[from];
    const b = turn.marks[to];
    if (a !== undefined && b !== undefined) out[key] = Math.round((b - a) * 10) / 10;
  }
  return out;
}

// ───────────────────────────── pipeline ─────────────────────────────

function renderPipeline() {
  const turn = displayTurn();
  const m = turn?.marks ?? {};
  const d = durationsOf(turn);
  const now = serverNow();
  const since = (mark) => (m[mark] !== undefined && now !== null ? now - m[mark] : null);
  const greeting = turn?.kind === 'greeting' || (turn && !turn.forming && turn.kind === null && m.llm_request === undefined && m.tts_first_text !== undefined);
  const failed = turn?.summary?.outcome === 'error' || m.error !== undefined;
  const connected = call && call.ws.readyState === WebSocket.OPEN;

  const view = {};
  if (!call) view.mic = ['off', null, 'المايك غير مفعّل'];
  else if (call.muted) view.mic = ['muted', null, 'يُرسل صمتًا'];
  else view.mic = [performance.now() - live.lastVoiceAt < 300 ? 'active' : 'idle', null, Number.isFinite(live.micDb) ? ltr(`${Math.round(live.micDb)} dBFS`) : ''];

  view.transport = !call ? ['off', null, 'لا يوجد اتصال'] : connected ? ['active', live.rtt, 'RTT ذهاب وعودة'] : ['error', null, 'الاتصال غير متاح'];

  if (m.stt_committed !== undefined) view.stt = ['done', d.stt_finalize_ms ?? null, 'إنهاء التفريغ' + (m.user_speech_end === undefined ? ' (لا توجد نهاية كلام من VAD)' : '')];
  else if (m.stt_first_partial !== undefined || m.user_speech_start !== undefined) view.stt = ['active', since(m.user_speech_start !== undefined ? 'user_speech_start' : 'stt_first_partial'), 'منذ بدء الكلام'];
  else view.stt = [call ? 'idle' : 'off', null, ''];

  if (greeting) view.llm = ['skip', null, 'التحية نص ثابت'];
  else if (m.llm_done !== undefined) view.llm = ['done', d.llm_ttft_ms ?? null, `أول جزء · الكامل ${fmtMs(d.llm_total_ms)}`];
  else if (m.llm_first_token !== undefined) view.llm = [failed ? 'error' : 'active', d.llm_ttft_ms ?? null, 'أول جزء · يتدفق الرد'];
  else if (m.llm_request !== undefined) view.llm = [failed ? 'error' : 'active', since('llm_request'), 'بانتظار أول جزء'];
  else view.llm = [call ? 'idle' : 'off', null, ''];

  if (m.tts_done !== undefined) view.tts = ['done', d.tts_ttfb_ms ?? null, `أول صوت · المدة ${fmtMs(m.tts_done - m.tts_first_text)}`];
  else if (m.tts_first_audio !== undefined) view.tts = [m.interrupt_requested !== undefined ? 'interrupted' : 'active', d.tts_ttfb_ms ?? null, 'أول صوت · يتدفق الصوت'];
  else if (m.tts_first_text !== undefined) view.tts = [failed ? 'error' : 'active', since('tts_first_text'), 'بانتظار أول صوت'];
  else view.tts = [call ? 'idle' : 'off', null, ''];

  if (m.interrupt_requested !== undefined) view.playback = ['interrupted', d.interrupt_stop_ms ?? null, 'زمن إيقاف التشغيل'];
  else if (m.playback_end !== undefined) view.playback = ['done', d.playback_buffer_ms ?? null, 'من الاستلام للتشغيل'];
  else if (m.playback_start !== undefined) view.playback = ['active', d.playback_buffer_ms ?? null, 'من الاستلام للتشغيل'];
  else view.playback = [call ? 'idle' : 'off', null, ''];

  const items = [...ui.pipeline.children];
  items.forEach((li, i) => {
    const [rawStatus, value, note] = view[li.dataset.stage];
    const status = !call && rawStatus === 'active' ? 'off' : rawStatus; // nothing is running without a call
    li.dataset.status = status;
    li.querySelector('.stage-status').textContent = STATUS_TEXT[status];
    li.querySelector('.stage-value').textContent = value === null || value === undefined ? 'N/A' : `${Math.round(value)} ms`;
    li.querySelector('.stage-note').textContent = note;
    const next = items[i + 1];
    li.classList.toggle('flow', status === 'active' && next !== undefined && view[next.dataset.stage][0] === 'active' && call !== null);
  });
  ui.pipeTurn.textContent = turn ? (turn.forming ? 'دور جديد قيد التكوين' : `${turn.kind === 'greeting' || greeting ? 'تحية' : 'دور'} · ${turn.summary ? turn.summary.outcome : 'جارٍ'}`) : '';
  renderGantt(turn, now);
  renderMetrics();
}

const GANTT_ROWS = [
  ['كلام المتصل', 'user_speech_start', ['user_speech_end'], null, 'var(--accent)'],
  ['STT', 'user_speech_start', ['stt_committed'], 'stt_first_partial', 'var(--blue)'],
  ['LLM', 'llm_request', ['llm_done'], 'llm_first_token', 'var(--purple)'],
  ['TTS', 'tts_first_text', ['tts_done'], 'tts_first_audio', 'var(--violet)'],
  ['التشغيل', 'playback_start', ['playback_end', 'playback_stopped'], null, 'var(--teal)'],
];

function renderGantt(turn, now) {
  const g = ui.gantt;
  g.textContent = '';
  const m = turn?.marks ?? {};
  const times = Object.values(m);
  if (times.length === 0) {
    g.append(el('span', 'none', 'لا توجد بيانات زمنية للدور بعد. ستظهر هنا مراحل الدور وتداخلها لحظة بلحظة.'));
    return;
  }
  const finished = turn.summary !== null && turn.summary !== undefined;
  const t0 = Math.min(...times);
  const tEnd = Math.max(...times, finished || now === null ? -Infinity : now);
  const span = Math.max(1, tEnd - t0);
  const pct = (t) => `${((t - t0) / span) * 100}%`;
  for (const [label, from, ends, tick, color] of GANTT_ROWS) {
    g.append(el('span', 'lbl', label));
    const track = el('span', 'track');
    let a = m[from];
    if (label === 'STT' && a === undefined) a = m.stt_first_partial;
    if (a !== undefined) {
      const end = ends.map((k) => m[k]).find((v) => v !== undefined);
      const b = end ?? (finished || now === null ? (m.interrupt_requested ?? tEnd) : now);
      const bar = el('span', end === undefined ? 'bar open' : 'bar');
      bar.style.left = pct(a);
      bar.style.width = `${(Math.max(0, b - a) / span) * 100}%`;
      bar.style.background = color;
      bar.title = `${label}: ${Math.round(b - a)} ms${end === undefined ? ' (جارٍ)' : ''}`;
      track.append(bar);
      if (tick && m[tick] !== undefined) {
        const t = el('span', 'tick');
        t.style.left = pct(m[tick]);
        t.title = `${tick}: +${Math.round(m[tick] - t0)} ms`;
        track.append(t);
      }
    }
    if (m.interrupt_requested !== undefined) {
      const cut = el('span', 'cut');
      cut.style.left = pct(m.interrupt_requested);
      cut.title = 'قرار المقاطعة';
      track.append(cut);
    }
    g.append(track);
  }
  const axis = el('span', 'axis');
  axis.append(el('span', '', '0 ms'), el('span', '', `${Math.round(span)} ms`));
  g.append(axis);
}

// ───────────────────────────── metrics & counters ─────────────────────────────

document.querySelectorAll('.seg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    metricMode = btn.dataset.mode;
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderMetrics();
  });
});

function buildMetricCards() {
  for (const def of METRICS) {
    const card = el('div', def.primary ? 'metric primary' : 'metric');
    card.dataset.key = def.key;
    const top = el('div', 'metric-top');
    top.append(el('span', 'metric-label', def.label), infoButton(def.key, def.label, def.info, def.formula, 'ms'));
    const value = el('span', 'metric-value num');
    value.dataset.role = 'value';
    card.append(top, value, el('span', 'metric-sub'));
    ui.metrics.append(card);
  }
}

function renderMetrics() {
  const current = durationsOf(displayTurn());
  for (const card of ui.metrics.children) {
    const key = card.dataset.key;
    let value;
    let sub;
    if (metricMode === 'median') {
      const values = summaries.map((s) => (key === 'transport_rtt_ms' ? s.transport_rtt_ms : s.durations_ms[key])).filter((v) => typeof v === 'number');
      value = median(values);
      sub = `Median · n=${values.length}`;
    } else {
      value = key === 'transport_rtt_ms' ? live.rtt : current[key];
      sub = key === 'transport_rtt_ms' ? 'آخر قياس' : 'الدور الحالي';
    }
    const valueEl = card.querySelector('[data-role="value"]');
    valueEl.textContent = '';
    if (typeof value === 'number') {
      valueEl.append(document.createTextNode(String(Math.round(value))), el('small', '', ' ms'));
    } else {
      valueEl.textContent = 'N/A';
    }
    card.querySelector('.metric-sub').textContent = sub;
  }
}

function renderCounters() {
  ui.counters.textContent = '';
  for (const [key, label, info] of COUNTERS) {
    const row = el('div');
    const dt = el('dt');
    dt.append(document.createTextNode(label), infoButton(`counter:${key}`, label, info, key, 'عدد'));
    const value = live.counters ? live.counters[key] : undefined;
    row.append(dt, el('dd', 'num', value === undefined ? 'N/A' : String(value)));
    ui.counters.append(row);
  }
}

function infoButton(id, title, text, formula, unit) {
  const btn = el('button', 'info', 'i');
  btn.type = 'button';
  btn.setAttribute('aria-label', `معلومات: ${title}`);
  btn.setAttribute('aria-expanded', String(openHelp === id));
  btn.addEventListener('click', () => {
    const closing = openHelp === id;
    document.querySelectorAll('.info[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (closing) {
      openHelp = null;
      ui.metricHelp.hidden = true;
      return;
    }
    openHelp = id;
    btn.setAttribute('aria-expanded', 'true');
    ui.metricHelp.textContent = '';
    const code = el('code', '', formula);
    const how = el('div');
    how.append(document.createTextNode('طريقة الحساب: '), code, document.createTextNode(` · الوحدة: ${unit}`));
    ui.metricHelp.append(el('b', '', title), el('div', '', text), how);
    ui.metricHelp.hidden = false;
  });
  return btn;
}

// ───────────────────────────── summaries / timing table ─────────────────────────────

function onSummary(summary) {
  const turn = ensureTurn(summary.turn_id);
  turn.summary = summary;
  turn.kind = summary.kind;
  summaries.push(summary);
  addTimingRow(summary);
  renderMedians();
  if (summary.error) addError('error', `turn_${summary.error.error_kind ?? summary.error.error_name}`, summary.error.message, summary.error);
}

function addTimingRow(summary) {
  const index = summaries.length;
  const tr = el('tr', 'row');
  const cells = [index, summary.kind, summary.outcome, ...TABLE_COLUMNS.map((k) => fmt(summary.durations_ms[k])), fmt(summary.transport_rtt_ms)];
  cells.forEach((value, i) => {
    const td = el('td', i === 2 ? summary.outcome : '', String(value));
    tr.append(td);
  });
  tr.title = 'اضغط لعرض تفاصيل الدور';
  tr.addEventListener('click', () => toggleDetail(tr, summary));
  ui.timings.append(tr);
}

function toggleDetail(tr, summary) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) {
    next.remove();
    return;
  }
  const detail = el('tr', 'detail');
  const td = el('td');
  td.colSpan = 14;
  const info = {
    turn_id: summary.turn_id,
    reason: summary.reason ?? '–',
    assistant_chars_sent: summary.assistant_chars_sent,
    assistant_chars_heard: summary.assistant_chars_heard ?? '–',
    heard_text_estimated: summary.heard_text_estimated ?? '–',
    false_interruptions: summary.false_interruptions,
    user_chars: summary.user_chars,
    llm_rounds: summary.llm_rounds ?? '–',
    tool_calls: summary.tool_calls ?? '–',
    error: summary.error ?? '–',
    marks_ms: summary.marks_ms,
    durations_ms: summary.durations_ms,
  };
  td.append(el('pre', '', JSON.stringify(info, null, 2)));
  detail.append(td);
  tr.after(detail);
}

function renderMedians() {
  ui.medians.textContent = '';
  const tr = el('tr');
  const label = el('td', '', `median (${summaries.length} turns)`);
  label.colSpan = 3;
  tr.append(label);
  for (const key of [...TABLE_COLUMNS, 'transport_rtt_ms']) {
    const values = summaries.map((s) => (key === 'transport_rtt_ms' ? s.transport_rtt_ms : s.durations_ms[key])).filter((v) => typeof v === 'number');
    tr.append(el('td', '', values.length ? fmt(median(values)) : '–'));
  }
  ui.medians.append(tr);
}

ui.timingsToggle.addEventListener('click', () => {
  const open = ui.timingsToggle.getAttribute('aria-expanded') === 'true';
  ui.timingsToggle.setAttribute('aria-expanded', String(!open));
  ui.timingsBody.hidden = open;
});

ui.exportCsv.addEventListener('click', () => {
  const header = ['index', 'turn_id', 'kind', 'outcome', 'reason', ...TABLE_COLUMNS, 'transport_rtt_ms', 'false_interruptions', 'error_kind'];
  const rows = summaries.map((s, i) => [
    i + 1, s.turn_id, s.kind, s.outcome, s.reason ?? '',
    ...TABLE_COLUMNS.map((k) => s.durations_ms[k] ?? ''), s.transport_rtt_ms ?? '', s.false_interruptions, s.error?.error_kind ?? '',
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = el('a');
  a.href = url;
  a.download = `mujeeb-turns-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ───────────────────────────── events & errors ─────────────────────────────

function logEvent(tag, text) {
  const entry = { time: clock(), tag, text };
  eventLog.push(entry);
  if (eventLog.length > 500) eventLog.shift();
  if (ui.eventFilter.value !== 'all' && ui.eventFilter.value !== tag) return;
  appendEvent(entry);
}

function appendEvent(entry) {
  const nearBottom = ui.events.scrollHeight - ui.events.scrollTop - ui.events.clientHeight < 40;
  const li = el('li');
  const tag = el('span', 'tag', entry.tag);
  tag.dataset.tag = entry.tag;
  li.append(el('span', 't num', entry.time), tag, el('span', 'msg', entry.text));
  ui.events.append(li);
  while (ui.events.children.length > 500) ui.events.firstElementChild.remove();
  if (nearBottom) ui.events.scrollTop = ui.events.scrollHeight;
}

ui.eventFilter.addEventListener('change', () => {
  ui.events.textContent = '';
  for (const entry of eventLog) if (ui.eventFilter.value === 'all' || ui.eventFilter.value === entry.tag) appendEvent(entry);
});
ui.clearEvents.addEventListener('click', () => {
  eventLog.length = 0;
  ui.events.textContent = '';
});

function addError(level, code, message, details) {
  const li = el('li');
  li.dataset.level = level;
  const line = el('div', 'line');
  line.append(el('span', 'lvl', level === 'error' ? 'خطأ' : 'تحذير'), el('span', 't num muted', clock()), el('span', 'short', `${code}: ${message}`));
  li.append(line);
  const full = details ? JSON.stringify(details, null, 2) : message;
  if (full.length > 90 || details) {
    const more = el('details');
    more.append(el('summary', '', 'التفاصيل التقنية'), el('pre', '', `${code}\n${full}`));
    li.append(more);
  }
  ui.errors.append(li);
  ui.errors.scrollTop = ui.errors.scrollHeight;
  logEvent('ERROR', `${code}: ${message}`);
}
ui.clearErrors.addEventListener('click', () => { ui.errors.textContent = ''; });

// ───────────────────────────── conversation ─────────────────────────────

function addBubble(kind, text) {
  ui.chatEmpty.hidden = true;
  const li = el('li', `bubble ${kind}`);
  if (kind === 'agent') li.append(el('span', 'who', 'مُجيب'));
  li.append(el('span', 'body', text), el('span', 'meta num', clock().slice(0, 8)));
  ui.transcript.append(li);
  scrollChat();
  return li;
}

function addToolLine(name) {
  ui.chatEmpty.hidden = true;
  const li = el('li', 'bubble tool running');
  li.append(el('span', 'who', 'أداة'), el('span', 'body', ltr(`${name} …`)), el('span', 'meta num', clock().slice(0, 8)));
  ui.transcript.append(li);
  scrollChat();
  return li;
}

function showPartial(text) {
  ui.chatEmpty.hidden = true;
  ui.partial.textContent = text;
  ui.partial.hidden = false;
  scrollChat();
}

function hidePartial() {
  ui.partial.hidden = true;
  ui.partial.textContent = '';
}

function scrollChat() {
  ui.chatScroll.scrollTop = ui.chatScroll.scrollHeight;
}

ui.clearChat.addEventListener('click', () => {
  ui.transcript.textContent = '';
  agentLines.clear();
  hidePartial();
  ui.chatEmpty.hidden = false;
});

// ───────────────────────────── session info / settings ─────────────────────────────

function renderSessionInfo(msg) {
  const rows = [
    ['session', msg.sessionId],
    ['providers', `stt=${msg.providers.stt} · llm=${msg.providers.llm} · tts=${msg.providers.tts}`],
    ['input', `${msg.inputFormat.encoding}@${msg.inputFormat.sampleRate}`],
    ['output', `${msg.outputFormat.encoding}@${msg.outputFormat.sampleRate}`],
    ...flatten(msg.config ?? {}),
  ];
  ui.sessionInfo.textContent = '';
  for (const [k, v] of rows) {
    const pair = el('div');
    pair.append(el('dt', '', k), el('dd', '', v === undefined || v === null ? 'N/A' : String(v)));
    ui.sessionInfo.append(pair);
  }
}

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push([key, v]);
  }
  return out;
}

function setAudioControlsLocked(locked) {
  for (const input of [ui.route, ui.aec, ui.ns, ui.agc]) input.disabled = locked;
}

ui.settingsToggle.addEventListener('click', () => {
  ui.settingsDetails.open = true;
  $('settings-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ───────────────────────────── status, level, rendering loop ─────────────────────────────

function setState(state) {
  live.state = state;
  ui.state.textContent = state;
  ui.state.dataset.state = state;
}

function setConn(status, text) {
  ui.connDot.dataset.conn = status;
  ui.connText.textContent = text;
}

function trackLevel(buffer) {
  const samples = new Int16Array(buffer);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const db = 20 * Math.log10(Math.sqrt(sum / samples.length) / 32768 + 1e-9);
  live.micDb = call && call.muted ? -Infinity : db;
  if (db > -50 && !(call && call.muted)) live.lastVoiceAt = performance.now();
  live.levels.push(call && call.muted ? -90 : db);
  live.levels.shift();
  ui.micLevel.style.width = `${Math.max(0, Math.min(100, ((db + 70) / 60) * 100))}%`;
}

function drawWave() {
  const canvas = ui.wave;
  const w = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const h = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = call ? '#14b8a6' : '#1e2a3e';
  const n = live.levels.length;
  const barW = w / n;
  for (let i = 0; i < n; i++) {
    const level = Math.max(0, Math.min(1, (live.levels[i] + 70) / 60));
    const bh = Math.max(1, level * h);
    g.fillRect(i * barW, (h - bh) / 2, Math.max(1, barW - 1), bh);
  }
}

let lastFrame = 0;
function loop(ts) {
  if (ts - lastFrame > 100) {
    lastFrame = ts;
    if (call) ui.micDb.textContent = Number.isFinite(live.micDb) ? `${Math.round(live.micDb)} dBFS` : '–';
    renderPipeline();
    drawWave();
  }
  requestAnimationFrame(loop);
}

// ───────────────────────────── helpers ─────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function fmt(value) {
  return typeof value === 'number' ? Math.round(value) : '–';
}

function fmtMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? ltr(`${Math.round(value)} ms`) : 'N/A';
}

/** Keep numbers + units left-to-right inside Arabic text. */
function ltr(text) {
  return `⁦${text}⁩`;
}

function clock() {
  const d = new Date();
  return `${d.toLocaleTimeString('en-GB')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function resetSessionView() {
  summaries.length = 0;
  live.turns.clear();
  live.pending = {};
  live.latestTurnId = null;
  live.offset = Infinity;
  live.rtt = null;
  live.counters = null;
  agentLines.clear();
  for (const node of [ui.transcript, ui.events, ui.errors, ui.timings, ui.medians]) node.textContent = '';
  eventLog.length = 0;
  hidePartial();
  ui.chatEmpty.hidden = false;
  ui.sttConfig.textContent = 'N/A';
  setState('connecting');
  renderCounters();
  renderMedians();
}

// Route playback through a local RTCPeerConnection pair so Chromium's echo canceller treats it as
// remote (far-end) audio. Chromium historically does not cancel plain Web Audio output.
async function createLoopback(stream) {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate); };
  pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate); };
  const remote = new Promise((resolve) => { pc2.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track])); });
  stream.getTracks().forEach((t) => pc1.addTrack(t, stream));
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);
  return { remoteStream: await remote, close: () => { pc1.close(); pc2.close(); } };
}

// ───────────────────────────── init ─────────────────────────────

buildMetricCards();
renderCounters();
renderMedians();
renderPipeline();
requestAnimationFrame(loop);
