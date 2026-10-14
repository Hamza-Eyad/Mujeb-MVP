import { describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/config/settings.js';
import { ConfigError } from '../../src/core/errors.js';

const LIVE_ENV = {
  OPENAI_API_KEY: 'sk-test-secret',
  ELEVENLABS_API_KEY: 'el-test-secret',
  MUJEEB_LLM_MODEL: 'model-from-env',
  MUJEEB_STT_MODEL: 'stt-model-from-env',
  MUJEEB_TTS_MODEL: 'tts-model-from-env',
  MUJEEB_TTS_VOICE_ID: 'voice-from-env',
};

describe('loadSettings', () => {
  it('fails clearly when live providers lack keys/models, without echoing values', () => {
    let error: unknown;
    try {
      loadSettings({ MUJEEB_LLM_MODEL: '' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of ['OPENAI_API_KEY', 'MUJEEB_LLM_MODEL', 'ELEVENLABS_API_KEY', 'MUJEEB_STT_MODEL', 'MUJEEB_TTS_MODEL', 'MUJEEB_TTS_VOICE_ID']) {
      expect(message).toContain(name);
    }
  });

  it('never includes secret values in validation errors', () => {
    expect(() => loadSettings({ ...LIVE_ENV, MUJEEB_DEV_PORT: 'not-a-port' })).toThrow(ConfigError);
    try {
      loadSettings({ ...LIVE_ENV, MUJEEB_DEV_PORT: 'not-a-port' });
    } catch (e) {
      expect((e as Error).message).not.toContain('sk-test-secret');
      expect((e as Error).message).toContain('MUJEEB_DEV_PORT');
    }
  });

  it('accepts a complete live configuration and applies defaults', () => {
    const s = loadSettings(LIVE_ENV);
    expect(s.llm).toMatchObject({ provider: 'openai', model: 'model-from-env', firstTokenTimeoutMs: 8000 });
    expect(s.stt).toMatchObject({ provider: 'elevenlabs', commitStrategy: 'vad', languageCode: 'ar', vadSilenceSecs: 0.8 });
    expect(s.elevenlabs.zeroRetention).toBe(false);
    expect(s.dev).toEqual({ host: '127.0.0.1', port: 8787 });
  });

  it('forces fake providers without requiring keys', () => {
    const s = loadSettings({}, { forceFakeProviders: true });
    expect([s.llm.provider, s.stt.provider, s.tts.provider]).toEqual(['fake', 'fake', 'fake']);
  });

  it('parses booleans and rejects unsupported commit strategies', () => {
    const s = loadSettings({ ...LIVE_ENV, MUJEEB_ELEVENLABS_ZERO_RETENTION: 'true', MUJEEB_LOG_TRANSCRIPTS: 'false' });
    expect(s.elevenlabs.zeroRetention).toBe(true);
    expect(() => loadSettings({ ...LIVE_ENV, MUJEEB_STT_COMMIT_STRATEGY: 'manual' })).toThrow(/MUJEEB_STT_COMMIT_STRATEGY/);
  });

  it('refuses non-loopback dev hosts', () => {
    expect(() => loadSettings({ ...LIVE_ENV, MUJEEB_DEV_HOST: '0.0.0.0' })).toThrow(/loopback/);
  });
});
