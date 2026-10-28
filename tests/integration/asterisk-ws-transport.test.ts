import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { AsteriskWsTransport } from '../../src/adapters/telephony/asterisk/asterisk-ws-transport.js';
import { pcm16 } from '../../src/core/audio.js';
import { silentLogger } from '../../src/core/logger.js';
import type { TransportEvent } from '../../src/ports/audio-transport.js';
import { type FakeAsterisk, connectFakeAsterisk } from '../support/fake-asterisk.js';
import { delay, waitFor } from '../support/session-harness.js';

/** The Mujeeb side (an AudioTransport) and the Asterisk side (a scripted chan_websocket peer) of one call. */
interface Call {
  transport: AsteriskWsTransport;
  asterisk: FakeAsterisk;
  events: TransportEvent[];
}

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const wss of servers.splice(0)) {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

async function call(options: { autoAckMarks?: boolean; autoStatus?: boolean; start?: boolean; statusProbeMs?: number } = {}): Promise<Call> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: (p) => (p.has('media') ? 'media' : false) });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as { port: number }).port;
  const accepted = new Promise<WebSocket>((resolve) => wss.once('connection', (ws) => resolve(ws)));
  const asterisk = await connectFakeAsterisk(`ws://127.0.0.1:${port}/media`, options);
  const transport = new AsteriskWsTransport(await accepted, {
    format: pcm16(16000),
    log: silentLogger,
    tailFlushMs: 30,
    ...(options.statusProbeMs !== undefined ? { statusProbeMs: options.statusProbeMs } : {}),
  });
  const events: TransportEvent[] = [];
  transport.setHandler((e) => events.push(e));
  if (options.start !== false) {
    asterisk.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALLER: '0551234567', MUJEEB_CALL_ID: '1700.1' });
    await transport.callStarted();
  }
  return { transport, asterisk, events };
}

const bytes = (n: number) => new Uint8Array(n).fill(1);
const status = (queueLength = 0) => ({ event: 'STATUS', channel_id: 'ch-1', queue_length: queueLength, xon_level: 800, xoff_level: 900 });
const getStatusCount = (c: Call) => c.asterisk.commands().filter((x) => x === 'GET_STATUS').length;
const cleared = (c: Call) => c.events.flatMap((e) => (e.type === 'playback_cleared' ? [e.epoch] : []));

