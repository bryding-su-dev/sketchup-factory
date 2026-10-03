import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { api } from '../api';
import type { ImageInput } from '../../../shared/types';
import { attempt, toast, useStore } from '../store';
import { clearPending, removePending, startUpload, usePendingFiles } from '../upload';
import { enterAction } from '../../../shared/keys';
import { dropCaret, EDITABLE_MODE, insertPlainText, readText, setCaret, writeText } from '../editable';
import { fmtBytes, isBusy, lsGet, lsSet, shrinkImage, useMediaQuery } from '../util';
import { useTextareaDictation } from '../voice/useTextareaDictation';
import { useVoicePrefs } from '../voice/dictation';
import { DictationBar, MicButton } from './Mic';
import { onScreenKeyboard } from '../viewport';
import { VoiceModeButton, VoiceModeOverlay, useVoiceMode } from './VoiceMode';
import { Icon } from './ui';

/** Without the app's settings yet: the server's defaults (config attachments). */
const ATTACH_DEFAULTS = { maxBytes: 200 * 1024 * 1024, retentionDays: 30, maxPerMessage: 10 };
/** Images go to the agent as images (converted when needed); one the browser cannot read is uploaded as a file. */
const IMAGE_INPUT = /^image\//;

export const Composer = memo(function Composer({
  session,
  size = 'normal',
  placeholder,
  prefill,
  onPrefillUsed,
  autoFocus,
}: {
  session: SessionInfo;
  size?: 'normal' | 'large';
  placeholder?: string;
  /** Text pushed in from outside (e.g. a suggestion chip). */
  prefill?: string | null;
  onPrefillUsed?: () => void;
  /** Put the caret here when the conversation opens (desktop only: on a phone it would pop the keyboard). */
  autoFocus?: boolean;
}) {
  const key = `ffsb.draft.${session.id}`;
  const [text, setText] = useState(() => lsGet(key) ?? '');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [images, setImages] = useState<(ImageInput & { key: number })[]>([]);
  // Files upload outside the composer (web/src/upload.ts), so they go on while this chat is closed.
  const files = usePendingFiles(session.id);
  const limits = useStore((s) => s.app?.config.attachments) ?? ATTACH_DEFAULTS;
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(0);
  // The message box is contenteditable, not a textarea: see web/src/editable.ts.
  const ta = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const busy = isBusy(session);
  // Phones and tablets: with their on-screen keyboard (no Shift to hand) Enter inserts a new line and the
  // button sends; with a hardware keyboard (an iPad's) Enter sends, as on a desktop (onScreenKeyboard).
  const touch = useMediaQuery('(pointer: coarse)');
  // Standing agents take text only (their runs are budgeted text turns); everyone else takes images and files.
  const canAttach = session.kind !== 'standing';
  const uploading = files.some((f) => !f.ref && !f.error);
  const failed = files.some((f) => f.error);

  /** Start uploading `f` unless it breaks a limit (said in a toast); whether it started. */
  const attachFile = (f: File, pending: number) => {
    const why = !f.size
      ? `${f.name} is empty`
      : f.size > limits.maxBytes
        ? `${f.name} is ${fmtBytes(f.size)}; the limit is ${fmtBytes(limits.maxBytes)}`
        : pending >= limits.maxPerMessage
          ? `At most ${limits.maxPerMessage} files per message`
          : undefined;
    if (why) {
      toast(why, 'error');
      return false;
    }
    startUpload(session.id, f);
    return true;
  };

  /** Images go to the agent as images (shrunk first); every other file, or an image the browser cannot read, is uploaded. */
  const addFiles = async (incoming: Iterable<File>) => {
    const all = [...incoming];
    const list = all.filter((f) => IMAGE_INPUT.test(f.type));
    let pending = files.length;
    for (const f of all) if (!IMAGE_INPUT.test(f.type) && attachFile(f, pending)) pending++;
    if (!list.length) return;
    if (images.length + list.length > 8) return toast('At most 8 images per message', 'error');
    setReading((n) => n + list.length);
    for (const f of list) {
      try {
        const img = await shrinkImage(f);
        setImages((xs) => [...xs, { ...img, key: Math.random() }]);
      } catch {
        if (attachFile(f, pending)) pending++;
      } finally {
        setReading((n) => n - 1);
      }
    }
  };

  // The draft is saved a moment after typing stops (not on every key), and at once when the chat closes or the page goes.
  const draft = useRef(text);
  draft.current = text;
  useEffect(() => {
    const t = setTimeout(() => lsSet(key, text), 400);
    return () => clearTimeout(t);
  }, [key, text]);
  useEffect(() => {
    const save = () => lsSet(key, draft.current);
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [key]);

  // The box is not controlled by React: what the user types is read from it (onInput), and a text
  // that comes from elsewhere (the draft, a suggestion, a dictation, the empty box after sending) is
  // written into it. `shown` is what it holds, as last read or written.
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el || shown.current === text) return;
    shown.current = text;
    writeText(el, text);
    // As in a textarea whose value is set: the caret goes to the end.
    if (document.activeElement === el) setCaret(el, text.length);
  }, [text]);

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onPrefillUsed?.();
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        setCaret(el, prefill.length);
      });
    }
  }, [prefill, onPrefillUsed]);

  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  useEffect(() => {
    const el = ta.current;
    if (!el || !autoFocus || touch || document.querySelector('.overlay')) return;
    el.focus({ preventScroll: true });
    setCaret(el, readText(el).length);
  }, [autoFocus, touch, session.id]);

  // No bold or italics (Cmd+B, the iOS text menu) in the fallback where the box is fully editable.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const onBefore = (e: InputEvent) => {
      if (e.inputType.startsWith('format')) e.preventDefault();
    };
    el.addEventListener('beforeinput', onBefore);
    return () => el.removeEventListener('beforeinput', onBefore);
  }, []);

  // The box grows with its text up to a cap, then scrolls. The cap follows the visible viewport, so
  // with the on-screen keyboard open (or in landscape) the box never pushes the conversation off screen.
  const [viewH, setViewH] = useState(() => window.visualViewport?.height ?? window.innerHeight);
  useEffect(() => {
    const vv = window.visualViewport;
    const on = () => setViewH(vv?.height ?? window.innerHeight);
    (vv ?? window).addEventListener('resize', on);
    return () => (vv ?? window).removeEventListener('resize', on);
  }, []);
  const cap = Math.max(72, Math.min(size === 'large' ? 320 : 220, Math.round(viewH * 0.35)));

  // The box itself never moves under a finger: a drag on it is cancelled unless it is inside the
  // text box and that has more text than it shows.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onMove = (e: TouchEvent) => {
      const t = (e.target as Element | null)?.closest('.composer-input');
      if (t && t.scrollHeight > t.clientHeight + 1) return;
      if (e.cancelable) e.preventDefault();
    };
    box.addEventListener('touchmove', onMove, { passive: false });
    return () => box.removeEventListener('touchmove', onMove);
  }, []);

  /** `override`: the text to send instead of the box's (auto-send after dictation, before the state lands). */
  const send = async (override?: string) => {
    const t = (override ?? text).trim();
    if ((!t && !images.length && !files.length) || sending || reading || uploading) return;
    if (failed) return toast('An attachment did not upload: retry it or remove it', 'error');
    setSending(true);
    const sentFiles = files;
    const ok = await attempt(
      api.sendMessage(
        session.id,
        t,
        images.map(({ mediaType, data }) => ({ mediaType, data })),
        sentFiles.map((f) => f.ref!.id),
      ),
    );
    setSending(false);
    if (ok !== undefined) {
      setText('');
      setImages([]);
      clearPending(session.id, sentFiles);
    }
    if (ok?.note) toast(ok.note);
    ta.current?.focus();
  };

  const voiceMode = useVoiceMode(session);
  const hasContent = !!text.trim() || images.length > 0 || files.length > 0;
  const { bargeIn } = useVoicePrefs();
  const voice = useTextareaDictation({ value: text, setValue: setText, ref: ta, onAutoSend: (t) => void send(t) });

  const stop = async () => {
    setStopping(true);
    // A standing agent's Stop ends its run (and books it), rather than leaving the process idle mid-run.
    const ok = await attempt(session.standingId ? api.stopStanding(session.standingId) : api.interrupt(session.id));
    if (ok === undefined) setStopping(false);
  };

  const hintText = busy && !session.standingId ? 'Add a follow-up…' : (placeholder ?? 'Message…');
  const hint =
    session.kind === 'standing'
      ? session.status === 'stopped' || session.status === 'error'
        ? 'Asleep between runs. A message starts a run, with the same budget and agent limit.'
        : null
      : session.status === 'stopped'
      ? 'Session stopped. Sending a message resumes it.'
      : session.status === 'error'
        ? 'Session errored. Sending a message tries to resume it.'
        : null;

  return (
    <div className={`composer composer-${size}`}>
      {voiceMode.view && <VoiceModeOverlay title={session.kind === 'orchestrator' ? 'Orchestrator' : session.title} view={voiceMode.view} level={voiceMode.level} onEnd={voiceMode.end} bargeIn={bargeIn} />}
      {hint && <div className="composer-hint">{hint}</div>}
      <div
        ref={boxRef}
        className={`composer-box${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          if (!canAttach || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!canAttach || !e.dataTransfer.files.length) return;
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        {files.length > 0 && (
          <div className="composer-files">
            {files.map((f) => {
              const pct = Math.floor((f.sent * 100) / f.file.size);
              return (
                <span key={f.key} className={`composer-file${f.error ? ' failed' : f.ref ? ' done' : ''}`} title={f.error ? `${f.file.name}: ${f.error}` : f.file.name}>
                  <Icon name="file" size={14} />
                  <span className="composer-file-name">{f.file.name}</span>
                  <span className="composer-file-size">{f.error ? 'failed' : f.ref ? fmtBytes(f.file.size) : `${pct}%`}</span>
                  {!f.ref && !f.error && (
                    <span className="composer-file-bar" role="progressbar" aria-label={`Uploading ${f.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                      <i style={{ width: `${pct}%` }} />
                    </span>
                  )}
                  {f.error && (
                    <button className="composer-file-btn" onClick={() => startUpload(session.id, f.file, f.key)} title="Upload it again" aria-label={`Retry ${f.file.name}`}>
                      <Icon name="refresh" size={12} />
                    </button>
                  )}
                  <button className="composer-file-btn" onClick={() => removePending(session.id, f.key)} title="Remove" aria-label={`Remove ${f.file.name}`}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {(images.length > 0 || reading > 0) && (
          <div className="composer-images">
            {images.map((img) => (
              <span key={img.key} className="composer-image">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt="" />
                <button className="composer-image-x" onClick={() => setImages((xs) => xs.filter((x) => x.key !== img.key))} aria-label="Remove image">
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
            {reading > 0 && (
              <span className="composer-image composer-image-busy">
                <span className="spinner" />
              </span>
            )}
          </div>
        )}
        <DictationBar d={voice.d} />
        <div
          ref={ta}
          className="composer-input"
          contentEditable={EDITABLE_MODE}
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder ?? 'Message'}
          aria-placeholder={hintText}
          data-placeholder={hintText}
          data-empty={text ? undefined : ''}
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
          inputMode="text"
          enterKeyHint={touch ? 'enter' : 'send'}
          style={{ maxHeight: cap }}
          {...voice.textareaProps}
          onInput={(e) => {
            const t = readText(e.currentTarget);
            shown.current = t;
            setText(t);
          }}
          onPaste={(e) => {
            // Pasted files (a screenshot, or files copied in Finder or Explorer): images inline, the rest uploaded.
            const pasted = canAttach ? [...e.clipboardData.files] : [];
            if (pasted.length) {
              e.preventDefault();
              void addFiles(pasted);
              return;
            }
            // plaintext-only pastes text as text; the fallback would paste a web page's formatting.
            if (EDITABLE_MODE === 'plaintext-only') return;
            e.preventDefault();
            insertPlainText(e.clipboardData.getData('text/plain'));
          }}
          onDrop={(e) => {
            // Dropped files are the composer box's (above); in the fallback a dropped text comes in plain.
            if (EDITABLE_MODE === 'plaintext-only' || e.dataTransfer.files.length) return;
            e.preventDefault();
            e.currentTarget.focus();
            dropCaret(e.currentTarget, e.clientX, e.clientY);
            insertPlainText(e.dataTransfer.getData('text/plain'));
          }}
          onKeyDown={(e) => {
            if (voice.keyDown(e)) return;
            const act = enterAction(
              { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode },
              { touch: touch && onScreenKeyboard(), canSend: !!text.trim() || images.length > 0 || files.length > 0 },
            );
            if (act === 'default') return;
            e.preventDefault();
            if (act === 'send') void send();
            // Ctrl/Cmd+Enter: the same line break as Shift+Enter (execCommand keeps undo working).
            if (act === 'newline') insertPlainText('\n');
          }}
        />
        <div className="composer-actions">
          {canAttach && (
            <>
              <button className="btn btn-ghost btn-icon" onClick={() => picker.current?.click()} title={`Attach images or files: saves, bug reports, logs (up to ${fmtBytes(limits.maxBytes)}; or paste / drop them)`} aria-label="Attach files">
                <Icon name="paperclip" size={16} />
              </button>
              {/* Any file: images go inline, everything else is uploaded (docs/attachments.md). */}
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </>
          )}
          <span className="composer-spacer" />
          {busy && hasContent && (
            <button className="btn btn-ghost btn-icon btn-stop-mini" onClick={stop} disabled={stopping} title="Stop the current turn" aria-label="Stop">
              <Icon name="stop" size={15} />
            </button>
          )}
          {busy && !hasContent && !sending && <VoiceModeButton onStart={voiceMode.start} ghost />}
          <MicButton d={voice.d} />
          {/* One primary slot, as in the ChatGPT and Claude apps: Send when there is something to send, Stop while a turn runs, else voice mode. */}
          {hasContent || sending ? (
            <button
              className="btn btn-primary btn-icon btn-send"
              onClick={() => void send()}
              disabled={sending || reading > 0 || uploading}
              title={uploading ? 'Waiting for the attachments to upload' : touch ? 'Send' : busy ? 'Send (it waits for the current turn)' : 'Send (Enter; Shift+Enter for a new line)'}
              aria-label="Send"
            >
              {sending ? <span className="spinner spinner-dark" /> : <Icon name="send" size={18} />}
            </button>
          ) : busy ? (
            <button className="btn btn-icon btn-stop-main" onClick={stop} disabled={stopping} title={stopping ? 'Stopping…' : 'Stop the current turn'} aria-label="Stop">
              {stopping ? <span className="spinner spinner-dark" /> : <Icon name="stop" size={16} />}
            </button>
          ) : (
            <VoiceModeButton onStart={voiceMode.start} />
          )}
        </div>
      </div>
    </div>
  );
});
