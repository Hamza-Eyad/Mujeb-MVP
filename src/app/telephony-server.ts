import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { AsteriskWsTransport } from '../adapters/telephony/asterisk/asterisk-ws-transport.js';
import type { CallContext } from '../contracts/call-context.js';
import { pcm16 } from '../core/audio.js';
import { errorSummary } from '../core/errors.js';
import { newSessionId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import { maskPhone } from '../core/phone.js';
import type { VoiceSession } from '../voice/session.js';
import type { CallRouter } from './call-router.js';
import { type AgentRuntime, createVoiceSession } from './session-factory.js';

/**
 * Telephony gateway endpoint: Asterisk opens one WebSocket per call (chan_websocket, `per_call_config`)
 * and each becomes one VoiceSession. Binds to loopback only: Asterisk runs on the same host and is the
 * only thing exposed to the phone network.
 *
 * A call is turned away before it is answered when the credentials are wrong, the gateway is at capacity,
 * MEDIA_START does not arrive in time, or the dialed number has no route. It is answered only once its
 * session exists.
 */

export const TELEPHONY_MEDIA_PATH = '/media';
const SUBPROTOCOL = 'media';
/** Phone audio between Asterisk and Mujeeb: 16 kHz PCM (`c(slin16)` in the dialplan), as the engine uses. */
export const TELEPHONY_AUDIO_FORMAT = pcm16(16000);

export interface TelephonyServerOptions {
  host: string;
  port: number;
  /** What Asterisk sends as HTTP Basic auth (websocket_client.conf username/password). */
  credentials: { username: string; password: string };
  maxCalls: number;
  callStartTimeoutMs: number;
  /** Log each call's Asterisk playback queue length this often. 0 or absent: off. */
  statusProbeMs?: number;
  /** Log the gateway's health (calls, event-loop delay, memory) this often. 0 or absent: off. */
  healthLogMs?: number;
  router: CallRouter<AgentRuntime>;
  log: Logger;
}

export interface TelephonyServer {
  url: string;
  activeCalls(): number;
  close(): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 404: 'Not Found', 503: 'Service Unavailable' };

export async function startTelephonyServer(options: TelephonyServerOptions): Promise<TelephonyServer> {
  const sessions = new Set<VoiceSession>();
  /** Connections accepted and not yet closed, sessions or not: the capacity count. */
  let admitted = 0;
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
  const expectedAuth = digest(`${options.credentials.username}:${options.credentials.password}`);

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  const url = `ws://${options.host}:${address.port}${TELEPHONY_MEDIA_PATH}`;

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== TELEPHONY_MEDIA_PATH) return refuse(socket, 404, 'unknown_path');
    if (!authorized(req.headers.authorization, expectedAuth)) return refuse(socket, 401, 'unauthorized');
    if (admitted >= options.maxCalls) return refuse(socket, 503, 'at_capacity');
    admitted += 1;
    let upgraded = false;
    // A handshake that fails never reaches the callback: release its slot when the socket goes away.
    socket.once('close', () => {
      if (!upgraded) admitted -= 1;
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      ws.once('close', () => {
        admitted -= 1;
      });
      void handleCall(ws);
    });
  });

  function refuse(socket: Duplex, status: number, reason: string): void {
    options.log.warn('telephony.connection_refused', { reason, active_calls: admitted });
    socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n\r\n`);
  }

  async function handleCall(ws: WebSocket): Promise<void> {
    const sessionId = newSessionId();
    const log = options.log.child({ session_id: sessionId, component: 'telephony' });
    const transport = new AsteriskWsTransport(ws, {
      format: TELEPHONY_AUDIO_FORMAT,
      log: log.child({ component: 'transport' }),
      ...(options.statusProbeMs ? { statusProbeMs: options.statusProbeMs } : {}),
    });
    let call: CallContext;
    try {
      call = await withTimeout(transport.callStarted(), options.callStartTimeoutMs, 'MEDIA_START did not arrive');
    } catch (err) {
      log.warn('call.refused', { reason: 'no_call_start', message: errorSummary(err).message });
      transport.close('no_call_start');
      return;
    }
    const callLog = options.log.child({ call_id: call.callId });
    const runtime = options.router.resolve(call.dialed);
    if (runtime === undefined) {
      callLog.warn('call.refused', { reason: 'unknown_route', dialed: call.dialed });
      transport.close('unknown_route');
      return;
    }
    const startedAt = performance.now();
    callLog.info('call.start', {
      session_id: sessionId,
      dialed: call.dialed,
      caller: maskPhone(call.caller),
      tenant_id: runtime.profile.tenantId,
      agent_id: runtime.profile.agentId,
    });
    const session = createVoiceSession(runtime, { sessionId, channel: 'phone', callId: call.callId, transport, log: callLog });
    sessions.add(session);
    ws.once('close', (code) => {
      sessions.delete(session);
      callLog.info('call.end', { session_id: sessionId, ws_code: code, duration_ms: Math.round(performance.now() - startedAt) });
    });
    transport.answer();
    try {
      await session.start();
    } catch (err) {
      callLog.error('call.start_failed', errorSummary(err));
      sessions.delete(session);
      await session.close('start_failed');
    }
  }

  const stopHealthLog = options.healthLogMs ? startHealthLog(options.healthLogMs, options.log, () => ({ active_calls: admitted, sessions: sessions.size })) : () => undefined;

  return {
    url,
    activeCalls: () => admitted,
    close: async () => {
      stopHealthLog();
      await Promise.allSettled([...sessions].map((s) => s.close('server_shutdown')));
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/**
 * One `gateway.health` line per interval: calls, event-loop delay over the interval (a blocked loop delays
 * every call's audio), and memory. Returns the stop function.
 */
function startHealthLog(intervalMs: number, log: Logger, counts: () => Record<string, number>): () => void {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const ms = (ns: number): number => Math.round(ns / 1e5) / 10;
  const mb = (bytes: number): number => Math.round(bytes / 1e5) / 10;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    log.info('gateway.health', {
      ...counts(),
      event_loop_p50_ms: ms(loop.percentile(50)),
      event_loop_p99_ms: ms(loop.percentile(99)),
      event_loop_max_ms: ms(loop.max),
      rss_mb: mb(memory.rss),
      heap_used_mb: mb(memory.heapUsed),
    });
    loop.reset();
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    loop.disable();
  };
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** HTTP Basic credentials, compared in constant time. */
function authorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(Buffer.from(match[1], 'base64').toString('utf8')), expected);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
