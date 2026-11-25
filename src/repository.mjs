import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fileLimit = 10_000;
const byteLimit = 32 * 1024 * 1024;

function git(directory, args, { input = '', limit = byteLimit + 2_000_000, remote = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn('git', ['--no-replace-objects', '-C', directory, ...args], {
      env: {
        PATH: process.env.PATH, LC_ALL: 'C', HOME: tmpdir(),
        GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: remote ? 'https' : '',
        GIT_NO_LAZY_FETCH: '1',
      },
      timeout: 60_000,
    });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.stdin.on('error', () => {}); // Git can exit before it consumes a batch.
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 && size <= limit) accept(Buffer.concat(chunks));
      else reject(new Error('Git could not read the requested repository within the intake limits.'));
    });
    child.stdin.end(input);
  });
}

// Remote fetches run in a temporary bare repository. No checkout, filters or hooks.
export async function withRepository(repository, revision, use) {
  if (!revision || revision.startsWith('-') || /[\s\x00-\x1f]/u.test(revision))
    throw new Error('Specify a Git commit, branch, or tag.');
  if (!repository.includes('://')) return use(resolve(repository), revision);
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Use a local Git repository or a public HTTPS Git URL without credentials.');
  const temporary = await mkdtemp(join(tmpdir(), 'first-five-git-'));
  try {
    await git(temporary, ['init', '--bare', '--template=']);
    await git(temporary, ['-c', 'http.followRedirects=false', 'fetch', '--no-tags',
      '--depth=1', '--', url.href, revision], { remote: true });
    return await use(temporary, 'FETCH_HEAD');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// Read blobs from the frozen commit; never import untracked files or apply checkout filters.
export async function sourceFilesAt(repository, revision) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw new Error('Source staging requires a resolved Git object ID.');
  const index = await git(repository, ['ls-tree', '-rlz', revision], { limit: 4 * 1024 * 1024 });
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(index).split('\0').filter(Boolean);
  if (entries.length > fileLimit) throw new RangeError('The repository exceeds the supported file count.');
  let total = 0;
  const files = entries.map(entry => {
    const match = /^(100644|100755) blob ([0-9a-f]+)\s+(\d+)\t([^\x00-\x1f\x7f]+)$/u.exec(entry);
    if (!match || match[4].includes('\\') || match[4].split('/').some(
      part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
      throw new RangeError('Source staging supports regular files and executable files with portable names.');
    const [, mode, oid, length, path] = match;
    total += Number(length);
    return { path, mode, oid, length: Number(length) };
  });
  if (total > byteLimit) throw new RangeError('The source tree exceeds the 32 MiB staging limit.');
  if (!files.length) return [];
  const objects = await git(repository, ['cat-file', '--batch'], { input: files.map(f => f.oid).join('\n') + '\n' });
  let offset = 0;
  return files.map(({ path, mode, oid, length }) => {
    const newline = objects.indexOf(10, offset);
    if (objects.toString('ascii', offset, newline) !== `${oid} blob ${length}` ||
        objects[newline + 1 + length] !== 10) throw new Error('Incomplete Git blob stream.');
    const content = objects.subarray(newline + 1, newline + 1 + length);
    offset = newline + length + 2;
    return { path, content, mode: mode === '100755' ? 0o755 : 0o644 };
  });
}
