import fs from 'node:fs';
import { run } from '../server/proc.ts';
import { findClosable, findDialogs, type Dialog, type EditorWindow } from '../server/watchdog.ts';

/**
 * The dialog watchdog's eyes and hands on a Mac (docs/unity-dialogs.md, "Macs"): Unity's windows and sheets
 * through System Events (JXA via osascript), mapped onto the same EditorWindow shape the Windows probe
 * (scripts/unity-windows.ps1) reports, so findDialogs/decide and the rule table are shared.
 *
 * macOS privacy (TCC): reading another app's UI needs Accessibility for the process responsible for
 * osascript, which under launchd is the daemon's node binary, and talking to System Events needs Automation
 * ("node" may control "System Events"). Neither can be granted from code; macPermissionProblem turns the
 * errors into the one-time step for a person.
 */

/** One window (or a sheet on it) of the Unity process, as the list script reports it. */
export interface MacWindow {
  /** 1-based window index in System Events; with `sheet`, the sheet's 1-based index on that window. */
  index: number;
  sheet?: number;
  title: string;
  /** AXStandardWindow, AXDialog, AXSystemDialog, AXFloatingWindow, AXSheet, ... */
  subrole: string;
  text: string[];
  buttons: string[];
}

/** Lists a process's windows and sheets with their static texts and named buttons. argv: pid. */
export const LIST_SCRIPT = `
function run(argv) {
  var pid = parseInt(argv[0], 10);
  var se = Application('System Events');
  var ps = se.processes.whose({ unixId: pid })();
  if (!ps.length) return '[]';
  var p = ps[0];
  function tryv(f, d) { try { var v = f(); return v === null || v === undefined ? d : v; } catch (e) { return d; } }
  function texts(el) {
    var out = [];
    tryv(function () { return el.staticTexts(); }, []).forEach(function (t) {
      var v = tryv(function () { return t.value(); }, '') || tryv(function () { return t.name(); }, '');
      if (v) out.push(String(v));
    });
    tryv(function () { return el.scrollAreas(); }, []).forEach(function (s) {
      tryv(function () { return s.textAreas(); }, []).forEach(function (t) {
        var v = tryv(function () { return t.value(); }, '');
        if (v) out.push(String(v));
      });
    });
    return out;
  }
  function buttons(el) {
    return tryv(function () { return el.buttons.name(); }, []).filter(function (b) { return !!b; }).map(String);
  }
  var out = [];
  var wins = p.windows();
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    out.push({ index: i + 1, title: String(tryv(function () { return w.name(); }, '') || ''), subrole: String(tryv(function () { return w.subrole(); }, '') || ''), text: texts(w), buttons: buttons(w) });
    var sheets = tryv(function () { return w.sheets(); }, []);
    for (var j = 0; j < sheets.length; j++) out.push({ index: i + 1, sheet: j + 1, title: '', subrole: 'AXSheet', text: texts(sheets[j]), buttons: buttons(sheets[j]) });
  }
  return JSON.stringify(out);
}`;

/**
 * Presses a named button in one window or sheet, after checking it still shows the expected text.
 * argv: pid, window index, sheet index (0: none), button, expected text (may be empty). Prints {clicked, why?}.
 */
export const CLICK_SCRIPT = `
function run(argv) {
  var pid = parseInt(argv[0], 10), idx = parseInt(argv[1], 10), sheet = parseInt(argv[2], 10), button = argv[3], sig = argv[4] || '';
  var ps = Application('System Events').processes.whose({ unixId: pid })();
  if (!ps.length) return JSON.stringify({ clicked: false, why: 'the process is gone' });
  var w = ps[0].windows[idx - 1];
  var el = sheet ? w.sheets[sheet - 1] : w;
  var t = [];
  try { t = el.staticTexts.value(); } catch (e) {}
  var hay = (sheet ? '' : String(w.name() || '')) + '\\n' + t.join('\\n');
  if (sig && hay.indexOf(sig) < 0) return JSON.stringify({ clicked: false, why: 'the window changed' });
  var bs = el.buttons.whose({ name: button })();
  if (!bs.length) return JSON.stringify({ clicked: false, why: 'no such button' });
  bs[0].click();
  return JSON.stringify({ clicked: true });
}`;

/**
 * Closes one window with its title bar's close button (AXCloseButton), after checking it still has exactly the
 * expected title. argv: pid, window index, title. Prints {closed, why?}.
 */
