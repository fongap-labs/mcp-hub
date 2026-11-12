import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { gitCommand, worktreeKey } from './git-worktree-preparer.mjs';

const REPO = /^fongap-labs\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^task_[a-f0-9]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function safePath(path) {
  if (!path || isAbsolute(path) || path.startsWith('-') ||
      /[\x00-\x1f\x7f]/.test(path) ||
      path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ||
      path.split('/').some(p => p.toLowerCase() === '.github') &&
        /^\.github\/(?:workflows|actions)\//i.test(path) ||
      /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.gitmodules)$/i.test(path) ||
      /\.(?:pem|key|p12|pfx)$/i.test(path)) {
    throw new Error('delivery_path_disallowed');
  }
  return path;
}
function strictDirectory(path) {
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new Error('delivery_workspace_symlink');
  }
}
function fileContent(worktree, path) {
  let segment = worktree;
  const pieces = path.split('/');
  for (const piece of pieces.slice(0, -1)) {
    segment = join(segment, piece);
    if (!lstatSync(segment).isDirectory() || lstatSync(segment).isSymbolicLink()) {
      throw new Error('delivery_symlink_disallowed');
    }
  }
  const file = join(worktree, path);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    throw new Error('delivery_file_disallowed');
  }
  const contents = readFileSync(file);
  if (contents.length > MAX_FILE_BYTES || contents.includes(0)) {
    throw new Error('delivery_file_disallowed');
  }
  try { decoder.decode(contents); } catch { throw new Error('delivery_binary_disallowed'); }
  return contents;
}

/**
 * Collect the exact post-Coding Engine changes without running arbitrary
 * shell commands or editing the worktree. Refuse renamed files, symlinks,
 * submodules, workflow injection, secrets, excessive and binary payloads.
 */
export function collectApprovedWorktreeChanges({
  taskRef, repository, sourceSha, workspaceRoots, runGit = gitCommand,
}) {
  if (!REF.test(taskRef) || !REPO.test(repository) || !SHA.test(sourceSha) ||
      !workspaceRoots || typeof workspaceRoots !== 'object' ||
      typeof workspaceRoots[repository] !== 'string' ||
      !isAbsolute(workspaceRoots[repository])) {
    throw new TypeError('invalid_delivery_task');
  }
  const base = resolve(workspaceRoots[repository]);
  const root = base + '.worktrees';
  const key = worktreeKey(taskRef);
  const worktree = join(root, key);
  strictDirectory(base);
  strictDirectory(root);
  strictDirectory(worktree);
  if (!worktree.startsWith(root + sep)) throw new Error('delivery_workspace_outside_root');

  const origin = runGit(base, ['remote','get-url','origin']);
  if (origin !== 'https://github.com/' + repository + '.git') {
    throw new Error('delivery_unapproved_origin');
  }
  const common = runGit(base, ['rev-parse','--path-format=absolute','--git-common-dir']);
  const childCommon = runGit(worktree, ['rev-parse','--path-format=absolute','--git-common-dir']);
  const top = runGit(worktree, ['rev-parse','--show-toplevel']);
  const branch = 'agent/task-' + key;
  if (resolve(common) !== resolve(childCommon) || resolve(top) !== worktree ||
      runGit(worktree, ['symbolic-ref','--quiet','--short','HEAD']) !== branch ||
      runGit(worktree, ['rev-parse','HEAD']) !== sourceSha) {
    throw new Error('delivery_worktree_integrity_mismatch');
  }
  const raw = runGit(worktree, ['status','--porcelain=v1','-z','--untracked-files=all'], { binary: true });
  if (!Buffer.isBuffer(raw)) throw new TypeError('delivery_git_binary_required');
  const parts = raw.length ? raw.subarray(raw.length - 1).includes(0) && raw.at(-1) === 0
    ? raw.subarray(0, -1).toString('binary').split('\0')
    : null : [];
  if (parts === null) throw new Error('delivery_git_status_invalid');
  if (parts.length > MAX_FILES) throw new Error('delivery_too_many_files');
  const changes = [];
  let total = 0;
  for (const part of parts) {
    const bytes = Buffer.from(part, 'binary');
    let entry;
    try { entry = decoder.decode(bytes); } catch { throw new Error('delivery_path_disallowed'); }
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('delivery_git_status_invalid');
    const status = entry.slice(0, 2);
    if (![' M',' D','??'].includes(status)) throw new Error('delivery_git_status_disallowed');
    const path = safePath(entry.slice(3));
    if (changes.some(change => change.path === path)) throw new Error('delivery_duplicate_file');
    if (status === ' D') {
      changes.push({ path, mode: '100644', sha: null });
      continue;
    }
    const contents = fileContent(worktree, path);
    total += contents.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('delivery_payload_too_large');
    // Treat executable files as 100755 only when already executable in HEAD.
    const indexed = runGit(worktree, ['ls-files','--stage','--',path]);
    const mode = indexed ? indexed.split(' ')[0] : '100644';
    if (!['100644','100755'].includes(mode)) throw new Error('delivery_file_mode_disallowed');
    changes.push({ path, mode, content: contents.toString('base64') });
  }
  if (!changes.length) throw new Error('delivery_no_changes');
  changes.sort((a,b) => a.path.localeCompare(b.path));
  return { repository, sourceSha, taskRef, branch, changes };
}
