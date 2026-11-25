import test from 'node:test';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVercelSandboxFactory } from '../src/sandbox.mjs';

const image = 'vercel/sandbox/node@sha256:' + 'a'.repeat(64);
const environment = { provider: 'vercel', image, runtime: 'node', version: '24.1.0' };
const auth = { teamId: 'fixture-team', projectId: 'fixture-project', token: 'fixture-token' };
const signal = new AbortController().signal;
const input = { environment, access: { egress: [] }, sourceFiles: [
  { path: 'README.md', content: Buffer.from('Example documentation') },
  { path: 'bin/start', mode: 0o755, content: Buffer.from('trusted fixture') },
] };

function fixture({ wrongPolicy = false, observerCode = 10, exitCode = 0 } = {}) {
  const calls = [];
  const logs = [];
  let onLog;
  const command = {
    async *logs({ signal: logSignal }) {
      const wake = () => onLog?.();
      logSignal.addEventListener('abort', wake);
      try {
        while (!logSignal.aborted) {
          if (logs.length) yield logs.shift();
          else await new Promise(resolve => { onLog = resolve; });
        }
      } finally {
        logSignal.removeEventListener('abort', wake);
      }
    },
    async writeStdin(line) {
      calls.push(['stdin', line]);
      const marker = line.match(/ffm_[0-9a-f]{32}(?=:)/)[0];
      const result = 'fixture log\n' + marker + ':' + exitCode + '\n';
      logs.push({ stream: 'stdout', data: result.slice(0, 32) }, { stream: 'stdout', data: result.slice(32) });
      onLog?.();
    },
  };
  const session = {
    region: 'iad1',
    async readFile() { return Readable.from([Buffer.from('download bytes')]); },
    async mkDir(path) { calls.push(['mkdir', path]); },
    async writeFiles(files) { calls.push(['files', files]); },
    async runCommand(request) {
      calls.push(['command', request]);
      if (request.cmd === 'node') return { exitCode: 0, stdout: async () => 'v24.1.0\n' };
      if (request.detached) return command;
      return { exitCode: observerCode };
    },
  };
  const Sandbox = { async create(params) {
    calls.push(['create', params]);
    return {
      name: params.name, image, vcpus: 1, timeout: params.timeout, networkPolicy: wrongPolicy ? 'allow-all' : params.networkPolicy, persistent: false,
      async update({ networkPolicy }) { this.networkPolicy = networkPolicy; calls.push(['network', networkPolicy]); },
      currentSession: () => session,
      async stop() { calls.push(['stop']); return { status: 'stopped' }; },
    };
  } };
  return { calls, Sandbox };
}

