import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeMemoryGit, githubKey, versionMemory } from './memoryGit.ts';
import { backupMemory, memoryBackupRoot } from './orchestratorMemory.ts';

/**
 * The orchestrators' memory in a private repository (docs/orchestrators.md, "Memory in a private repository"; w208):
 * one person's preference files are versioned, and never reach a public repo. Real git, in temp folders.
 */

const IDENTITY = { name: 'FF Factory', email: 'ff-factory@users.noreply.github.com' };
// Fake secrets are put together at run time, so the repo's own secret scan (gitleaks) does not flag this file.
const TOKEN = ['ghp_', 'a'.repeat(36)].join('');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A memory root that is a repository, with a bare repository beside it as origin. */
function world(t: { after: (fn: () => void) => void }, o: { origin?: boolean } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-memgit-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(tmp, 'orchestrator-memory');
  const origin = path.join(tmp, 'origin.git');
  fs.mkdirSync(path.join(root, 'person-ben'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  if (o.origin !== false) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, 'remote', 'add', 'origin', origin);
  }
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const inOrigin = () => {
    try {
      return git(origin, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { tmp, root, origin, write, inOrigin };
}

const PRIVATE = { isPrivate: () => true, identity: IDENTITY };

test('a memory root that is no repository is left alone, and so is one that only sits inside a repository', async (t) => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-memgit-plain-')));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true, maxRetries: 3 }));
  fs.writeFileSync(path.join(plain, 'MEMORY.md'), '- a');
  assert.equal((await versionMemory(plain, PRIVATE)).state, 'not-a-repo');
  // The default root is a folder of the app's own checkout: the app's repository must never get memory commits.
  git(plain, 'init', '-q', '-b', 'main');
  const nested = path.join(plain, 'data', 'orchestrator-memory');
  fs.mkdirSync(path.join(nested, 'person-ben'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'person-ben', 'MEMORY.md'), '- a');
  assert.equal((await versionMemory(nested, PRIVATE)).state, 'not-a-repo');
  assert.equal(git(plain, 'status', '--porcelain', '--untracked-files=all').includes('A '), false, 'nothing was staged in the outer repository');
  assert.equal(describeMemoryGit({ state: 'not-a-repo', files: [], held: [] }), undefined);
});

test('changed Markdown files are committed and pushed to a private origin; nothing else is', async (t) => {
  const { root, write, inOrigin } = world(t);
  write('person-ben/MEMORY.md', '- [Paste text plain](paste.md)');
  write('person-ben/paste.md', 'Plain text, no code block.');
  write('dispatcher/MEMORY.md', '- nothing yet');
  write('person-ben/notes.txt', 'not memory');
  const first = await versionMemory(root, PRIVATE);
  assert.equal(first.state, 'pushed');
  assert.deepEqual(first.files.sort(), ['dispatcher/MEMORY.md', 'person-ben/MEMORY.md', 'person-ben/paste.md']);
  assert.deepEqual(inOrigin(), ['dispatcher/MEMORY.md', 'person-ben/MEMORY.md', 'person-ben/paste.md']);
  assert.equal(git(root, 'log', '-1', '--format=%s|%an|%ae'), 'memory: dispatcher, person-ben (3 files)|FF Factory|ff-factory@users.noreply.github.com');
  assert.equal(describeMemoryGit(first), 'orchestrator memory: committed and pushed 3 file(s)');
  assert.equal((await versionMemory(root, PRIVATE)).state, 'clean');
  // An edit and a removal are one more commit.
  write('person-ben/paste.md', 'Plain text, no code block, his voice.');
  fs.rmSync(path.join(root, 'dispatcher', 'MEMORY.md'));
  const second = await versionMemory(root, PRIVATE);
  assert.equal(second.state, 'pushed');
  assert.deepEqual(inOrigin(), ['person-ben/MEMORY.md', 'person-ben/paste.md']);
  assert.equal(git(root, 'log', '--format=%s').split('\n').length, 2);
});

test('never pushed to a public origin, or to one whose visibility nobody could confirm', async (t) => {
  const { root, write, inOrigin } = world(t);
  write('person-ben/MEMORY.md', '- a');
  const open = await versionMemory(root, { isPrivate: () => false, identity: IDENTITY });
  assert.equal(open.state, 'committed');
  assert.match(open.detail!, /is public: memory is never pushed to a public repository/);
  assert.deepEqual(inOrigin(), []);
  write('person-ben/MEMORY.md', '- a\n- b');
  const unknown = await versionMemory(root, { isPrivate: () => undefined, identity: IDENTITY });
  assert.equal(unknown.state, 'committed');
  assert.match(unknown.detail!, /could not confirm that origin .* is private: not pushed/);
  assert.deepEqual(inOrigin(), []);
  assert.match(describeMemoryGit(unknown)!, /1 file\(s\) committed, NOT pushed/);
  // Once the remote is known to be private, what waited goes out without a new change.
  const later = await versionMemory(root, PRIVATE);
  assert.equal(later.state, 'pushed');
  assert.deepEqual(later.files, []);
  assert.deepEqual(inOrigin(), ['person-ben/MEMORY.md']);
  assert.equal(describeMemoryGit(later), 'orchestrator memory: committed and pushed earlier commits');
});

test('the default check asks GitHub: a remote that is not a GitHub repository is never pushed to', async (t) => {
  const { root, write, inOrigin } = world(t);
  write('person-ben/MEMORY.md', '- a');
  const r = await versionMemory(root, { identity: IDENTITY });
  assert.equal(r.state, 'committed');
  assert.deepEqual(inOrigin(), []);
  for (const url of ['https://github.com/Final-Factory/ff-memory.git', 'https://x-access-token@github.com/Final-Factory/ff-memory', 'git@github.com:Final-Factory/ff-memory.git', 'ssh://git@github.com/Final-Factory/ff-memory.git'])
    assert.equal(githubKey(url), 'github.com/Final-Factory/ff-memory', url);
  for (const url of ['https://gitlab.com/a/b.git', 'C:/repos/origin.git', '/srv/git/origin.git', 'https://github.com/only-owner'])
    assert.equal(githubKey(url), undefined, url);
});

test('a file with a secret in it is held back; the rest still goes', async (t) => {
  const { root, write, inOrigin } = world(t);
  write('person-ben/MEMORY.md', '- a');
  write('person-ben/keys.md', `the token is ${TOKEN}`);
  const r = await versionMemory(root, PRIVATE);
  assert.equal(r.state, 'pushed');
  assert.deepEqual(r.files, ['person-ben/MEMORY.md']);
  assert.deepEqual(r.held, ['person-ben/keys.md (a GitHub token)']);
  assert.deepEqual(inOrigin(), ['person-ben/MEMORY.md']);
  assert.match(describeMemoryGit(r)!, /held back: person-ben\/keys\.md \(a GitHub token\)/);
  // Alone, it is not committed at all.
  const again = await versionMemory(root, PRIVATE);
  assert.equal(again.state, 'held');
  assert.equal(git(root, 'log', '--format=%s').split('\n').length, 1);
});

test('no origin: committed here only. The repository keeps its own identity when it has one', async (t) => {
  const { root, write } = world(t, { origin: false });
  git(root, 'config', 'user.name', 'Memory Owner');
  git(root, 'config', 'user.email', 'owner@users.noreply.github.com');
  write('person-ben/MEMORY.md', '- a');
  const r = await versionMemory(root, PRIVATE);
  assert.equal(r.state, 'committed');
  assert.match(r.detail!, /no remote named origin/);
  assert.equal(git(root, 'log', '-1', '--format=%an|%ae'), 'Memory Owner|owner@users.noreply.github.com');
});

test('the crash backup of a memory root that is a repository leaves .git out', (t) => {
  const { root, write } = world(t);
  write('person-ben/MEMORY.md', '- a');
  assert.equal(backupMemory(root), true);
  const copy = path.join(memoryBackupRoot(root), '1');
  assert.ok(fs.existsSync(path.join(copy, 'person-ben', 'MEMORY.md')));
  assert.equal(fs.existsSync(path.join(copy, '.git')), false);
});
