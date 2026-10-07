import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_SCRIPT, macPermissionProblem, macWindowId, toEditorWindows, type MacWindow } from '../machine/macDialogs.ts';
import { MacUnity, MacUnityWatch, editorsFor, type Proc, type UnityDeps } from '../machine/unity.ts';
import { findDialogs, type Dialog } from './watchdog.ts';

const REPO = '/Users/u/games/MyGame';
const BIN = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';
const MAIN: MacWindow = { index: 1, title: 'MyGame - Main - macOS - Unity 6000.3.19f1 <Metal>', subrole: 'AXStandardWindow', text: [], buttons: [] };

/** An NSAlert as System Events shows it: no window title, the message then the informative text. */
const alert = (index: number, text: string[], buttons: string[]): MacWindow => ({ index, title: '', subrole: 'AXDialog', text, buttons });

test('mac dialogs: alerts and sheets become dialogs matched by the shared rule table', () => {
  const wins: MacWindow[] = [
    MAIN,
    { index: 2, title: 'Inspector', subrole: 'AXFloatingWindow', text: [], buttons: [] },
    alert(3, ['Repair FMOD Libraries', 'The following FMOD libraries contain incorrect line endings, and need to be repaired:'], ['Repair', 'Ignore']),
    { index: 1, sheet: 1, title: '', subrole: 'AXSheet', text: ['Addressables Build Report', "There's a new Addressables Build Report you can check out after your content build.  However, this requires that 'Debug Build Layout' is turned on."], buttons: ['Yes', 'No'] },
    alert(4, ['Hold on'], ['Cancel']), // a progress window: not a question
  ];
  const { windows, mainTitle } = toEditorWindows(42, wins);
  assert.equal(mainTitle, MAIN.title);
  const ds = findDialogs(windows);
  assert.deepEqual(
    ds.map((d) => [d.hwnd, d.title, d.known?.id]),
    [
      [300, 'Repair FMOD Libraries', 'fmod-line-endings'],
      [101, 'Addressables Build Report', 'addressables-build-report'],
    ],
  );
  assert.equal(macWindowId({ index: 7, sheet: 2 }), 702);
  assert.match(LIST_SCRIPT, /unixId: pid/);
});

test('mac dialogs: a missing privacy permission becomes the one-time step to take', () => {
  const node = '/opt/homebrew/Cellar/node/24.1.0/bin/node';
  const ax = macPermissionProblem("execution error: Error: Error: System Events got an error: osascript is not allowed assistive access. (-25211)", node);
  assert.match(ax ?? '', /Privacy & Security > Accessibility.*\/opt\/homebrew\/Cellar\/node\/24\.1\.0\/bin\/node/);
  const ae = macPermissionProblem('execution error: Error: Error: Not authorized to send Apple events to System Events. (-1743)', node);
  assert.match(ae ?? '', /Privacy & Security > Automation.*"System Events"/);
  assert.equal(macPermissionProblem('execution error: Error: Can\'t get object. (-1728)', node), undefined);
});

