// Offline demonstration only. All repository contents and commands originate below.
// Production repository input never reaches this Docker fixture driver.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from './workflow.mjs';
import { loadReceipt } from './receipt.mjs';

const exec = promisify(execFile);
const fixtures = [
  {
    name: 'python-file', image: 'python:3.12-slim', runtime: 'python', range: '3.12',
    file: 'hello.py', code: "from pathlib import Path\nPath('hello.txt').write_text('Welcome')\n",
    command: 'python3 hello.py', promise: 'Creates hello.txt containing Welcome.',
  },
  {
    name: 'node-service', image: 'node:20-bookworm', runtime: 'node', range: '20',
    file: 'server.cjs', code: "require('node:http').createServer((req,res) => res.end('Welcome')).listen(8080,'127.0.0.1');\n",
    command: 'node server.cjs', promise: 'Visit http://127.0.0.1:8080 and read Welcome.',
  },
];
fixtures.push({ ...fixtures[0], name: 'python-filename-typo', command: 'python3 helo.py' });

async function docker(args, options = {}) {
  return (await exec('docker', args, { timeout: 20_000, maxBuffer: 256 * 1024, ...options })).stdout.trim();
}

// A scripted reader makes the demo repeatable without a paid model. Only the
// fixture grammar is supported here. The controller still measures each outcome.
export function demoProposal(intake) {
  const doc = intake.documents[0];
  const lines = doc.text.split('\n');
  const [runtime, version] = lines[1].replace('Requires ', '').split(' ');
  const citation = startLine => ({ path: doc.path, startLine, endLine: startLine });
  const words = lines[5].split(' ');
  const http = words[0] === 'Visit';
  return {
    status: 'ready', requirements: [{ runtime, version, citation: citation(2) }],
    steps: [{ command: lines[3], mode: http ? 'service' : 'foreground', citation: citation(4) }],
    access: { egress: [] },
    check: { kind: http ? 'http' : 'file', precondition: http ? 'unmet' : 'absent', [http ? 'url' : 'path']: words[1],
      contains: 'Welcome', citation: citation(6) },
  };
}

async function demoCatalog() {
  const catalog = [];
  for (const fixture of fixtures.slice(0, 2)) {
    let data;
    try { data = JSON.parse(await docker(['image', 'inspect', fixture.image]))[0]; }
    catch { throw new Error('Docker demo requires local images python:3.12-slim and node:20-bookworm. See README.'); }
    const version = data.Config.Env.find(line => line.startsWith(fixture.runtime.toUpperCase() + '_VERSION='))?.split('=')[1];
    if (!version || !data.RepoDigests[0]) throw new Error('Demo image lacks a recorded digest or runtime version.');
    catalog.push({ provider: 'docker-fixture', runtime: fixture.runtime, version, image: data.RepoDigests[0] });
  }
  return catalog;
}

