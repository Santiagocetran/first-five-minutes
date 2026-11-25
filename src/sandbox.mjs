import { documentedDownload } from './download.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';

const ROOT = '/vercel/sandbox/checkout';
const BASH = '/bin/bash';
const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', BASH_ENV: '/dev/null', ENV: '/dev/null' };
const nonce = () => randomBytes(16).toString('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const digestImage = /^(?:[a-z0-9._:-]+\/)*[a-z0-9._-]+@sha256:[a-f0-9]{64}$/;
const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class SandboxAdapterError extends Error {
  constructor(message, kind = 'platform') {
    super(message);
    this.name = 'SandboxAdapterError';
    this.kind = kind;
  }
}

const unsupported = message => new SandboxAdapterError(message, 'unsupported');

function provisioningFailure(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403) return new SandboxAdapterError('Vercel denied access to the approved Sandbox project.');
  if (status === 404) return new SandboxAdapterError('Vercel could not resolve the approved project or base image.');
  if (status === 429) return new SandboxAdapterError('Vercel rate-limited sandbox provisioning.');
  if (status >= 400 && status < 500) return new SandboxAdapterError('Vercel rejected the approved sandbox configuration.');
  return new SandboxAdapterError('The Vercel sandbox create operation did not return a confirmed VM.');
}

function safePath(path) {
  return typeof path === 'string' && path.length <= 1024 && !/[\x00-\x1f\x7f\\]/.test(path) &&
    path.split('/').every(piece => piece && !['.', '..', '.git'].includes(piece.toLowerCase()));
}

function prepareFiles(files) {
  if (!Array.isArray(files) || files.length > 10_000) throw unsupported('The source checkout exceeds the supported staging limits.');
  const sha = createHash('sha256');
  let total = 0;
  const seen = new Set();
  const staged = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, content, mode, executable }) => {
    if (!safePath(path) || seen.has(path) || !(content instanceof Uint8Array)) throw unsupported('Invalid staged file path or content in the source checkout.');
    seen.add(path);
    if (mode !== undefined && ![0o644, 0o755, 0o100644, 0o100755, '100644', '100755'].includes(mode)) {
      throw unsupported('Only regular staged files are supported.');
    }
    const permissions = executable || mode === 0o755 || mode === 0o100755 || mode === '100755' ? 0o755 : 0o644;
    total += content.byteLength;
    if (total > 32 * 1024 * 1024) throw unsupported('The staged checkout exceeds 32 MiB.');
    const copy = Buffer.from(content);
    sha.update(JSON.stringify([path, permissions, createHash('sha256').update(copy).digest('hex')]) + '\n');
    return { path: ROOT + '/' + path, content: copy, mode: permissions };
  });
  return { staged, identity: 'sha256:' + sha.digest('hex') };
}

const probeFile = String.raw`
  file=$1
  root=$2
  if [[ -L $file ]]; then exit 12; fi
  canonical=$(realpath -m -- "$file") || exit 12
  [[ $canonical == "$root/"* ]] || exit 12
  if [[ ! -e $file ]]; then
    parent=$(/usr/bin/dirname -- "$canonical") || exit 12
    while [[ ! -e $parent && $parent != "$root" ]]; do
      parent=$(/usr/bin/dirname -- "$parent") || exit 12
    done
    [[ -d $parent && -x $parent ]] || exit 12
    exit 11
  fi
  [[ -f $file && -r $file ]] || exit 12
  [[ $3 == presence ]] && exit 10
  size=$(stat -c %s -- "$file") || exit 12
  (( size <= 1048576 )) || exit 12
  LC_ALL=C grep -aFq -e "$4" -- "$file"
  case $? in (0) exit 10;; (1) exit 11;; (*) exit 12;; esac
`;

const probeHttp = String.raw`
  body=$(mktemp /tmp/ffm-check.XXXXXXXX) || exit 12
  trap 'rm -f -- "$body"' EXIT
  status=$(curl -q --globoff --noproxy '*' --proto '=http' --connect-timeout 1 --max-time 2 --max-filesize 65536 \
    --silent --output "$body" --write-out '%{http_code}' -- "$1")
  case $? in (0) ;; (7) exit 11;; (*) exit 12;; esac
  [[ $2 == any || $status == "$2" ]] || exit 11
  [[ $3 == presence ]] && exit 10
  LC_ALL=C grep -aFq -e "$4" -- "$body"
  case $? in (0) exit 10;; (1) exit 11;; (*) exit 12;; esac
`;

