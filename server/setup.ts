// One-time host setup: the sandbox root and the base clone every worktree hangs off.
// Safe to re-run; each step is skipped when already done.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { copyTree, must, run } from './proc.ts';

const cfg = loadConfig();
const base = cfg.repo.basePath;
fs.mkdirSync(cfg.sandboxRoot, { recursive: true });
fs.mkdirSync(cfg.dataDir, { recursive: true });

if (!fs.existsSync(path.join(base, '.git'))) {
  const args = ['clone', '--progress', '--no-checkout'];
  // Copy objects from an existing local clone instead of downloading them. --dissociate makes the
  // base independent afterwards, so a gc in the (protected) reference repo can never corrupt it.
  if (cfg.repo.referenceRepo && fs.existsSync(path.join(cfg.repo.referenceRepo, '.git'))) {
    // git refuses a shallow clone as a reference ("reference repository ... is shallow"): clone from origin then.
    if (fs.existsSync(path.join(cfg.repo.referenceRepo, '.git', 'shallow'))) console.log(`${cfg.repo.referenceRepo} is a shallow clone, so its objects cannot be borrowed; cloning from origin`);
    else args.push('--reference', cfg.repo.referenceRepo, '--dissociate');
  }
  args.push(cfg.repo.url, base);
  console.log(`git ${args.join(' ')}`);
  await must('git', args, { timeoutMs: 4 * 60 * 60_000 });
  // --reference does not cover LFS; copy the reference's LFS store so checkout does not re-download it.
  const refLfs = cfg.repo.referenceRepo && path.join(cfg.repo.referenceRepo, '.git', 'lfs', 'objects');
  if (refLfs && fs.existsSync(refLfs)) {
    console.log(`copying LFS objects from ${refLfs}`);
    fs.mkdirSync(path.join(base, '.git', 'lfs'), { recursive: true });
    await copyTree(refLfs, path.join(base, '.git', 'lfs', 'objects'));
  }
} else {
  console.log(`base clone exists: ${base}`);
}

await run('git', ['-C', base, 'lfs', 'install', '--local']);
await must('git', ['-C', base, 'fetch', '--prune', 'origin'], { timeoutMs: 60 * 60_000 });
const branch = cfg.defaultBase.replace(/^origin\//, '');
await run('git', ['-C', base, 'checkout', '--detach', `origin/${branch}`]);
console.log(`base clone at origin/${branch}`);

if (cfg.librarySeed && !fs.existsSync(cfg.librarySeed)) {
  console.warn(`WARNING: librarySeed ${cfg.librarySeed} does not exist; new sandboxes will import Unity from cold (30-60 min).`);
}
const unity = cfg.unity.editorPath.includes('{version}') ? path.dirname(path.dirname(cfg.unity.editorPath.split('{version}')[0])) : cfg.unity.editorPath;
if (unity && !fs.existsSync(unity)) console.warn(`WARNING: Unity editor path ${unity} not found.`);
console.log('setup done.');
