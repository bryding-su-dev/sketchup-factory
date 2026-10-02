// Voice input: the wire contract and the pure helpers both sides use (server/voice.ts, web/src/voice/).
// No imports, so the browser bundle and `node --test` can both load it.

/** The local Whisper service, as the mic button sees it. */
export interface VoiceStatus {
  /**
   * ready: model loaded, a clip transcribes at once. idle: installed, loads on first use (a few s).
   * loading: the model is loading. installing: first-time setup is downloading. unavailable: see detail.
   */
  state: 'ready' | 'idle' | 'loading' | 'installing' | 'unavailable';
  detail?: string;
  model: string;
  /** "cuda" or "cpu", once loaded. */
  device?: string;
  /** Local text-to-speech (Kokoro) for voice mode. */
  tts: TtsStatus;
}

export interface TtsStatus {
  state: 'ready' | 'idle' | 'loading' | 'installing' | 'unavailable';
  detail?: string;
  /** The server's default voice. */
  voice: string;
  device?: string;
  /** Every voice the model has, once loaded. */
  voices?: string[];
}

export interface SpeakRequest {
  text: string;
  voice?: string;
  /** 1 = normal. */
  speed?: number;
}

/** Longest text one /api/voice/tts request takes; the page sends a reply in sentence-sized pieces. */
export const MAX_TTS_CHARS = 1000;

export interface TranscribeRequest {
  /** Base64 of a 16-bit PCM mono WAV, 16 kHz. */
  audio: string;
}

export interface TranscribeResult {
  text: string;
  model: string;
  device: string;
  /** Length of the clip. */
  audioSeconds: number;
  /** Model time only. */
  seconds: number;
  /** Server time for the whole request, including a model load if it had to wait for one. */
  totalSeconds: number;
}

/** The rate Whisper works at; the browser downsamples to it before uploading. */
export const VOICE_RATE = 16000;
/** Longest clip the mic records; it stops by itself at this point. */
export const MAX_DICTATION_SECONDS = 300;

// ---------------------------------------------------------------- Whisper's prompt

/** Words Whisper should spell our way, most important first (a long prompt is cut from the end). */
export const CORE_VOCABULARY = [
  'Final Factory, SketchUp Factory, orchestrator, sandbox, worktree, standing agent',
  'Claude Code, Fable, Opus, Sonnet, Haiku, MCP, subagent, handoff, Tailscale Funnel, GitHub, PR, develop, rebase',
  'Unity, DOTS, ECS, Burst, ISystem, lockstep, determinism, desync, heartbeat, fixed-point, ParrelSync',
  'mass driver, conveyor, assembler, fleet, tech tree, playtest, Discord',
];

export interface VocabularySource {
  sandboxes: { id: string }[];
  agentNames: string[];
  machines: string[];
  /** Spec folder names, e.g. "074-three-peer-full-playthrough". */
  specs: string[];
  /** config voice.vocabulary. */
  extra: string[];
}

/**
 * Whisper's prompt holds at most 223 tokens, and the words it transcribes share the same 448-token
 * window; ~3 characters a token for names like "shader-blackhole", so stay well under.
 */
export const PROMPT_BUDGET = 600;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The vocabulary Whisper is primed with (faster-whisper "hotwords", given to every 30 s window): the
 * fixed FF and portal words, then names from the current state, whole items only, up to the budget.
 */
export function buildVoicePrompt(src: VocabularySource, budget = PROMPT_BUDGET): string {
  const specNums = [...new Set(src.specs.map((s) => /^(\d{3})-/.exec(s)?.[1]).filter((n): n is string => !!n))]
    .sort()
    .reverse()
    .slice(0, 6)
    .map((n) => `spec ${n}`);
  const lists = [
    src.extra.map(clean),
    ...CORE_VOCABULARY.map((l) => l.split(', ')),
    src.sandboxes.map((s) => s.id),
    src.machines,
    specNums,
    src.agentNames.map(clean).filter((n) => n.length <= 40),
  ];
  const seen = new Set<string>();
  const sentences: string[] = [];
  let used = 0;
  for (const list of lists) {
    const fit: string[] = [];
    for (const item of list) {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) continue;
      // ", item" within this sentence, or ". item" to start one.
      const cost = item.length + 2;
      if (used + cost > budget) continue;
      seen.add(key);
      fit.push(item);
      used += cost;
    }
    if (fit.length) sentences.push(fit.join(', '));
  }
  return sentences.length ? sentences.join('. ') + '.' : '';
}

// ---------------------------------------------------------------- audio

/**
 * Downsample mono float samples to `to` Hz. Averages the source samples each output sample covers,
 * which is a crude low-pass: enough for speech at 16 kHz (no aliasing whine from 48 kHz input).
 */