/** A Mac with one editor of the clone and scripted dialogs. */
function macWithDialogs() {
  const world = { now: Date.parse('2026-09-24T16:00:00Z'), procs: [{ pid: 100, ppid: 1, cmd: `${BIN} -projectpath ${REPO}` }] as Proc[], wins: [MAIN] as MacWindow[], pressed: [] as string[], clean: true, listError: '' };
  const deps: UnityDeps = {
    procs: async () => [...world.procs],
    kill: () => undefined,
    launch: () => 1,
    exists: () => false,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  const reports: string[] = [];
  const u = new MacUnity(REPO, deps, () => BIN);
  const w = new MacUnityWatch(u, (t) => reports.push(t), {
    logStat: () => ({ size: 1, mtimeMs: world.now }),
    logTail: () => '',
    bridge: () => ({}),
    ping: async () => false,
    now: () => world.now,
    listDialogs: async (pid) => {
      if (world.listError) throw new Error(world.listError);
      const { windows, mainTitle } = toEditorWindows(pid, world.wins);
      return { dialogs: findDialogs(windows), mainTitle };
    },
    pressButton: async (_pid, d: Dialog, button) => {
      world.pressed.push(`${d.title} -> ${button}`);
      world.wins = world.wins.filter((x) => macWindowId(x) !== d.hwnd);
      return true;
    },
    sceneFilesClean: async () => world.clean,
    nodePath: () => '/usr/local/bin/node',
    // Never the real Mac's session, Accessibility, TCC database or prompt: a locked screen there would pause the watch.
    sessionState: async () => ({}),
    axTrusted: async () => false,
    tccEntry: async () => undefined,
    axPrompt: async () => undefined,
  });
  return { world, w, reports };
}

test('mac dialog watch: safe answers pressed, the rest reported once and shown in the status', async () => {
  const { world, w, reports } = macWithDialogs();
  world.wins.push(alert(2, ['Enter Safe Mode?', 'The project you are opening contains compilation errors.'], ['Enter Safe Mode', 'Ignore', 'Quit']));
  world.wins.push(alert(3, ['Addressables Build Report', "However, this requires that 'Debug Build Layout' is turned on."], ['Yes', 'No']));
  await w.tick();
  assert.deepEqual(world.pressed, ['Enter Safe Mode? -> Ignore', 'Addressables Build Report -> No']);
  assert.match(w.describe(), /auto-answered in the last hour: "Enter Safe Mode\?" -> Ignore/);
  // Scene backups: No only while no scene file has uncommitted changes; otherwise a person decides.
  world.clean = false;
  world.wins.push(alert(2, ['Recovering Scene Backups', 'Scene backups from a previous Editor session have been detected.'], ['Yes', 'No']));
  await w.tick();
  await w.tick();
  assert.equal(world.pressed.length, 2);
  assert.equal(reports.filter((r) => /Recovering Scene Backups/.test(r)).length, 1, 'reported once');
  assert.match(w.describe(), /blocked on a dialog: Recovering Scene Backups/);
  world.clean = true;
  await w.tick();
  assert.equal(world.pressed.at(-1), 'Recovering Scene Backups -> No');
  // Scenes changed on disk: Reload when the scene files are clean.
  world.wins.push(alert(2, ['The open scene(s) have been modified externally', 'The following open scene(s) have been changed on disk: Assets/Scenes/Main.unity Do you want to reload the scene(s)?'], ['Reload', 'Ignore']));
  await w.tick();
  assert.equal(world.pressed.at(-1), 'The open scene(s) have been modified externally -> Reload');
  // An unknown dialog: reported when it is still there on the next look, once.
  world.wins.push(alert(2, ['Something odd', 'Continue?'], ['OK', 'Cancel']));
  await w.tick();
  assert.equal(reports.filter((r) => /Something odd/.test(r)).length, 0);
  assert.match(w.describe(), /dialog \(checking\): Something odd/);
  await w.tick();
  await w.tick();
  assert.equal(reports.filter((r) => /Something odd/.test(r)).length, 1);
  // An editor waiting on a dialog is never restarted as hung, however long it waits.
  world.now += 60 * 60_000;
  assert.equal(await w.tick(), 'ok');
});

test('mac dialog watch: without Accessibility it says what to grant, only once it lasts (3 looks, 15 min), and notices when it is fixed', async () => {
  const { world, w, reports } = macWithDialogs();
  world.listError = 'osascript is not allowed assistive access. (-25211)';
  for (let i = 0; i < 3; i++) {
    await w.tick();
    world.now += 5 * 60_000;
  }
  assert.equal(reports.length, 0, '3 looks but only 10 minutes: not yet');
  await w.tick();
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Accessibility.*\/usr\/local\/bin\/node/);
  assert.match(w.describe(), /dialog watch off: .*Accessibility/);
  world.listError = '';
  await w.tick();
  assert.match(reports.at(-1)!, /can see the editor's windows again/);
  assert.doesNotMatch(w.describe(), /dialog watch off/);
});

test('mac dialog watch: the licensing "Connection Lost" is retried, and the 4th time within 10 min gets a fresh editor', async () => {
  const { world, w, reports } = macWithDialogs();
  const lost = () => world.wins.push(alert(2, ['Connection Lost', 'The connection with the Unity Licensing Client has been lost.'], ['Retry']));
  for (let i = 0; i < 3; i++) {
    lost();
    assert.equal(await w.tick(), 'ok');
    world.now += 2 * 60_000;
  }
  assert.equal(world.pressed.filter((p) => p.endsWith('-> Retry')).length, 3);
  lost();
  assert.equal(await w.tick(), 'restarted');
  assert.match(reports.at(-1)!, /keeps showing a dialog: "Connection Lost" came back 4 times within 10 minutes/);
});

test('mac dialog watch: a locked screen pauses it (one notice a day), a permission is reported only when AXIsProcessTrusted says so', async () => {
  const world = { now: Date.parse('2026-09-25T16:00:00Z'), locked: false, trusted: true as boolean | undefined, fail: '', noWindows: false };
  const reports: string[] = [];
  const deps: UnityDeps = {
    procs: async () => [{ pid: 100, ppid: 1, cmd: `${BIN} -projectpath ${REPO}` }],
    kill: () => undefined,
    launch: () => 1,
    exists: () => false,
    remove: () => undefined,
    sleep: async () => undefined,
    now: () => world.now,
  };
  const w = new MacUnityWatch(new MacUnity(REPO, deps, () => BIN), (t) => reports.push(t), {
    logStat: () => ({ size: 1, mtimeMs: world.now }),
    logTail: () => '',
    bridge: () => ({}),
    ping: async () => false,
    now: () => world.now,
    listDialogs: async () => {
      if (world.fail) throw new Error(world.fail);
      return world.noWindows ? { dialogs: [], windows: 0 } : { dialogs: [], mainTitle: MAIN.title, windows: 1 };
    },
    pressButton: async () => true,
    sceneFilesClean: async () => true,
    nodePath: () => '/usr/local/bin/node',
    sessionState: async () => ({ locked: world.locked }),
    axTrusted: async () => world.trusted,
    tccEntry: async () => undefined,
    axPrompt: async () => undefined,
  });
  const tick = async (min = 1) => {
    await w.tick();
    world.now += min * 60_000;
  };
  // Screen locked: System Events fails with an "assistive access" error, but it is the lock.
  world.locked = true;
  world.fail = 'System Events got an error: osascript is not allowed assistive access. (-25211)';
  await tick();
  await tick();
  assert.deepEqual(reports, ['Unity dialog watch on this machine is paused: the screen is locked. It resumes by itself when someone is back at the screen.']);
  assert.match(w.describe(), /dialog watch paused: the screen is locked/);
  // Unlocked: it works again, and there is no "can see again" (no permission was ever missing).
  world.locked = false;
  world.fail = '';
  await tick();
  assert.equal(reports.length, 1);
  assert.doesNotMatch(w.describe(), /paused|off/);
  // Locked again within the hour: no second notice (the flapping).
  world.locked = true;
  world.fail = 'error (-1719)';
  await tick(10);
  world.locked = false;
  world.fail = '';
  await tick();
  assert.equal(reports.length, 1);
  // A permission-looking error with the screen unlocked while Accessibility IS granted: a passing failure.
  world.fail = 'osascript is not allowed assistive access. (-25211)';
  await tick();
  assert.equal(reports.length, 1);
  // Really missing: reported once it has lasted (3 looks over 15 min), then not again within the day.
  world.trusted = false;
  await tick(8);
  await tick(8);
  assert.equal(reports.length, 1, 'two looks: not yet');
  await tick(8);
  assert.equal(reports.length, 2);
  assert.match(reports[1], /cannot read Unity's dialogs: macOS has not given the daemon Accessibility access.*If "node" is listed, turn its switch ON/);
  // A look that sees no windows at all (System Events does not know the pid) proves nothing: no "again".
  world.fail = '';
  world.noWindows = true;
  await tick();
  assert.equal(reports.length, 2);
  world.noWindows = false;
  await tick();
  assert.equal(reports.at(-1), "Unity dialog watch on this machine can see the editor's windows again.");
  world.fail = 'osascript is not allowed assistive access. (-25211)';
  for (let i = 0; i < 6; i++) await tick(10);
  assert.equal(reports.length, 3, 'the permission notice not again within the day');
});

test('mac unity: the editor is the Unity with windows, never its -batchMode import workers or a command-line build', () => {
  const procs: Proc[] = [
    { pid: 72362, ppid: 24358, cmd: `${BIN} -adb2 -batchMode -noUpm -name AssetImportWorker0 -projectPath ${REPO} -logFile Logs/AssetImportWorker0.log` },
    { pid: 24358, ppid: 1, cmd: `${BIN} -projectPath ${REPO}` },
    { pid: 80000, ppid: 1, cmd: `${BIN} -batchmode -quit -nographics -projectPath ${REPO} -executeMethod Build.Run` },
  ];
  assert.deepEqual(editorsFor(procs, REPO).map((p) => p.pid), [24358]);
});

test('mac dialog watch: an Accessibility entry that is listed but OFF says so, and macOS shows its own prompt once', async () => {
  const { accessibilityStep } = await import('../machine/macDialogs.ts');
  const node = '/opt/homebrew/Cellar/node/26.5.0/bin/node';
  assert.match(accessibilityStep(node, 'off'), /"node" is listed but its switch is OFF; turn it ON \(adding it again does not switch it on\)\..*\/opt\/homebrew\/Cellar\/node\/26\.5\.0\/bin\/node; macOS checks that exact path/);
  assert.match(accessibilityStep(node, 'missing'), /click \+, press Cmd-Shift-G, enter \/opt\/homebrew\/Cellar/);
  const world = { now: Date.parse('2026-09-26T14:00:00Z'), prompts: 0 };
  const reports: string[] = [];
  const deps: UnityDeps = { procs: async () => [{ pid: 100, ppid: 1, cmd: `${BIN} -projectpath ${REPO}` }], kill: () => undefined, launch: () => 1, exists: () => false, remove: () => undefined, sleep: async () => undefined, now: () => world.now };
  const w = new MacUnityWatch(new MacUnity(REPO, deps, () => BIN), (t) => reports.push(t), {
    logStat: () => ({ size: 1, mtimeMs: world.now }),
    logTail: () => '',
    bridge: () => ({}),
    ping: async () => false,
    now: () => world.now,
    listDialogs: async () => {
      throw new Error('execution error: Error: Error: osascript is not allowed assistive access. (-25211)');
    },
    pressButton: async () => true,
    sceneFilesClean: async () => true,
    nodePath: () => node,
    sessionState: async () => ({ locked: false, onConsole: true, displayAsleep: false }),
    axTrusted: async () => false,
    tccEntry: async () => 'off',
    axPrompt: async () => void world.prompts++,
  });
  for (let i = 0; i < 6; i++) {
    await w.tick();
    world.now += 8 * 60_000;
  }
  assert.equal(reports.length, 1);
  assert.match(reports[0], /"node" is listed but its switch is OFF.*macOS also shows its own Accessibility prompt/);
  assert.equal(world.prompts, 1, 'the prompt once, with the notice');
});