function checkArguments(check, precondition) {
  const presenceOnly = precondition && check.precondition !== 'unmet';
  const contains = presenceOnly ? undefined : check.contains;
  if (contains !== undefined && (typeof contains !== 'string' || !contains || contains.length > 1024 || /[\r\n\0]/.test(contains))) {
    throw new Error('Unsupported observer literal.');
  }
  const matchMode = contains === undefined ? 'presence' : 'contains';
  if (check.kind === 'file' && safePath(check.path)) {
    return [probeFile, ROOT + '/' + check.path, ROOT, matchMode, contains ?? ''];
  }
  if (check.kind === 'http') {
    const url = new URL(check.url);
    const status = presenceOnly ? 'any' : String(check.status ?? 200);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.hash || !/^(any|[1-5]\d\d)$/.test(status) || url.href.length > 2048) {
      throw new Error('Unsupported observer URL.');
    }
    return [probeHttp, url.href, status, matchMode, contains ?? ''];
  }
  throw new Error('Unsupported observer.');
}

function verifyNetwork(actual, approved) {
  if (approved === 'deny-all') return actual === 'deny-all';
  if (!actual || Object.keys(actual).some(key => key !== 'allow')) return false;
  const actualHosts = Array.isArray(actual.allow) ? actual.allow : Object.entries(actual.allow ?? {})
    .filter(([, rules]) => Array.isArray(rules) && rules.length === 0).map(([name]) => name);
  return actualHosts.length === approved.allow.length && approved.allow.every(host => actualHosts.includes(host)) &&
    (Array.isArray(actual.allow) || Object.keys(actual.allow ?? {}).length === actualHosts.length);
}

function sessionShell(command, logLimit, aborter) {
  let pending;
  let closed = false;
  async function collect() {
    try {
      for await (const log of command.logs({ signal: aborter.signal })) {
        const step = pending;
        if (!step) continue;
        const data = String(log.data);
        step.logBytes += Buffer.byteLength(data);
        if (step.logBytes > logLimit + 64) {
          pending = undefined;
          closed = true;
          step.reject(new Error('Sandbox log limit exceeded.'));
          aborter.abort();
          return;
        }
        step.output += data;
        if (log.stream !== 'stdout') continue;
        // stdout includes the record delimiter. Only a per-command random marker can close this step.
        step.stdout += data;
        const match = step.marker.exec(step.stdout);
        if (match) {
          pending = undefined;
          step.resolve({
            exitCode: Number(match[1]), output: step.output.replace(match[0], '').trimEnd(),
            startedService: step.service && match[2] === 'S',
          });
        }
      }
    } catch {
      // EOF or transport error without a marker gives no confirmed step result.
    } finally {
      closed = true;
      pending?.reject(new Error('Sandbox shell no longer reports results.'));
      pending = undefined;
    }
  }
  void collect();
  return async (cmd, { mode, signal }) => {
    signal.throwIfAborted();
    if (pending || closed) throw new Error('Sandbox shell unavailable.');
    const id = 'ffm_' + nonce();
    const service = mode === 'service';
    const reply = new Promise((resolve, reject) => {
      pending = { resolve, reject, marker: new RegExp('(?:^|\\n)' + id + ':(\\d{1,3})(S?)\\r?\\n'),
        service, output: '', stdout: '', logBytes: 0 };
    });
    // Capture startup diagnostics through a bounded pipe; the drain stays open
    // so a chatty service does not later receive SIGPIPE from a closed log.
    const log = '/tmp/' + id + '.startup';
    const wrapped = service
      ? `( builtin eval ${quote(cmd)} ) </dev/null > >(/usr/bin/head -c ${logLimit} >${log}; /bin/cat >/dev/null) 2>&1 & ${id}_pid=$!; /bin/sleep 0.2; if builtin kill -0 "$${id}_pid" 2>/dev/null; then ${id}_state=0S; else builtin wait "$${id}_pid"; ${id}_state=$?; fi; /bin/cat ${log}; /bin/rm -f ${log}; builtin printf '\\n${id}:%s\\n' "$${id}_state"`
      : `builtin eval ${quote(cmd)} </dev/null 2>&1; builtin printf '\\n${id}:%s\\n' "$?"`;
    const cancel = () => {
      closed = true;
      pending?.reject(signal.reason);
      pending = undefined;
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const [, response] = await Promise.all([
        command.writeStdin(wrapped + '\n', { abortSignal: signal }),
        reply,
      ]);
      return response;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (pending) { pending = undefined; closed = true; }
    }
  };
}

