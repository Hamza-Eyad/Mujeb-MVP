import WebSocket from 'ws';

/**
 * A scripted Asterisk chan_websocket peer (the side Asterisk plays in production): connects with HTTP Basic
 * auth and the `media` subprotocol, records what Mujeeb sends in arrival order, and sends events.
 */

export type Received = { kind: 'audio'; bytes: number } | { kind: 'command'; command: string; id?: string };

export interface FakeAsterisk {
  ws: WebSocket;
  /** Everything received, in arrival order. */
  received: Received[];
  commands(): string[];
  audioBytes(): number;
  send(event: Record<string, unknown>): void;
  sendAudio(bytes: Uint8Array): void;
  mediaStart(variables?: Record<string, string>, overrides?: Record<string, unknown>): void;
  closed: Promise<number>;
}

export interface FakeAsteriskOptions {
  username?: string;
  password?: string;
  /** Reply MEDIA_MARK_PROCESSED to every MARK_MEDIA at once (as if the audio played instantly). */
  autoAckMarks?: boolean;
  /** Reply STATUS (queue_length 0) to every GET_STATUS. */
  autoStatus?: boolean;
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export function connectFakeAsterisk(url: string, options: FakeAsteriskOptions = {}): Promise<FakeAsterisk> {
  const headers = options.username !== undefined ? { Authorization: basicAuth(options.username, options.password ?? '') } : undefined;
  const ws = new WebSocket(url, 'media', headers ? { headers } : {});
  const received: Received[] = [];
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const send = (event: Record<string, unknown>): void => ws.send(JSON.stringify(event));
  ws.on('message', (data, isBinary) => {
    const buf = data as Buffer;
    if (isBinary) {
      received.push({ kind: 'audio', bytes: buf.length });
      return;
    }
    const msg = JSON.parse(buf.toString()) as { command: string; correlation_id?: string };
    received.push({ kind: 'command', command: msg.command, ...(msg.correlation_id !== undefined ? { id: msg.correlation_id } : {}) });
    if (options.autoAckMarks && msg.command === 'MARK_MEDIA') send({ event: 'MEDIA_MARK_PROCESSED', channel_id: 'ch-1', correlation_id: msg.correlation_id });
    if (options.autoStatus && msg.command === 'GET_STATUS') send({ event: 'STATUS', channel_id: 'ch-1', queue_length: 0, xon_level: 800, xoff_level: 900 });
  });
  const fake: FakeAsterisk = {
    ws,
    received,
    commands: () => received.flatMap((r) => (r.kind === 'command' ? [r.id !== undefined ? `${r.command}:${r.id}` : r.command] : [])),
    audioBytes: () => received.reduce((sum, r) => sum + (r.kind === 'audio' ? r.bytes : 0), 0),
    send,
    sendAudio: (bytes) => ws.send(bytes, { binary: true }),
    mediaStart: (variables = {}, overrides = {}) =>
      send({
        event: 'MEDIA_START',
        connection_id: 'mujeeb',
        channel: 'WebSocket/mujeeb/0x1',
        channel_id: 'ch-1',
        format: 'slin16',
        optimal_frame_size: 640,
        ptime: 20,
        channel_variables: { MEDIA_WEBSOCKET_CONNECTION_ID: 'mujeeb', ...Object.fromEntries(Object.entries(variables).map(([k, v]) => [`__${k}`, v])) },
        ...overrides,
      }),
    closed,
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(fake));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode ?? 0}`)));
    ws.once('error', reject);
  });
}