test('Vercel adapter stages exact bytes/modes and opens only one private shell', async () => {
  const { calls, Sandbox } = fixture();
  const factory = makeVercelSandboxFactory({ Sandbox, auth });
  const handle = factory(input);
  const details = await handle.start({ signal });
  assert.equal(details.image, image);
  assert.match(details.sourceIdentity, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(details.actualRuntimes, { node: '24.1.0' });
  assert.equal(details.dependencies.scope, 'closed input set');
  const create = calls.find(([name]) => name === 'create')[1];
  assert.equal(create.networkPolicy, 'deny-all');
  assert.equal(create.persistent, false);
  assert.equal(create.timeout, 120_000);
  assert.equal(create.region, 'iad1');
  assert.equal(details.actualRegion, 'iad1');
  assert.deepEqual(create.ports, []);
  assert.deepEqual(create.resources, { vcpus: 1 });
  assert.equal(create.env, undefined);
  const staged = calls.find(([name]) => name === 'files')[1];
  assert.deepEqual(staged.map(file => [file.path, file.mode, file.content.toString()]), [
    ['/vercel/sandbox/checkout/README.md', 0o644, 'Example documentation'],
    ['/vercel/sandbox/checkout/bin/start', 0o755, 'trusted fixture'],
  ]);
  assert.deepEqual(await handle.run("cd 'folder'; export VALUE=hello", { signal }), {
    exitCode: 0, output: 'fixture log', startedService: false,
  });
  await handle.run('printf "%s" "$VALUE"', { signal });
  await handle.run('node serve.js', { mode: 'service', signal });
  const commands = calls.filter(([name]) => name === 'command');
  assert.equal(commands.filter(([, cmd]) => cmd.detached).length, 1);
  assert.equal(commands.every(([, cmd]) => !JSON.stringify(cmd).includes(auth.token)), true);
  assert.match(calls.find(([name, line]) => name === 'stdin' && line.includes('serve.js'))[1], /\/dev\/null.*&/);
  assert.equal(await handle.stop({ signal }), 'confirmed');
});

test('only typed, loopback or in-checkout observer requests reach the assigned session', async () => {
  const { calls, Sandbox } = fixture();
  const handle = makeVercelSandboxFactory({ Sandbox, auth })(input);
  await handle.start({ signal });
  await assert.rejects(handle.observe({ kind: 'http', url: 'http://example.net:8000/' }, { signal }), /Unsupported/);
  await assert.rejects(handle.observe({ kind: 'file', path: '../secrets' }, { signal }), /Unsupported/);
  const attempt = await handle.observe({ kind: 'http', url: 'http://localhost:8080/', contains: 'hello $(unexpected)' }, { signal });
  assert.equal(attempt.state, 'met');
  const probe = calls.at(-1)[1];
  assert.equal(probe.args.includes('http://localhost:8080/'), true);
  assert.equal(probe.args.at(-1), 'hello $(unexpected)');
  assert.doesNotMatch(probe.args[3], /unexpected/);
  await handle.stop({ signal });
});

test('network drift or staging traversal fails closed, and teardown still runs', async () => {
  const { calls, Sandbox } = fixture({ wrongPolicy: true });
  const factory = makeVercelSandboxFactory({ Sandbox, auth });
  assert.throws(() => factory({ ...input, sourceFiles: [{ path: '../README.md', content: Buffer.alloc(0) }] }), /Invalid staged file/);
  assert.throws(() => factory({ ...input, access: { egress: ['*.example.net'] } }), /network policy/);
  assert.deepEqual(calls, []);
  const assigned = factory(input);
  await assert.rejects(assigned.start({ signal }), /network policy readback/);
  assert.equal(await assigned.stop({ signal }), 'confirmed');
  assert.deepEqual(calls.map(([name]) => name), ['create', 'stop']);
});

test('transport blocks duplicate create and reconciles lost responses without resume', async () => {
  let outbound = 0, created, getArgs, stopped = 0;
  const endpoint = 'https://api.vercel.com/v3/sandboxes?teamId=fixture';
  const Sandbox = {
    async create(params) {
      created = params;
      await params.fetch(endpoint, { method: 'POST' }).catch(() => {});
      await assert.rejects(async () => params.fetch(endpoint, { method: 'POST' }), { name: 'AbortError' });
      throw new Error('lost create response');
    },
    async get(params) {
      getArgs = params;
      return { name: params.name, persistent: false, stop: async () => { stopped++; return { status: 'stopped' }; } };
    },
  };
  const assigned = makeVercelSandboxFactory({ Sandbox, auth, fetchImpl: async () => { outbound++; throw new Error('transport'); } })(input);
  await assert.rejects(assigned.start({ signal }), /did not return a confirmed VM/);
  assert.equal(await assigned.stop({ signal }), 'confirmed');
  assert.equal(outbound, 1);
  assert.equal(stopped, 1);
  assert.equal(getArgs.name, created.name);
  assert.equal(getArgs.resume, false);
});

test('bounded download is hashed and network access closes before other commands', async () => {
  const { calls, Sandbox } = fixture();
  const factory = makeVercelSandboxFactory({ Sandbox, auth });
  const host = 'registry.example.org';
  assert.throws(() => factory({ ...input, access: { egress: [host] } }), /capture/);
  const url = 'https://' + host + '/bundle.whl';
  const download = { command: 'curl -o bundle.whl ' + url, path: 'bundle.whl', url };
  const handle = factory({ ...input, access: { egress: [host], download } });
  const details = await handle.start({ signal });
  assert.deepEqual(calls[0][1].networkPolicy, { allow: [host] });
  assert.equal(details.dependencies, undefined);
  await assert.rejects(handle.run('npm ci', { signal }), /precede/);
  const result = await handle.run(download.command, { signal });
  assert.equal(result.artifact.sha256, createHash('sha256').update('download bytes').digest('hex'));
  assert.deepEqual(calls.at(-1), ['network', 'deny-all']);
  assert.equal((await handle.run('node app.js', { signal })).exitCode, 0);
  await handle.stop({ signal });
});

// This unit test runs only fixed, trusted fixture commands in a temporary local Bash process.
// The production adapter has no local execution path.
test('the persistent shell retains directory, exports, and a background process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffm-shell-fixture-'));
  await mkdir(join(directory, 'child'));
  let proc;
  const fake = {
    async create(options) {
      return {
        name: options.name, image, vcpus: 1, timeout: options.timeout, persistent: false, networkPolicy: 'deny-all',
        currentSession: () => ({
          region: options.region,
          mkDir: async () => {},
          writeFiles: async () => {},
          async runCommand(request) {
            if (request.cmd === 'node') return { exitCode: 0, stdout: async () => 'v24.1.0' };
            assert.equal(request.cmd, '/bin/bash');
            assert.equal(request.detached, true);
            proc = spawn(request.cmd, request.args, { cwd: directory, stdio: ['pipe', 'pipe', 'ignore'] });
            return {
              async *logs() {
                for await (const data of proc.stdout) yield { data: data.toString(), stream: 'stdout' };
              },
              writeStdin(data) {
                return new Promise((resolve, reject) => proc.stdin.write(data, error => error ? reject(error) : resolve()));
              },
            };
          },
        }),
        async stop() {
          if (proc?.exitCode === null) {
            const closed = once(proc, 'close');
            proc.stdin.end();
            await closed;
          }
          return { status: 'stopped' };
        },
      };
    },
  };
  const handle = makeVercelSandboxFactory({ Sandbox: fake, auth, limits: { logLimit: 128 } })(input);
  const testSignal = AbortSignal.timeout(4_000);
  try {
    await handle.start({ signal: testSignal });
    assert.equal((await handle.run('cd child; export FIXTURE=retained', { signal: testSignal })).exitCode, 0);
    assert.equal((await handle.run('printf "%s/%s" "${PWD##*/}" "$FIXTURE"', { signal: testSignal })).output, 'child/retained');
    const full = await handle.run("printf '%0128d' 0; sleep 0.3", { mode: 'service', signal: testSignal });
    assert.equal(full.startedService, true);
    assert.equal(full.output.length, 128);
    const failedService = await handle.run("printf 'Missing entry point' >&2; exit 2", { mode: 'service', signal: testSignal });
    assert.equal(failedService.exitCode, 2);
    assert.equal(failedService.output, 'Missing entry point');
    const service = await handle.run('sleep 0.4; printf ready > fixture.txt', { mode: 'service', signal: testSignal });
    assert.equal(service.startedService, true);
    assert.equal((await handle.run('wait; cat fixture.txt', { signal: testSignal })).output, 'ready');
    assert.equal((await handle.run('(exit 12)', { signal: testSignal })).exitCode, 12);
  } finally {
    await handle.stop({ signal: testSignal });
    await rm(directory, { recursive: true, force: true });
  }
});