async function verifyRuntime(session, environment, signal) {
  const supported = environment.runtimes ?? { [environment.runtime]: environment.version };
  if (Object.keys(supported).length === 0) throw new SandboxAdapterError('The catalog omitted verifiable runtimes.');
  const actualRuntimes = {};
  for (const [runtime, version] of Object.entries(supported)) {
    if (!['node', 'python'].includes(runtime) || typeof version !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(version)) {
      throw new SandboxAdapterError('The catalog runtime cannot be verified.');
    }
    const probe = await session.runCommand({
      cmd: runtime === 'python' ? 'python3' : 'node', args: ['--version'], env: cleanEnv, cwd: ROOT, timeoutMs: 3000, signal,
    });
    const output = (await probe.stdout({ signal })).trim();
    const actual = /^(?:v|Python )?(\d+\.\d+\.\d+)$/.exec(output)?.[1];
    if (probe.exitCode !== 0 || !actual || (actual !== version && !actual.startsWith(version + '.'))) {
      throw new SandboxAdapterError('The installed runtime does not match the approved catalog.');
    }
    actualRuntimes[runtime] = actual;
  }
  return actualRuntimes;
}

/** Uses only a pinned, nonpersistent Vercel session. Never used as an Eve native sandbox. */
export function makeVercelSandboxFactory({ Sandbox, auth, limits = {}, fetchImpl = globalThis.fetch }) {
  const { teamId, projectId, token } = auth ?? {};
  if (typeof Sandbox?.create !== 'function' || [teamId, projectId, token].some(x => typeof x !== 'string' || !x.trim())) {
    throw new SandboxAdapterError('The approved Sandbox project requires its team ID, project ID and VERCEL_TOKEN.');
  }
  const lifetimeMs = limits.lifetimeMs ?? 120_000;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 120_000) throw new RangeError('Invalid VM lifetime.');
  const logLimit = limits.logLimit ?? 128 * 1024;
  if (!Number.isSafeInteger(logLimit) || logLimit < 1 || logLimit > 128 * 1024) throw new RangeError('Invalid VM log limit.');
  return ({ environment, access, sourceFiles }) => {
    const region = environment.region ?? 'iad1';
    if (typeof region !== 'string' || !/^[a-z]{3}[0-9]{1,2}$/.test(region)) throw unsupported('The catalog region is unsupported.');
    if (environment.provider !== 'vercel' || !digestImage.test(environment.image) ||
        !Array.isArray(access?.egress) || access.egress.length > 16 ||
        access.egress.some(host => typeof host !== 'string' || !hostname.test(host) || isIP(host))) {
      throw unsupported('Unsupported immutable image or network policy.');
    }
    const { staged, identity } = prepareFiles(sourceFiles);
    const approvedHosts = [...new Set(access.egress)];
    const download = approvedHosts.length ? documentedDownload([{ command: access.download?.command }], approvedHosts) : null;
    if (approvedHosts.length && (!download || download.path !== access.download.path || download.url !== access.download.url))
      throw unsupported('Network access requires a documented capture of the downloaded artifact.');
    const networkPolicy = approvedHosts.length ? { allow: approvedHosts } : 'deny-all';
    const name = 'ffm-' + nonce();
    const aborter = new AbortController();
    let sentCreate = false;
    // The pinned SDK otherwise retries writes to the create endpoint on 429/5xx or transport errors.
    // A lost response is not evidence that a VM was not created. Block every retry at the transport.
    const fetchOnce = (url, options) => {
      if (options?.method === 'POST' && /\/v[23]\/sandboxes\/?$/.test(new URL(url).pathname)) {
        if (sentCreate) throw new DOMException('Sandbox creation is not retried.', 'AbortError');
        sentCreate = true;
      }
      return fetchImpl(url, { ...options, redirect: 'error' });
    };
    let creation;
    let box;
    let session;
    let run, downloaded = false, actualRuntimes;
    return {
      async start({ signal }) {
        if (creation) throw new Error('A sandbox can only be created once.');
        signal.throwIfAborted();
        creation = Sandbox.create({ teamId, projectId, token, name, image: environment.image, persistent: false,
          networkPolicy, region, resources: { vcpus: 1 }, timeout: lifetimeMs, ports: [], signal, fetch: fetchOnce });
        try { box = await creation; }
        catch (error) { throw provisioningFailure(error); }
        if (box.name !== name || box.currentSnapshotId || box.persistent !== false) {
          throw new SandboxAdapterError('Vercel did not confirm a fresh nonpersistent sandbox identity.');
        }
        if (box.image !== environment.image) throw new SandboxAdapterError('Vercel did not confirm the approved base image digest.');
        if (!verifyNetwork(box.networkPolicy, networkPolicy)) {
          throw new SandboxAdapterError('Vercel sandbox network policy readback did not match the approved access.');
        }
        if (box.vcpus !== 1 || box.timeout !== lifetimeMs) {
          throw new SandboxAdapterError('Vercel sandbox resource readback did not match the configured limits.');
        }
        signal.throwIfAborted();
        session = box.currentSession();
        if (session.region !== region) throw new SandboxAdapterError('Vercel did not start the VM in the approved region.');
        await session.mkDir(ROOT, { signal });
        for (let i = 0; i < staged.length; i += 128) {
          signal.throwIfAborted();
          await session.writeFiles(staged.slice(i, i + 128), { signal });
        }
        actualRuntimes = await verifyRuntime(session, environment, signal);
        const command = await session.runCommand({
          cmd: BASH, args: ['--noprofile', '--norc', '-s'], cwd: ROOT, env: cleanEnv,
          stdin: true, detached: true, timeoutMs: lifetimeMs, signal,
        });
        run = sessionShell(command, logLimit, aborter);
        return {
          image: box.image, actualRuntimes, actualRegion: session.region, sandboxId: box.name, sourceIdentity: identity,
          ...(networkPolicy === 'deny-all' ? {
            dependencies: { scope: 'closed input set', image: box.image, runtimes: actualRuntimes, stagedSource: identity },
          } : {}),
        };
      },
      async run(command, options) {
        if (!run) throw new Error('Sandbox not ready.');
        if (!download || downloaded) return run(command, options);
        if (command !== download.command || options.mode === 'service')
          throw unsupported('The approved download must precede repository commands.');
        const response = await run(command, options);
        await box.update({ networkPolicy: 'deny-all' }, { signal: options.signal });
        if (box.networkPolicy !== 'deny-all') throw new SandboxAdapterError('The download network window did not close.');
        downloaded = true;
        if ([5, 6, 7, 28, 35].includes(response.exitCode))
          return { ...response, networkFailure: true };
        if (response.exitCode !== 0) return response;
        const stream = await session.readFile({ path: ROOT + '/' + download.path }, { signal: options.signal });
        if (!stream) throw new SandboxAdapterError('The downloaded file could not be captured.');
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 32 * 1024 * 1024) throw unsupported('The downloaded artifact exceeds the 32 MiB evidence limit.');
          hash.update(chunk);
        }
        const artifact = { url: download.url, path: download.path, bytes, sha256: hash.digest('hex') };
        return { ...response, artifact,
          dependencies: { scope: 'closed after measured download', image: environment.image, runtimes: actualRuntimes, stagedSource: identity, artifact } };
      },
      async observe(check, { signal, precondition = false }) {
        if (!run) throw new Error('Sandbox not ready.');
        const args = checkArguments(check, precondition);
        const tries = check.kind === 'http' && !precondition ? 5 : 1;
        let sawError = false;
        for (let i = 0; i < tries; ++i) {
          const probe = await session.runCommand({
            cmd: BASH, args: ['--noprofile', '--norc', '-c', args[0], 'ffm-observer', ...args.slice(1)],
            cwd: ROOT, env: cleanEnv, timeoutMs: 3000, signal,
          });
          if (probe.exitCode === 10) return { state: 'met', evidence: 'The frozen check matched in the assigned VM.' };
          if (probe.exitCode !== 11) sawError = true;
          if (i + 1 < tries) await delay(300, undefined, { signal });
        }
        return sawError
          ? { state: 'error', evidence: 'The observer could not obtain a reliable result.' }
          : { state: 'absent', evidence: 'The frozen check did not match in the assigned VM.' };
      },
      async stop({ signal }) {
        aborter.abort();
        if (!creation) return 'not created';
        // Reconcile a lost create response by name without resuming or creating another session.
        let assigned = box;
        if (!assigned) {
          try { assigned = await creation; }
          catch (failure) {
            if (typeof Sandbox.get !== 'function') throw failure;
            assigned = await Sandbox.get({ teamId, projectId, token, name, resume: false, signal, fetch: fetchOnce });
          }
        }
        if (assigned.name !== name || assigned.persistent !== false) throw new Error('Sandbox identity could not be confirmed.');
        if (assigned.status === 'stopped' && !assigned.currentSnapshotId) return 'confirmed';
        const stopped = await assigned.stop({ signal });
        if (stopped?.status !== 'stopped' || stopped.snapshot) throw new Error('Nonpersistent teardown was not confirmed.');
        return 'confirmed';
      },
    };
  };
}
