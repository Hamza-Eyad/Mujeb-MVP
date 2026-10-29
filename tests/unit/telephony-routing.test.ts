import { describe, expect, it } from 'vitest';
import { CallRouter, loadCallRoutes } from '../../src/app/call-router.js';
import { assertAnswerTimeoutCoversStt } from '../../src/app/container.js';
import { loadSettings } from '../../src/config/settings.js';
import { ConfigError } from '../../src/core/errors.js';
import { maskPhone } from '../../src/core/phone.js';

describe('call routing (dialed number → clinic)', () => {
  it('matches configured keys exactly and never guesses', () => {
    const router = new CallRouter([
      ['0112345678', 'clinic-a'],
      ['sip:clinic-b@pbx.example', 'clinic-b'],
    ]);
    expect(router.resolve('0112345678')).toBe('clinic-a');
    expect(router.resolve(' 0112345678 ')).toBe('clinic-a');
    expect(router.resolve('sip:clinic-b@pbx.example')).toBe('clinic-b');
    expect(router.resolve('+966112345678')).toBeUndefined(); // another written form is not assumed equal
    expect(router.resolve('999')).toBeUndefined();
  });

  it('rejects duplicate keys and an empty route table', () => {
    expect(() => new CallRouter([['300', 'a'], [' 300', 'b']])).toThrow(ConfigError);
    expect(() => new CallRouter([])).toThrow(ConfigError);
  });

  it('loads the shipped routes file', async () => {
    const file = await loadCallRoutes('config/telephony/routes.json');
    expect(file.routes.map((r) => r.key)).toContain('300');
  });

  it('refuses a routes file that does not match the schema', async () => {
    await expect(loadCallRoutes('package.json')).rejects.toThrow(/Invalid telephony routes/);
    await expect(loadCallRoutes('no-such-file.json')).rejects.toThrow(/Cannot read telephony routes/);
  });
});

describe('telephony settings', () => {
  const base = { MUJEEB_LLM_PROVIDER: 'fake', MUJEEB_STT_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake' };

  it('defaults to a loopback gateway with no credentials configured and no queue probing', () => {
    const s = loadSettings(base);
    expect(s.telephony).toEqual({
      host: '127.0.0.1',
      port: 8790,
      routesPath: 'config/telephony/routes.json',
      maxCalls: 5,
      username: 'asterisk',
      callStartTimeoutMs: 3000,
      answerTimeoutMs: 7000,
      statusProbeMs: 0,
      healthLogMs: 0,
    });
    expect(loadSettings({ ...base, MUJEEB_TELEPHONY_STATUS_PROBE_MS: '5000' }).telephony.statusProbeMs).toBe(5000);
  });

  it('answers only after STT connects: two 3s attempts and the pause fit in the 7s answer timeout', () => {
    const s = loadSettings(base);
    expect(s.stt.connectTimeoutMs).toBe(3000);
    expect(() => assertAnswerTimeoutCoversStt(s)).not.toThrow(); // 2 × 3000 + 250 = 6250 ≤ 7000
    expect(() => assertAnswerTimeoutCoversStt(loadSettings({ ...base, MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS: '6000' }))).toThrow(ConfigError);
    expect(() => assertAnswerTimeoutCoversStt(loadSettings({ ...base, MUJEEB_STT_CONNECT_TIMEOUT_MS: '4000' }))).toThrow(/at least 8250/);
  });

  it('refuses a non-loopback gateway address', () => {
    expect(() => loadSettings({ ...base, MUJEEB_TELEPHONY_HOST: '0.0.0.0' })).toThrow(/MUJEEB_TELEPHONY_HOST must be a loopback/);
  });
});

describe('phone numbers in logs', () => {
  it('keeps only the last three digits', () => {
    expect(maskPhone('0551234567')).toBe('•••••••567');
    expect(maskPhone('+966551234567')).toBe('•••••••••567');
    expect(maskPhone('٠٥٥١٢٣٤٥٦٧')).toBe('•••••••567');
    expect(maskPhone('12')).toBe('•••');
    expect(maskPhone(undefined)).toBeUndefined();
  });
});
