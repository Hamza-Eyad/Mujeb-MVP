import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { BrowserWsTransport } from '../adapters/transports/browser-ws-transport.js';
import type { AgentProfile } from '../contracts/agent-profile.js';
import { pcm16 } from '../core/audio.js';
import { errorSummary } from '../core/errors.js';
import { newSessionId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { TurnSummarySink } from '../observability/turn-metrics.js';
import type { LanguageModel } from '../ports/language-model.js';
import type { SchedulingSystem } from '../ports/scheduling.js';
import type { SpeechToText } from '../ports/speech-to-text.js';
import type { TextToSpeech } from '../ports/text-to-speech.js';
import type { VoiceSession, VoiceSessionConfig } from '../voice/session.js';
import { type AgentRuntime, createVoiceSession } from './session-factory.js';

/**
 * Local-only dev server: serves the browser test client and bridges each WebSocket to one
 * VoiceSession. Binds to loopback, checks Origin (so other websites cannot drive it and spend
 * provider credits), and caps concurrent sessions.
 */

const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/capture-worklet.js': 'capture-worklet.js',
  '/player-worklet.js': 'player-worklet.js',
  '/style.css': 'style.css',
};

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

export const DEV_AUDIO_SAMPLE_RATE = 16000;

export interface DevServerOptions {
  host: string;
  port: number;
  staticDir: string;
  maxSessions: number;
  profile: AgentProfile;
  providers: { stt: SpeechToText; llm: LanguageModel; tts: TextToSpeech };
  sessionConfig: VoiceSessionConfig;
  metrics: TurnSummarySink;
  log: Logger;
  /** Shown in the test UI's settings panel. Must not contain secrets (see describeSettings). */
  displayConfig?: Record<string, unknown>;
  /** Enables the appointment tools (requires `profile.appointmentTools`). */
  scheduling?: { system: SchedulingSystem; readTimeoutMs: number; writeTimeoutMs: number; confirmGraceMs: number };
}

export interface DevServer {
  url: string;
  activeSessions(): number;
  close(): Promise<void>;
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const sessions = new Set<VoiceSession>();
  const staticDir = resolve(options.staticDir);
  const server = createServer((req, res) => {
    void serveStatic(req, res, staticDir, sessions.size);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  const url = `http://${options.host}:${address.port}`;
  const allowedOrigins = new Set([url, `http://localhost:${address.port}`, `http://127.0.0.1:${address.port}`]);

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== '/ws' || origin === undefined || !allowedOrigins.has(origin)) {
      options.log.warn('dev_server.ws_rejected', { path: req.url, origin });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (sessions.size >= options.maxSessions) {
      options.log.warn('dev_server.too_many_sessions', { active: sessions.size });
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void startSession(ws);
    });
  });

  const runtime: AgentRuntime = {
    profile: options.profile,
    providers: options.providers,
    sessionConfig: options.sessionConfig,
    metrics: options.metrics,
    ...(options.scheduling ? { scheduling: options.scheduling } : {}),
  };

  async function startSession(ws: WebSocket): Promise<void> {
    const sessionId = newSessionId();
    const log = options.log.child({ session_id: sessionId });
    const transport = new BrowserWsTransport(ws, {
      inputFormat: pcm16(DEV_AUDIO_SAMPLE_RATE),
      outputFormat: pcm16(DEV_AUDIO_SAMPLE_RATE),
      log: log.child({ component: 'transport' }),
    });
    const { providers } = options;
    const session = createVoiceSession(runtime, {
      sessionId,
      channel: 'browser',
      transport,
      log: options.log,
      observer: (event) => transport.send({ type: 'event', event }),
    });
    sessions.add(session);
    ws.once('close', () => sessions.delete(session));
    transport.send({
      type: 'session_started',
      sessionId,
      inputFormat: transport.inputFormat,
      outputFormat: transport.outputFormat,
      providers: { stt: providers.stt.name, llm: providers.llm.name, tts: providers.tts.name },
      ...(options.displayConfig ? { config: options.displayConfig } : {}),
      notice: 'بيئة اختبار محلية — لا تستخدم بيانات مرضى حقيقية.',
    });
    try {
      await session.start();
    } catch (err) {
      const summary = errorSummary(err);
      log.error('session.start_failed', summary);
      transport.send({ type: 'error', message: `Session failed to start: ${summary.message}` });
      sessions.delete(session);
      await session.close('start_failed');
    }
  }

  return {
    url,
    activeSessions: () => sessions.size,
    close: async () => {
      await Promise.allSettled([...sessions].map((s) => s.close('server_shutdown')));
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string, activeSessions: number): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, activeSessions }));
    return;
  }
  const file = STATIC_FILES[path];
  if (file === undefined) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(join(staticDir, file));
    const ext = file.split('.').pop() ?? '';
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; style-src 'self'; script-src 'self'",
    });
    res.end(body);
  } catch {
    res.writeHead(500).end('static file missing');
  }
}
