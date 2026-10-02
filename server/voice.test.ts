import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_VOCABULARY,
  PROMPT_BUDGET,
  buildVoicePrompt,
  downsample,
  encodeWav,
  fmtElapsed,
  insertTranscript,
  isEmptyTranscript,
  level,
  wavSeconds,
  type VocabularySource,
} from '../shared/voice.ts';
import { VoiceService } from './voice.ts';
import { modelDir, requirementsHash, setupNeeded, voicePaths } from './voiceSetup.ts';
import type { Config, VoiceConfig } from './config.ts';

const empty: VocabularySource = { sandboxes: [], agentNames: [], machines: [], specs: [], extra: [] };

test('voice prompt: the fixed FF words come first, then names from the state', () => {
  const p = buildVoicePrompt({
    ...empty,
    sandboxes: [{ id: 'shader-blackhole' }, { id: 'tutorial-bugs' }],
    machines: ['m5', 'mini'],
    specs: ['068-mass-driver', '074-three-peer-full-playthrough', 'README.md', '101-new-thing'],
    agentNames: ['Voice input builder', 'Discord triage'],
  });
  assert.ok(p.startsWith('Final Factory, SketchUp Factory, orchestrator'), p);
  assert.ok(p.endsWith('.'));
  for (const w of ['shader-blackhole', 'tutorial-bugs', 'mini', 'spec 101', 'Voice input builder', 'lockstep']) assert.ok(p.includes(w), `${w} missing: ${p}`);
  // M5 is already in the fixed list (as "M5"): no duplicate "m5".
  assert.equal(p.match(/\bm5\b/gi)?.length, 1);
  // spec 068 and 074 are in the fixed list; the spec list adds the newest others, newest first.
  assert.ok(!p.includes('README'));
  assert.ok(p.length <= PROMPT_BUDGET);
});

test('voice prompt: extra config words lead, and a crowded state is cut to the budget in whole items', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `sandbox-number-${i}` }));
  const p = buildVoicePrompt({ ...empty, sandboxes: many, extra: ['Kyle', 'Relay'] });
  assert.ok(p.startsWith('Kyle, Relay. Final Factory'), p);
  assert.ok(p.length <= PROMPT_BUDGET, `${p.length}`);
  assert.ok(p.includes('sandbox-number-0'));
  assert.ok(!p.includes('sandbox-number-199'));
  // Never a half item.
  for (const item of p.replace(/\.$/, '').split(/[.,] /)) assert.ok(item.trim().length > 0);
  // With nothing dynamic it is exactly the fixed list.
  assert.equal(buildVoicePrompt(empty), CORE_VOCABULARY.join('. ') + '.');
});

test('wav: encodeWav writes a 16-bit mono PCM file that wavSeconds reads back', () => {
  const samples = new Float32Array(16000 * 2).map((_, i) => Math.sin(i / 10));
  const wav = encodeWav(samples);
  assert.equal(wav.length, 44 + samples.length * 2);
  assert.equal(wavSeconds(wav), 2);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  // Clipping instead of wrapping.
  const loud = encodeWav(new Float32Array([2, -2]));
  const v = new DataView(loud.buffer);
  assert.equal(v.getInt16(44, true), 0x7fff);
  assert.equal(v.getInt16(46, true), -0x8000);
  assert.equal(wavSeconds(new Uint8Array(20)), undefined);
  assert.equal(wavSeconds(new TextEncoder().encode('x'.repeat(100))), undefined);
});

test('wav: downsample 48 kHz to 16 kHz averages each group of three', () => {
  const src = new Float32Array([0, 0.3, 0.6, 1, 1, 1, -1, -1, -1]);
  const out = downsample(src, 48000);
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[0] - 0.3) < 1e-6);
  assert.equal(out[1], 1);
  assert.equal(out[2], -1);
  // 44.1 kHz: a non-integer ratio still gives the right length.
  assert.equal(downsample(new Float32Array(44100), 44100).length, 16000);
  assert.equal(downsample(src, 16000), src);
  assert.throws(() => downsample(src, 8000));
});

test('level: silence is 0, speech-level input is mid-scale, clipping is 1', () => {
  assert.equal(level(new Float32Array(128)), 0);
  assert.equal(level(new Uint8Array(128).fill(128)), 0);
  const speech = level(new Float32Array(1000).map((_, i) => 0.1 * Math.sin(i)));
  assert.ok(speech > 0.3 && speech < 0.8, `${speech}`);
  assert.equal(level(new Float32Array(10).fill(1)), 1);
  assert.equal(level(new Float32Array(0)), 0);
});