export function downsample(input: Float32Array, from: number, to = VOICE_RATE): Float32Array {
  if (from === to) return input;
  if (from < to) throw new Error(`cannot upsample ${from} Hz to ${to} Hz`);
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Mono float samples in [-1, 1] -> a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, rate = VOICE_RATE): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Duration in seconds of a 16-bit mono PCM WAV (as encodeWav writes), or undefined if it is not one. */
export function wavSeconds(wav: Uint8Array): number | undefined {
  if (wav.length < 44) return undefined;
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ') return undefined;
  if (v.getUint16(20, true) !== 1 || v.getUint16(34, true) !== 16) return undefined;
  const rate = v.getUint32(24, true);
  const channels = v.getUint16(22, true);
  if (!rate || !channels) return undefined;
  return (wav.length - 44) / (2 * channels * rate);
}

/** Loudness of a chunk for the level meter, 0..1 (RMS, scaled so normal speech sits around 0.3-0.7). */
export function level(samples: Float32Array | Uint8Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  if (samples instanceof Uint8Array) {
    // AnalyserNode byte time-domain data: 128 is silence.
    for (const b of samples) sum += ((b - 128) / 128) ** 2;
  } else {
    for (const s of samples) sum += s * s;
  }
  const rms = Math.sqrt(sum / samples.length);
  // Speech RMS is roughly 0.01-0.3: map it on a log scale so quiet speech still moves the meter.
  return Math.max(0, Math.min(1, 1 + Math.log10(rms + 1e-6) / 2.5));
}

// ---------------------------------------------------------------- text

/** "m:ss" for the recording timer. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whisper's text for a silent or empty clip ("[BLANK_AUDIO]", "(silence)"), which should insert nothing. */
export function isEmptyTranscript(t: string): boolean {
  const s = t.trim().toLowerCase().replace(/[.!?,\s]+$/g, '');
  return !s || /^(\[[\w\s]+\]|\([\w\s]+\))$/.test(s);
}

/**
 * Put a transcript into composer text at the selection, replacing it, with a space on either side
 * where needed. Returns the new text and where the caret goes (just after the insert).
 */
export function insertTranscript(text: string, start: number, end: number, transcript: string): { text: string; caret: number } {
  const t = transcript.trim();
  if (!t) return { text, caret: end };
  start = Math.max(0, Math.min(start, text.length));
  end = Math.max(start, Math.min(end, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
  const insert = lead + t + trail;
  return { text: before + insert + after, caret: before.length + lead.length + t.length };
}

// ---------------------------------------------------------------- engine choice

export type VoiceEngine = 'whisper' | 'browser';
/** This device's choice in Settings. */
export type VoiceEnginePref = 'auto' | VoiceEngine;

/**
 * Which engine a new dictation uses. Auto prefers local Whisper unless the server says it cannot
 * serve (not installed, installing, turned off); an unknown status (not fetched yet) counts as
 * available, and a failure then shows as an error with a retry.
 */
export function chooseEngine(
  pref: VoiceEnginePref,
  status: Pick<VoiceStatus, 'state' | 'detail'> | undefined,
  can: { record: boolean; browser: boolean; secure: boolean },
): { engine: VoiceEngine } | { error: string } {
  const whisperUp = !status || (status.state !== 'unavailable' && status.state !== 'installing');
  const whisper = can.record && (pref === 'whisper' || (pref === 'auto' && whisperUp));
  if (whisper) return { engine: 'whisper' };
  if (pref !== 'whisper' && can.browser) return { engine: 'browser' };
  if (!can.secure) return { error: 'Voice input needs a secure page: open SketchUp Factory at its https:// address.' };
  if (pref === 'whisper' && !can.record) return { error: 'This browser cannot record audio here.' };
  if (pref === 'browser') return { error: 'This browser has no speech recognition. Choose local Whisper in Settings.' };
  return { error: `Local Whisper is ${status?.state ?? 'unavailable'}${status?.detail ? ` (${status.detail})` : ''}, and this browser has no speech recognition of its own.` };
}

/** Why the microphone could not be opened, in words the user can act on. */
export function micErrorMessage(name: string, device: 'iphone' | 'desktop'): string {
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'not-allowed' || name === 'service-not-allowed') {
    return device === 'iphone'
      ? 'Microphone access is blocked. In Safari, tap "aA" in the address bar → Website Settings → Microphone → Allow (for the Home Screen app: Settings → Apps → Safari → Microphone), then try again.'
      : 'Microphone access is blocked for this site. Click the icon at the left of the address bar → Microphone → Allow, then try again.';
  }
  if (name === 'NotFoundError' || name === 'audio-capture') return 'No microphone found.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app.';
  if (name === 'AudioSuspended') return 'The browser kept audio paused: tap the mic again.';
  if (name === 'network') return 'The browser’s speech service is unreachable.';
  return `Could not start the microphone (${name}).`;
}