test('authentication and runtime mismatch errors are typed and do not expose provider bodies', async () => {
  const denied = makeVercelSandboxFactory({
    auth, Sandbox: { async create() {
      throw Object.assign(new Error('fixture-token should not appear'), { response: { status: 403 } });
    } },
  })(input);
  await assert.rejects(denied.start({ signal }), {
    name: 'SandboxAdapterError', message: 'Vercel denied access to the approved Sandbox project.',
  });
  const { Sandbox } = fixture();
  const mismatch = makeVercelSandboxFactory({ Sandbox, auth })({
    ...input, environment: { ...environment, version: '24.2.0' },
  });
  await assert.rejects(mismatch.start({ signal }), /installed runtime does not match/);
  assert.equal(await mismatch.stop({ signal }), 'confirmed');
});

test('update preconditions check promised content and HTTP status', async () => {
  const { calls, Sandbox } = fixture();
  const box = makeVercelSandboxFactory({ Sandbox, auth })(input);
  await box.start({ signal });
  await box.observe({ kind: 'file', path: 'page.txt', contains: 'ready', precondition: 'unmet' }, { signal, precondition: true });
  assert.deepEqual(calls.at(-1)[1].args.slice(-2), ['contains', 'ready']);
  await box.observe({ kind: 'http', url: 'http://localhost/', status: 200, precondition: 'unmet' }, { signal, precondition: true });
  assert.ok(calls.at(-1)[1].args.includes('200'));
  await box.stop({ signal });
});

test('a download DNS failure remains a network observation with its command output', async () => {
  const { Sandbox } = fixture({ exitCode: 6 });
  const url = 'https://registry.example.org/bundle.whl';
  const download = { command: 'curl -o bundle.whl ' + url, path: 'bundle.whl', url };
  const box = makeVercelSandboxFactory({ Sandbox, auth })({
    ...input, access: { egress: ['registry.example.org'], download },
  });
  await box.start({ signal });
  const evidence = await box.run(download.command, { signal });
  assert.equal(evidence.exitCode, 6);
  assert.equal(evidence.networkFailure, true);
  assert.equal(evidence.output, 'fixture log');
  await box.stop({ signal });
});