test('fmtElapsed', () => {
  assert.equal(fmtElapsed(0), '0:00');
  assert.equal(fmtElapsed(9_999), '0:09');
  assert.equal(fmtElapsed(75_000), '1:15');
  assert.equal(fmtElapsed(-5), '0:00');
});

test('insertTranscript: spaces where needed, replaces the selection, caret after the insert', () => {
  assert.deepEqual(insertTranscript('', 0, 0, ' Hello there. '), { text: 'Hello there.', caret: 12 });
  assert.deepEqual(insertTranscript('Fix it', 6, 6, 'now please.'), { text: 'Fix it now please.', caret: 18 });
  assert.deepEqual(insertTranscript('Fix it ', 7, 7, 'now'), { text: 'Fix it now', caret: 10 });
  // In the middle: a space on both sides.
  assert.deepEqual(insertTranscript('ab', 1, 1, 'X'), { text: 'a X b', caret: 3 });
  // Before punctuation: no trailing space.
  assert.deepEqual(insertTranscript('Hi.', 2, 2, 'there'), { text: 'Hi there.', caret: 8 });
  // A selection is replaced.
  assert.deepEqual(insertTranscript('say WRONG now', 4, 9, 'right'), { text: 'say right now', caret: 9 });
  // Out-of-range selection is clamped; an empty transcript changes nothing.
  assert.deepEqual(insertTranscript('abc', 99, 99, 'd'), { text: 'abc d', caret: 5 });
  assert.deepEqual(insertTranscript('abc', 1, 1, '  '), { text: 'abc', caret: 1 });
});

test('isEmptyTranscript: Whisper markers for silence count as nothing, words do not', () => {
  for (const t of ['', '  ', '[BLANK_AUDIO]', '(silence)', '[ Silence ]', '...']) assert.ok(isEmptyTranscript(t), t);
  for (const t of ['Thank you.', 'you', 'Start spec 068.']) assert.ok(!isEmptyTranscript(t), t);
});

// ---- the service, without a real install

function voiceCfg(over: Partial<VoiceConfig> = {}): { cfg: Config; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-voice-'));
  const voice: VoiceConfig = { enabled: true, toolsDir: path.join(dir, 'tools'), model: 'tiny.en', device: 'auto', language: 'en', idleMinutes: 20, cpuThreads: 4, autoInstall: false, keepAudio: false, vocabulary: [], tts: false, ttsVoice: 'af_heart', ttsDevice: 'auto', ...over };
  return { cfg: { dataDir: dir, voice } as Config, dir };
}

test('voice status: not installed, installed, turned off', async () => {
  const { cfg } = voiceCfg();
  const v = new VoiceService(cfg, () => '');
  assert.equal(v.status().state, 'unavailable');
  assert.match(v.status().detail ?? '', /not installed.*voice-setup/);
  await assert.rejects(v.transcribe(Buffer.from(encodeWav(new Float32Array(160)))), /unavailable/);

  // Fake an install: the venv's python, the model file, a stamp with the current requirements hash.
  const p = voicePaths(cfg.voice);
  fs.mkdirSync(path.dirname(p.python), { recursive: true });
  fs.writeFileSync(p.python, '');
  assert.equal(setupNeeded(cfg.voice), 'install incomplete');
  fs.writeFileSync(p.stamp, JSON.stringify({ requirements: requirementsHash(), model: 'tiny.en', at: '' }));
  assert.match(setupNeeded(cfg.voice) ?? '', /model tiny.en not downloaded/);
  fs.mkdirSync(modelDir(cfg.voice), { recursive: true });
  fs.writeFileSync(path.join(modelDir(cfg.voice), 'model.bin'), '');
  assert.equal(setupNeeded(cfg.voice), null);
  assert.equal(v.status().state, 'idle');

  // A different model in config means a new download; a changed requirements file means a reinstall.
  assert.match(setupNeeded({ ...cfg.voice, model: 'small.en' }) ?? '', /model small.en/);
  fs.writeFileSync(p.stamp, JSON.stringify({ requirements: 'old', model: 'tiny.en', at: '' }));
  assert.equal(setupNeeded(cfg.voice), 'requirements changed');

  // A running setup (fresh lock) shows as installing.
  fs.writeFileSync(p.lock, '1');
  assert.equal(v.status().state, 'installing');

  const off = new VoiceService(voiceCfg({ enabled: false }).cfg, () => '');
  assert.equal(off.status().state, 'unavailable');
  assert.match(off.status().detail ?? '', /voice.enabled/);
});