export const CLOSE_SCRIPT = `
function run(argv) {
  var pid = parseInt(argv[0], 10), idx = parseInt(argv[1], 10), title = argv[2] || '';
  var ps = Application('System Events').processes.whose({ unixId: pid })();
  if (!ps.length) return JSON.stringify({ closed: false, why: 'the process is gone' });
  var w = ps[0].windows[idx - 1];
  var name = '';
  try { name = String(w.name() || ''); } catch (e) { return JSON.stringify({ closed: false, why: 'the window is gone' }); }
  if (!title || name.trim() !== title) return JSON.stringify({ closed: false, why: 'the window changed' });
  var bs = [];
  try { bs = w.buttons.whose({ subrole: 'AXCloseButton' })(); } catch (e) {}
  if (!bs.length) return JSON.stringify({ closed: false, why: 'it has no close button' });
  bs[0].click();
  return JSON.stringify({ closed: true });
}`;

const DIALOG_SUBROLES = new Set(['AXDialog', 'AXSystemDialog', 'AXSheet']);

/** The window id a MacWindow gets in the EditorWindow shape (hwnd): index*100 + sheet. */
export const macWindowId = (w: Pick<MacWindow, 'index' | 'sheet'>) => w.index * 100 + (w.sheet ?? 0);

/**
 * The shared shape: alert windows and sheets count as dialogs. An NSAlert has no window title; its first
 * text (the message) becomes the title and the rest (the informative text) the text, as on Windows.
 */
export function toEditorWindows(pid: number, wins: MacWindow[]): { windows: EditorWindow[]; mainTitle?: string } {
  const windows = wins.map((w): EditorWindow => {
    const dialog = DIALOG_SUBROLES.has(w.subrole);
    const title = w.title || (dialog ? (w.text[0] ?? '') : '');
    const text = !w.title && dialog ? w.text.slice(1) : w.text;
    return { hwnd: macWindowId(w), pid, class: w.subrole, title, enabled: true, owned: dialog, text, buttons: w.buttons, dialog };
  });
  const main = wins.find((w) => w.subrole === 'AXStandardWindow' && /Unity/.test(w.title)) ?? wins.find((w) => w.subrole === 'AXStandardWindow' && w.title);
  return { windows, mainTitle: main?.title };
}

/** The one-time macOS step when osascript failed for want of a privacy permission, or undefined. */
export function macPermissionProblem(stderr: string, nodePath: string): string | undefined {
  if (/-1743|Not authorized to send Apple events/i.test(stderr)) {
    return `macOS has not allowed the daemon to control System Events (Automation). On the Mac, open System Settings > Privacy & Security > Automation, find "node" (${nodePath}) and turn on "System Events". If node is not listed, the permission prompt was never answered: log in at the Mac's desktop, and the next look (within a minute) shows the prompt "node wants access to control System Events": click Allow.`;
  }
  if (/-25211|-1719|assistive access|not allowed to send keystrokes|accessibility/i.test(stderr)) return accessibilityStep(nodePath);
  return undefined;
}

/**
 * The one-time Accessibility step for the daemon's node binary, as exact as the TCC entry lets us be:
 * `entry` 'off' = listed but switched off (the case on m5: adding it again does not switch it on).
 */
export function accessibilityStep(nodePath: string, entry?: 'on' | 'off' | 'missing'): string {
  const where = 'On the Mac, open System Settings > Privacy & Security > Accessibility';
  const why = "macOS has not given the daemon Accessibility access, which reading and pressing Unity's dialogs needs.";
  const which = `(It is the node binary the SketchUp Factory daemon runs under, ${nodePath}; macOS checks that exact path, so after a node upgrade it has to be added again.)`;
  if (entry === 'off') return `${why} ${where}: "node" is listed but its switch is OFF; turn it ON (adding it again does not switch it on). ${which}`;
  if (entry === 'missing') return `${why} ${where}, click +, press Cmd-Shift-G, enter ${nodePath}, add it and turn it on. ${which}`;
  return `${why} ${where}. If "node" is listed, turn its switch ON (an entry that is there but off is still denied). If it is not, click +, press Cmd-Shift-G, enter ${nodePath}, add it and turn it on. ${which}`;
}

/** Whether the console session can be looked at: locked, someone else's (fast user switching), display asleep. */
export interface SessionState {
  locked?: boolean;
  onConsole?: boolean;
  displayAsleep?: boolean;
}

/**
 * The console session's state (CGSessionCopyCurrentDictionary: CGSSessionScreenIsLocked,
 * kCGSSessionOnConsoleKey; CGDisplayIsAsleep). While the screen is locked or the display asleep, System
 * Events can fail in ways that look like a missing permission; the watch pauses instead.
 */
export const SESSION_SCRIPT = `
ObjC.import('CoreGraphics');
var out = {};
try {
  var d = ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary()));
  if (d) { out.locked = !!d.CGSSessionScreenIsLocked; out.onConsole = d.kCGSSessionOnConsoleKey !== false && d.kCGSSessionOnConsoleKey !== 0; }
} catch (e) {}
try { out.displayAsleep = !!$.CGDisplayIsAsleep($.CGMainDisplayID()); } catch (e) {}
JSON.stringify(out);`;

