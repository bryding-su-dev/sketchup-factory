import { useState } from 'react';
import { NOTIFY_KINDS, type AppVersion } from '../../../shared/types';
import { disablePush, enablePush, setPref, testNotification, usePush } from '../notify';
import { api } from '../api';
import { logout, toast, toastError } from '../store';
import { SHORTCUT_LABEL, VOICE_PREF_DEFAULTS, refreshVoiceStatus, setVoicePrefs, useVoicePrefs, useVoiceStatus, type TtsEnginePref } from '../voice/dictation';
import { browserSpeechSupported } from '../voice/browserSpeech';
import type { VoiceEnginePref } from '../../../shared/voice';
import { Modal } from './ui';
import { versionLabel } from '../util';

/** This device's settings: notifications and voice input. */
export function SettingsModal({ app, onClose }: { app?: AppVersion; onClose: () => void }) {
  const p = usePush();
  const [testing, setTesting] = useState(false);
  const on = !!p.endpoint;
  const canInPage = p.permission === 'granted';

  const status = !p.supported
    ? p.needsHomeScreen
      ? 'On iPhone and iPad, add SketchUp Factory to the Home Screen first (Share → Add to Home Screen), open it from there, then turn notifications on here.'
      : 'This browser cannot receive push notifications. While this tab is open in the background it can still show them.'
    : p.permission === 'denied'
      ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.'
      : on
        ? 'On: this device gets notifications even when SketchUp Factory is closed.'
        : 'Off on this device.';

  return (
    <Modal
      title="This device"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost danger-hover settings-signout" onClick={() => void logout()} title="Sign this browser out">
            Sign out
          </button>
          <span className="spacer" />
          {(on || canInPage) && (
            <button
              className="btn btn-ghost"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  toast(await testNotification());
                } catch (e) {
                  toastError(e);
                } finally {
                  setTesting(false);
                }
              }}
            >
              Send a test
            </button>
          )}
          {p.supported && p.permission !== 'denied' && (
            <button className={`btn ${on ? 'btn-outline' : 'btn-primary'}`} disabled={p.busy} onClick={() => (on ? disablePush() : enablePush()).catch(toastError)}>
              {p.busy ? 'Working…' : on ? 'Turn off' : 'Turn on'}
            </button>
          )}
          {!p.supported && 'Notification' in window && p.permission === 'default' && (
            <button className="btn btn-primary" onClick={() => Notification.requestPermission().then(() => location.reload())}>
              Allow in-tab notifications
            </button>
          )}
        </>
      }
    >
      <div className="form">
        <p className={`small ${on ? 'tone-green' : 'dim'}`}>{status}</p>
        <div className="field">
          <span>Tell me when</span>
          {NOTIFY_KINDS.map((k) => (
            <label key={k.value} className="check">
              <input type="checkbox" checked={p.prefs[k.value]} onChange={(e) => void setPref(k.value, e.target.checked).catch(toastError)} />
              <span>
                {k.label} <small className="dim">{k.hint}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="dim small">These choices belong to this device; your phone and your desktop can differ. While the app is in front, nothing pops up.</p>
        <VoiceSettings />
        {app && (
          <div className="field about" data-testid="about-version">
            <span>About</span>
            <p className="small dim">
              SketchUp Factory <span className="mono">{versionLabel(app)}</span> ·{' '}
              <a href="https://github.com/bryding-su-dev/sketchup-factory/blob/sketchup/CHANGELOG.md" target="_blank" rel="noreferrer">
                changelog
              </a>
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** English Kokoro voices worth offering (the model has more). */
const KOKORO_VOICES: [string, string][] = [
  ['af_heart', 'Heart (US, female)'],
  ['af_bella', 'Bella (US, female)'],
  ['af_nicole', 'Nicole (US, female, soft)'],
  ['am_michael', 'Michael (US, male)'],
  ['am_fenrir', 'Fenrir (US, male)'],
  ['am_puck', 'Puck (US, male)'],
  ['bf_emma', 'Emma (UK, female)'],
  ['bm_george', 'George (UK, male)'],
  ['bm_fable', 'Fable (UK, male)'],
];

function VoiceSettings() {
  const prefs = useVoicePrefs();
  const s = useVoiceStatus();
  const [installing, setInstalling] = useState(false);
  const whisper =
    !s
      ? 'Local Whisper: status unknown (the server did not answer).'
      : s.state === 'ready'
        ? `Local Whisper (${s.model}): loaded on the ${s.device === 'cuda' ? 'GPU' : 'CPU'}.`
        : s.state === 'idle'
          ? `Local Whisper (${s.model}): installed; the model loads when you start talking and unloads when idle.`
          : s.state === 'loading'
            ? `Local Whisper (${s.model}): loading the model.`
            : s.state === 'installing'
              ? 'Local Whisper: first-time setup is downloading (a few minutes). Until then the browser’s speech recognition is used.'
              : `Local Whisper: unavailable${s.detail ? ` (${s.detail})` : ''}.`;
  return (
    <div className="field">
      <span>Voice input</span>
      <p className="small dim">
        The mic in every message box: click it, or hold it to talk and let go to send it to the box; {SHORTCUT_LABEL} does the same while typing (Esc
        discards). On a phone, tap to start and tap to stop. The text lands in the box for you to check; audio is not kept.
      </p>
      <label className="voice-engine">
        <span>Engine</span>
        <select className="input" value={prefs.engine} onChange={(e) => setVoicePrefs({ engine: e.target.value as VoiceEnginePref })}>
          <option value="auto">Automatic: local Whisper, else the browser</option>
          <option value="whisper">Local Whisper only (private, knows FF words)</option>
          <option value="browser" disabled={!browserSpeechSupported()}>
            Browser speech recognition{browserSpeechSupported() ? '' : ' (not in this browser)'}
          </option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.autoSend} onChange={(e) => setVoicePrefs({ autoSend: e.target.checked })} />
        <span>
          Send automatically after dictation <small className="dim">off: the text waits in the box until you press Send</small>
        </span>
      </label>
      <p className={`small ${s?.state === 'ready' || s?.state === 'idle' ? 'tone-green' : 'dim'}`}>
        {whisper}
      </p>
      <label className="check">
        <input type="checkbox" checked={prefs.dictationAutoStop} onChange={(e) => setVoicePrefs({ dictationAutoStop: e.target.checked })} />
        <span>
          Stop dictation by itself when I stop talking <small className="dim">after the pause below; holding the mic always waits for the release</small>
        </span>
      </label>
      <label className="voice-engine">
        <span>Pause that ends speech</span>
        <select className="input" value={prefs.silenceMs} onChange={(e) => setVoicePrefs({ silenceMs: Number(e.target.value) })}>
          {[1000, 1500, 1800, 2500, 3500].map((ms) => (
            <option key={ms} value={ms}>
              {(ms / 1000).toFixed(1)} s{ms === VOICE_PREF_DEFAULTS.silenceMs ? ' (default)' : ms < 1500 ? ' (quick)' : ms > 2000 ? ' (for long pauses)' : ''}
            </option>
          ))}
        </select>
      </label>

      <span className="voice-sub">Voice mode (hands-free)</span>
      <p className="small dim">
        The Voice button (the wave icon) next to the mic: it listens, sends what you said when you pause, reads the reply aloud and listens again. Say “stop” or tap
        the screen to end it. It keeps the screen on while it runs.
      </p>
      <label className="voice-engine">
        <span>Read replies with</span>
        <select className="input" value={prefs.ttsEngine} onChange={(e) => setVoicePrefs({ ttsEngine: e.target.value as TtsEnginePref })}>
          <option value="auto">Automatic: local Kokoro, else the browser’s voice</option>
          <option value="local">Local Kokoro only</option>
          <option value="browser">The browser’s voice</option>
        </select>
      </label>
      <div className="field-row">
        <label className="voice-engine">
          <span>Voice</span>
          <select className="input" value={prefs.ttsVoice} onChange={(e) => setVoicePrefs({ ttsVoice: e.target.value })}>
            <option value="">Default{s?.tts ? ` (${KOKORO_VOICES.find(([v]) => v === s.tts.voice)?.[1] ?? s.tts.voice})` : ''}</option>
            {KOKORO_VOICES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="voice-engine">
          <span>Speed</span>
          <select className="input" value={prefs.ttsSpeed} onChange={(e) => setVoicePrefs({ ttsSpeed: Number(e.target.value) })}>
            {[0.9, 1, 1.15, 1.3, 1.5].map((x) => (
              <option key={x} value={x}>
                {x === 1 ? 'Normal' : `${x}×`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={prefs.bargeIn} onChange={(e) => setVoicePrefs({ bargeIn: e.target.checked })} />
        <span>
          Talking over a reply interrupts it <small className="dim">turn off if the phone’s speaker keeps cutting itself off</small>
        </span>
      </label>
      <p className={`small ${s?.tts.state === 'ready' || s?.tts.state === 'idle' ? 'tone-green' : 'dim'}`}>
        {!s
          ? ''
          : s.tts.state === 'ready'
            ? `Local Kokoro: loaded on the ${s.tts.device === 'cuda' ? 'GPU' : 'CPU'}.`
            : s.tts.state === 'idle'
              ? 'Local Kokoro: installed; loads when voice mode starts.'
              : s.tts.state === 'loading'
                ? 'Local Kokoro: loading.'
                : s.tts.state === 'installing'
                  ? 'Local Kokoro: installing. Until then the browser’s voice reads replies.'
                  : `Local Kokoro: unavailable${s.tts.detail ? ` (${s.tts.detail})` : ''}; the browser’s voice reads replies.`}
      </p>
      {s?.state === 'unavailable' && /setup failed|voice-setup/.test(s.detail ?? '') && (
        <button
          type="button"
          className="btn btn-outline btn-xs"
          disabled={installing}
          onClick={async () => {
            setInstalling(true);
            try {
              await api.voiceInstall();
              toast('Installing local Whisper in the background');
            } catch (e) {
              toastError(e);
            } finally {
              setInstalling(false);
              refreshVoiceStatus(0);
            }
          }}
        >
          Install local Whisper
        </button>
      )}
    </div>
  );
}