function fixtureSandbox(fixture, staging) {
  return ({ environment, sourceFiles }) => {
    const id = 'first-five-demo-' + randomUUID();
    let created = false;
    return {
      async start({ signal }) {
        const hash = createHash('sha256');
        for (const file of sourceFiles) {
          if (!['README.md', fixture.file].includes(file.path)) throw new Error('Unexpected demo file');
          await writeFile(join(staging, file.path), file.content, { mode: 0o644 });
          hash.update(file.path).update(file.content);
        }
        await docker(['create', '--pull=never', '--name', id, '--network=none', '--read-only',
          '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m',
          '--cpus=0.5', '--user=65534:65534', '--tmpfs=/work:rw,mode=1777', '--workdir=/work',
          '--mount', 'type=bind,src=' + staging + ',dst=/fixture,readonly', environment.image,
          'sh', '-c', 'cp /fixture/* /work/ && exec sleep 120'], { signal });
        created = true;
        await docker(['start', id], { signal });
        return { image: environment.image, sandboxId: id, sourceIdentity: hash.digest('hex'), dependencies: [] };
      },
      async run(command, { mode, signal }) {
        const allowed = [fixture.command, fixture.runtime === 'python' ? 'python3 hello.py' : 'node server.cjs'];
        if (!allowed.includes(command)) throw new Error('Unexpected demo command');
        const args = ['exec', ...(mode === 'service' ? ['-d'] : []), id, ...command.split(' ')];
        try { return { exitCode: 0, output: await docker(args, { signal }), startedService: mode === 'service' }; }
        catch (err) {
          if (err.killed || !Number.isInteger(err.code)) throw err;
          return { exitCode: err.code, output: err.stderr };
        }
      },
      async observe(check, { signal, precondition }) {
        const http = check.kind === 'http';
        const probe = http
          ? "fetch(process.argv[1]).then(async r=>process.exit(r.status===200 && (await r.text()).includes(process.argv[2])?0:3)).catch(e=>process.exit(e.cause?.code==='ECONNREFUSED'?3:4))"
          : "import os,sys; p=sys.argv[1]; sys.exit(0 if os.path.isfile(p) and sys.argv[2] in open(p).read() else 3)";
        const args = http ? ['node', '-e', probe, check.url] : ['python3', '-c', probe, check.path];
        for (let i = 0; i < (http && !precondition ? 8 : 1); i++) {
          try {
            await docker(['exec', id, ...args, precondition && check.precondition === 'absent' ? '' : check.contains], { signal });
            return { state: 'met', evidence: 'The documented result was observed inside the fixture container.' };
          } catch (err) {
            if (err.code !== 3) return { state: 'error' };
          }
        }
        return { state: 'absent', evidence: 'The documented result was absent in the fixture container.' };
      },
      async stop() {
        if (created) await docker(['rm', '-f', id]);
        return created ? 'confirmed' : 'not created';
      },
    };
  };
}

export async function runDemo(outDir) {
  const catalog = await demoCatalog();
  const temp = await mkdtemp(join(tmpdir(), 'first-five-demo-'));
  const results = [];
  try {
    for (const fixture of fixtures) {
      const localRepo = join(temp, fixture.name), staging = join(temp, fixture.name + '-stage');
      await mkdir(localRepo);
      await mkdir(staging, { mode: 0o755 });
      const readme = ['# Synthetic quickstart', 'Requires ' + fixture.runtime + ' ' + fixture.range, '```sh',
        fixture.command, '```', fixture.promise, ''].join('\n');
      await writeFile(join(localRepo, 'README.md'), readme);
      await writeFile(join(localRepo, fixture.file), fixture.code);
      const git = args => exec('git', ['-C', localRepo, ...args], { env: {
        PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      await git(['init', '-q', '--template=']);
      await git(['add', 'README.md', fixture.file]);
      await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic quickstart']);
      const agent = {
        propose: demoProposal,
        async run({ requestEnvironment, runStep }) {
          if ((await requestEnvironment()).ready) while ((await runStep()).more) { /* next cited command */ }
          return { sessionId: 'demo-' + randomUUID() };
        },
      };
      const options = { localRepo, repository: 'synthetic/' + fixture.name, revision: 'HEAD',
        config: { catalog, model: 'offline/scripted-demo' }, agent, review: async () => true,
        createSandbox: fixtureSandbox(fixture, staging), outDir };
      const result = await runWorkflow(options);
      console.log(`Synthetic ${fixture.name}: ${result.verdict} — ${result.path}`);
      results.push(result);
      const typo = fixture.name === 'python-filename-typo';
      if (result.verdict !== (typo ? 'blocked' : 'pass'))
        throw new Error('Unexpected demo result. See ' + result.path);
      if (typo) {
        const original = await loadReceipt(result.path);
        const cleanStage = join(temp, 'replay-stage');
        await mkdir(cleanStage, { mode: 0o755 });
        const replay = await runWorkflow({ ...options, original, createSandbox: fixtureSandbox(fixture, cleanStage),
          edits: [{ path: 'README.md', before: 'python3 helo.py', after: 'python3 hello.py' }] });
        console.log(`Synthetic docs replay: ${replay.replay?.reason} — ${replay.path}`);
        if (!replay.replay?.verified) throw new Error('Demo replay was inconclusive. See ' + replay.path);
        results.push(replay);
      }
    }
    return results;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