/**
 * Ask macOS to prompt for Accessibility (AXIsProcessTrustedWithOptions with kAXTrustedCheckOptionPrompt): it shows
 * its own dialog on the Mac's screen, pointing at System Settings > Privacy & Security > Accessibility for the
 * process macOS holds responsible (the daemon's node), so the user only has to switch it on.
 */
export const AX_PROMPT_SCRIPT = `ObjC.import('ApplicationServices'); $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true })) ? 'true' : 'false';`;

export async function axPrompt(): Promise<void> {
  if (process.platform !== 'darwin') return;
  await run('osascript', ['-l', 'JavaScript', '-e', AX_PROMPT_SCRIPT], { timeoutMs: 15_000 });
}

/**
 * The Accessibility entry for `binary` in the system TCC database, read-only: 'on', 'off' (listed but switched
 * off: still denied), 'missing', or undefined when it cannot be read (the daemon usually lacks Full Disk Access).
 */
export async function tccAccessibility(binary: string): Promise<'on' | 'off' | 'missing' | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const db = '/Library/Application Support/com.apple.TCC/TCC.db';
  const q = `select auth_value from access where service='kTCCServiceAccessibility' and client='${binary.replace(/'/g, "''")}'`;
  const r = await run('sqlite3', ['-readonly', db, q], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  const v = r.stdout.trim();
  return v === '' ? 'missing' : v === '2' ? 'on' : 'off';
}

/** Whether this process (and so the daemon, responsible for its osascript) has Accessibility: AXIsProcessTrusted. */
export const AX_TRUSTED_SCRIPT = `ObjC.import('ApplicationServices'); $.AXIsProcessTrusted() ? 'true' : 'false';`;

export async function sessionState(): Promise<SessionState> {
  if (process.platform !== 'darwin') return {};
  const r = await run('osascript', ['-l', 'JavaScript', '-e', SESSION_SCRIPT], { timeoutMs: 15_000 });
  if (r.code !== 0) return {};
  try {
    return JSON.parse(r.stdout.trim()) as SessionState;
  } catch {
    return {};
  }
}

export async function axTrusted(): Promise<boolean | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const r = await run('osascript', ['-l', 'JavaScript', '-e', AX_TRUSTED_SCRIPT], { timeoutMs: 15_000 });
  const v = r.stdout.trim();
  return r.code === 0 && (v === 'true' || v === 'false') ? v === 'true' : undefined;
}

/** Why the console cannot be looked at now, or undefined. */
export function sessionAway(s: SessionState): string | undefined {
  if (s.locked) return 'the screen is locked';
  if (s.onConsole === false) return 'another user has the console';
  if (s.displayAsleep) return 'the display is asleep';
  return undefined;
}

/** The real path of the node binary running this daemon (what the privacy settings must name). */
export function nodeBinary(): string {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** The dialogs of an editor on this Mac, the windows to close (findClosable), and its main window's title. Throws with osascript's error text. */
export async function listMacDialogs(pid: number): Promise<{ dialogs: Dialog[]; closable?: Dialog[]; mainTitle?: string; windows?: number }> {
  if (process.platform !== 'darwin') return { dialogs: [] };
  const r = await run('osascript', ['-l', 'JavaScript', '-e', LIST_SCRIPT, String(pid)], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `osascript exited ${r.code}`);
  const { windows, mainTitle } = toEditorWindows(pid, JSON.parse(r.stdout.trim() || '[]') as MacWindow[]);
  // No windows at all: System Events has no such app (not a GUI process), which proves nothing either way.
  return { dialogs: findDialogs(windows), closable: findClosable(windows), mainTitle, windows: windows.length };
}

/** Close a window listMacDialogs found closable. Returns whether it was closed. */
export async function closeMacWindow(pid: number, d: Dialog): Promise<boolean> {
  const r = await run('osascript', ['-l', 'JavaScript', '-e', CLOSE_SCRIPT, String(pid), String(Math.floor(d.hwnd / 100)), d.title], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `osascript exited ${r.code}`);
  try {
    return (JSON.parse(r.stdout.trim()) as { closed: boolean }).closed;
  } catch {
    return false;
  }
}

/** Press a button of a dialog listMacDialogs found. Returns whether it was pressed. */
export async function pressMacButton(pid: number, d: Dialog, button: string): Promise<boolean> {
  const index = Math.floor(d.hwnd / 100);
  const sheet = d.hwnd % 100;
  const sig = (d.title || d.text).split('\n')[0].slice(0, 60);
  const r = await run('osascript', ['-l', 'JavaScript', '-e', CLICK_SCRIPT, String(pid), String(index), String(sheet), button, sig], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `osascript exited ${r.code}`);
  try {
    return (JSON.parse(r.stdout.trim()) as { clicked: boolean }).clicked;
  } catch {
    return false;
  }
}