test('chooseEngine: auto prefers local Whisper, falls back to the browser, explains dead ends', async () => {
  const { chooseEngine } = await import('../shared/voice.ts');
  const all = { record: true, browser: true, secure: true };
  assert.deepEqual(chooseEngine('auto', { state: 'ready' }, all), { engine: 'whisper' });
  assert.deepEqual(chooseEngine('auto', { state: 'idle' }, all), { engine: 'whisper' });
  assert.deepEqual(chooseEngine('auto', undefined, all), { engine: 'whisper' });
  assert.deepEqual(chooseEngine('auto', { state: 'installing' }, all), { engine: 'browser' });
  assert.deepEqual(chooseEngine('auto', { state: 'unavailable' }, all), { engine: 'browser' });
  assert.deepEqual(chooseEngine('browser', { state: 'ready' }, all), { engine: 'browser' });
  // Forced Whisper even while it is installing: the request then reports why.
  assert.deepEqual(chooseEngine('whisper', { state: 'installing' }, all), { engine: 'whisper' });
  assert.match((chooseEngine('auto', { state: 'unavailable', detail: 'not installed' }, { record: true, browser: false, secure: true }) as { error: string }).error, /not installed/);
  assert.match((chooseEngine('auto', undefined, { record: false, browser: false, secure: false }) as { error: string }).error, /https/);
  assert.match((chooseEngine('browser', undefined, { record: true, browser: false, secure: true }) as { error: string }).error, /no speech recognition/);
});

test('micErrorMessage: blocked permission tells each device where to allow it', async () => {
  const { micErrorMessage } = await import('../shared/voice.ts');
  assert.match(micErrorMessage('NotAllowedError', 'iphone'), /Website Settings/);
  assert.match(micErrorMessage('not-allowed', 'desktop'), /address bar/);
  assert.match(micErrorMessage('NotFoundError', 'desktop'), /No microphone/);
  assert.match(micErrorMessage('Weird', 'desktop'), /Weird/);
});

test('voice setup: text-to-speech is a separate part, stamped on its own; Whisper stays usable without it', async () => {
  const { ttsRequirementsHash, KOKORO } = await import('./voiceSetup.ts');
  const { cfg } = voiceCfg({ tts: true });
  const p = voicePaths(cfg.voice);
  // Whisper installed and stamped, TTS not yet.
  fs.mkdirSync(path.dirname(p.python), { recursive: true });
  fs.writeFileSync(p.python, '');
  fs.mkdirSync(modelDir(cfg.voice), { recursive: true });
  fs.writeFileSync(path.join(modelDir(cfg.voice), 'model.bin'), '');
  fs.writeFileSync(p.stamp, JSON.stringify({ requirements: requirementsHash(), model: 'tiny.en' }));
  assert.equal(setupNeeded(cfg.voice, 'stt'), null);
  assert.equal(setupNeeded(cfg.voice, 'tts'), 'text-to-speech not installed');
  assert.equal(setupNeeded(cfg.voice), 'text-to-speech not installed');
  const v = new VoiceService(cfg, () => '');
  assert.equal(v.status().state, 'idle');
  assert.equal(v.status().tts.state, 'unavailable');
  await assert.rejects(v.speak('hello'), /text-to-speech is unavailable/);
  // Then TTS: its venv, the Kokoro files, and its own stamp fields.
  fs.mkdirSync(path.dirname(p.ttsPython), { recursive: true });
  fs.writeFileSync(p.ttsPython, '');
  assert.equal(setupNeeded(cfg.voice, 'tts'), 'text-to-speech requirements changed');
  fs.writeFileSync(p.stamp, JSON.stringify({ requirements: requirementsHash(), model: 'tiny.en', ttsRequirements: ttsRequirementsHash(), ttsModel: KOKORO.id }));
  assert.equal(setupNeeded(cfg.voice, 'tts'), 'Kokoro model not downloaded');
  fs.mkdirSync(path.dirname(p.kokoroModel), { recursive: true });
  fs.writeFileSync(p.kokoroModel, '');
  fs.writeFileSync(p.kokoroVoices, '');
  assert.equal(setupNeeded(cfg.voice), null);
  assert.equal(v.status().tts.state, 'idle');
  assert.equal(v.status().tts.voice, 'af_heart');
  // voice.tts off: nothing to install for it, and it reports why.
  assert.equal(setupNeeded({ ...cfg.voice, tts: false, toolsDir: path.join(cfg.dataDir, 'none') }, 'tts'), null);
  assert.match(new VoiceService({ ...cfg, voice: { ...cfg.voice, tts: false } } as Config, () => '').status().tts.detail ?? '', /voice.tts/);
});