describe('AsteriskWsTransport (chan_websocket, JSON control)', () => {
  it('reports the call from MEDIA_START channel variables and answers on request', async () => {
    const c = await call({ start: false });
    c.asterisk.mediaStart({ MUJEEB_DID: '300', MUJEEB_CALLER: '0551234567', MUJEEB_CALL_ID: '1700.1' });
    await expect(c.transport.callStarted()).resolves.toEqual({ callId: '1700.1', dialed: '300', caller: '0551234567' });
    expect(c.asterisk.commands()).toEqual([]); // dialed with `n`: no answer until asked
    c.transport.answer();
    await waitFor(() => c.asterisk.commands().includes('ANSWER'), 1000, 'ANSWER');
  });

  it('refuses a call whose format or dialed number does not match the dialplan contract', async () => {
    const wrongFormat = await call({ start: false });
    wrongFormat.asterisk.mediaStart({ MUJEEB_DID: '300' }, { format: 'ulaw', optimal_frame_size: 160 });
    await expect(wrongFormat.transport.callStarted()).rejects.toThrow(/c\(slin16\)/);

    const noDid = await call({ start: false });
    noDid.asterisk.mediaStart({ MUJEEB_CALLER: '0551234567' });
    await expect(noDid.transport.callStarted()).rejects.toThrow(/MUJEEB_DID/);
  });

  it('sends whole frames, a start mark before the audio, and each mark only after its audio', async () => {
    const c = await call();
    c.transport.sendAudio(1, bytes(1000));
    c.transport.sendMark(1, '1:0');
    c.transport.sendAudio(1, bytes(300));
    c.transport.sendMark(1, '1:1'); // inside a partial frame: released after the padded tail
    await waitFor(() => c.asterisk.commands().includes('MARK_MEDIA:1:1'), 1000, 'last mark');

    expect(c.asterisk.received).toEqual([
      { kind: 'command', command: 'MARK_MEDIA', id: 'start:1' },
      { kind: 'audio', bytes: 640 },
      { kind: 'audio', bytes: 640 },
      { kind: 'command', command: 'MARK_MEDIA', id: '1:0' },
      { kind: 'audio', bytes: 640 }, // the last 20 bytes + silence
      { kind: 'command', command: 'MARK_MEDIA', id: '1:1' },
    ]);
  });

  it('turns MEDIA_MARK_PROCESSED into mark and playback_started events', async () => {
    const c = await call();
    c.asterisk.send({ event: 'MEDIA_MARK_PROCESSED', channel_id: 'ch-1', correlation_id: 'start:3' });
    c.asterisk.send({ event: 'MEDIA_MARK_PROCESSED', channel_id: 'ch-1', correlation_id: '3:0' });
    await waitFor(() => c.events.length === 2, 1000, 'events');
    expect(c.events).toEqual([
      { type: 'playback_started', epoch: 3 },
      { type: 'mark', name: '3:0' },
    ]);
  });

  it('holds audio and marks during MEDIA_XOFF and sends them in order after MEDIA_XON', async () => {
    const c = await call();
    c.asterisk.send({ event: 'MEDIA_XOFF', channel_id: 'ch-1' });
    await delay(30);
    c.transport.sendAudio(1, bytes(1280));
    c.transport.sendMark(1, '1:0');
    await delay(60);
    expect(c.asterisk.received).toEqual([]);

    c.asterisk.send({ event: 'MEDIA_XON', channel_id: 'ch-1' });
    await waitFor(() => c.asterisk.commands().includes('MARK_MEDIA:1:0'), 1000, 'mark after XON');
    expect(c.asterisk.received).toEqual([
      { kind: 'command', command: 'MARK_MEDIA', id: 'start:1' },
      { kind: 'audio', bytes: 1280 },
      { kind: 'command', command: 'MARK_MEDIA', id: '1:0' },
    ]);
  });

  it('clears with FLUSH_MEDIA + GET_STATUS, confirms only on STATUS, and drops late audio of the cleared epoch', async () => {
    const c = await call();
    c.transport.sendAudio(1, bytes(640 * 3));
    c.transport.clear(1);
    await waitFor(() => c.asterisk.commands().includes('GET_STATUS'), 1000, 'GET_STATUS');
    expect(c.asterisk.commands().slice(-2)).toEqual(['FLUSH_MEDIA', 'GET_STATUS']);
    await delay(30);
    expect(c.events.some((e) => e.type === 'playback_cleared')).toBe(false);

    c.asterisk.send({ event: 'STATUS', channel_id: 'ch-1', queue_length: 0, xon_level: 800 });
    await waitFor(() => c.events.some((e) => e.type === 'playback_cleared'), 1000, 'playback_cleared');
    expect(c.events).toContainEqual({ type: 'playback_cleared', epoch: 1 });

    const before = c.asterisk.received.length;
    c.transport.sendAudio(1, bytes(640)); // late chunk of the cleared epoch
    c.transport.sendAudio(2, bytes(640));
    await waitFor(() => c.asterisk.audioBytes() >= 640 * 4, 1000, 'epoch 2 audio');
    expect(c.asterisk.received.slice(before)).toEqual([
      { kind: 'command', command: 'MARK_MEDIA', id: 'start:2' },
      { kind: 'audio', bytes: 640 },
    ]);
  });

  describe('STATUS replies (no correlation ID: matched to GET_STATUS in send order)', () => {
    it('a queue probe answered before a flush does not confirm the flush', async () => {
      const c = await call({ statusProbeMs: 40 });
      await waitFor(() => getStatusCount(c) === 1, 1000, 'probe GET_STATUS');
      c.transport.sendAudio(1, bytes(640 * 3));
      c.transport.clear(1);
      await waitFor(() => getStatusCount(c) === 2, 1000, 'flush GET_STATUS');

      c.asterisk.send(status(3)); // the probe's reply, with audio still queued
      await delay(30);
      expect(cleared(c)).toEqual([]);
      c.asterisk.send(status(0)); // the flush's reply
      await waitFor(() => cleared(c).length === 1, 1000, 'playback_cleared');
      expect(cleared(c)).toEqual([1]);
    });

    it('a flush answered before a queue probe is confirmed by the first reply, and the probe by the second', async () => {
      const c = await call({ statusProbeMs: 60 });
      c.transport.clear(1);
      await waitFor(() => getStatusCount(c) === 2, 1000, 'flush then probe GET_STATUS');
      expect(c.asterisk.commands().slice(0, 2)).toEqual(['FLUSH_MEDIA', 'GET_STATUS']);

      c.asterisk.send(status(0));
      await waitFor(() => cleared(c).length === 1, 1000, 'playback_cleared');
      c.asterisk.send(status(0)); // the probe's reply: no second clear
      await delay(30);
      expect(cleared(c)).toEqual([1]);
    });

    it('confirms consecutive flushes in order, even when both replies arrive late', async () => {
      const c = await call();
      c.transport.sendAudio(1, bytes(640));
      c.transport.clear(1);
      c.transport.sendAudio(2, bytes(640));
      c.transport.clear(2);
      await waitFor(() => getStatusCount(c) === 2, 1000, 'two GET_STATUS');
      await delay(50);
      expect(cleared(c)).toEqual([]);

      c.asterisk.send(status(0));
      c.asterisk.send(status(0));
      await waitFor(() => cleared(c).length === 2, 1000, 'both cleared');
      expect(cleared(c)).toEqual([1, 2]);
    });

    it('does not report a flush that left audio queued, and stays in step for the next one', async () => {
      const c = await call();
      c.transport.clear(1);
      await waitFor(() => getStatusCount(c) === 1, 1000, 'GET_STATUS');
      c.asterisk.send(status(2));
      await delay(30);
      expect(cleared(c)).toEqual([]);

      c.transport.clear(2);
      await waitFor(() => getStatusCount(c) === 2, 1000, 'second GET_STATUS');
      c.asterisk.send(status(0));
      await waitFor(() => cleared(c).length === 1, 1000, 'second flush confirmed');
      expect(cleared(c)).toEqual([2]);
    });

    it('ignores a STATUS nobody asked for: it confirms nothing, and later flushes still match their replies', async () => {
      const c = await call();
      c.asterisk.send(status(0));
      await delay(30);
      c.transport.clear(1);
      await waitFor(() => getStatusCount(c) === 1, 1000, 'GET_STATUS');
      await delay(30);
      expect(cleared(c)).toEqual([]);
      c.asterisk.send(status(0));
      await waitFor(() => cleared(c).length === 1, 1000, 'flush confirmed');
      expect(cleared(c)).toEqual([1]);
    });

    it('reports nothing after the call is closed, whichever side closes it', async () => {
      const ours = await call();
      ours.transport.clear(1);
      await waitFor(() => getStatusCount(ours) === 1, 1000, 'GET_STATUS');
      ours.transport.close('done');
      try {
        ours.asterisk.send(status(0)); // a reply that arrives while the socket closes
      } catch {
        /* already closed */
      }
      await ours.asterisk.closed;
      await delay(30);
      expect(cleared(ours)).toEqual([]);

      const theirs = await call();
      theirs.transport.clear(1);
      await waitFor(() => getStatusCount(theirs) === 1, 1000, 'GET_STATUS');
      theirs.asterisk.ws.close(1000);
      await waitFor(() => theirs.events.some((e) => e.type === 'closed'), 1000, 'closed');
      expect(cleared(theirs)).toEqual([]);
    });

    it('keeps one probe outstanding at most when Asterisk does not answer, and stops probing on close', async () => {
      const c = await call({ statusProbeMs: 20 });
      await delay(150);
      expect(getStatusCount(c)).toBe(1);
      c.asterisk.send(status(0));
      await waitFor(() => getStatusCount(c) === 2, 1000, 'next probe after the reply');

      c.transport.close('done');
      await c.asterisk.closed;
      const after = getStatusCount(c);
      await delay(100);
      expect(getStatusCount(c)).toBe(after);
    });

    it('does not probe before MEDIA_START, or at all unless asked to', async () => {
      const probing = await call({ statusProbeMs: 20, start: false });
      await delay(80);
      expect(getStatusCount(probing)).toBe(0);

      const quiet = await call();
      await delay(80);
      expect(getStatusCount(quiet)).toBe(0);
    });
  });

  it('maps pause and resume to PAUSE_MEDIA and CONTINUE_MEDIA', async () => {
    const c = await call();
    c.transport.pause();
    c.transport.resume();
    await waitFor(() => c.asterisk.commands().length === 2, 1000, 'commands');
    expect(c.asterisk.commands()).toEqual(['PAUSE_MEDIA', 'CONTINUE_MEDIA']);
  });

  it('hangs up on close, and reports closed when Asterisk ends the call', async () => {
    const ours = await call();
    ours.transport.close('done');
    expect(await ours.asterisk.closed).toBe(1000);
    expect(ours.asterisk.commands()).toEqual(['HANGUP']);
    expect(ours.events.some((e) => e.type === 'closed')).toBe(false);

    const theirs = await call();
    theirs.asterisk.ws.close(1000);
    await waitFor(() => theirs.events.some((e) => e.type === 'closed'), 1000, 'closed');
  });

  it('delivers caller audio only after MEDIA_START and ignores malformed frames', async () => {
    const c = await call({ start: false });
    c.asterisk.sendAudio(bytes(640)); // before MEDIA_START: dropped
    c.asterisk.mediaStart({ MUJEEB_DID: '300' });
    await c.transport.callStarted();
    c.asterisk.sendAudio(bytes(641)); // odd length
    c.asterisk.send({ event: 42 });
    c.asterisk.sendAudio(bytes(640));
    await waitFor(() => c.events.some((e) => e.type === 'audio'), 1000, 'audio');
    await delay(30);
    expect(c.events.filter((e) => e.type === 'audio').map((e) => (e.type === 'audio' ? e.data.byteLength : 0))).toEqual([640]);
  });
});
