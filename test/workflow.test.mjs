import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { demoProposal } from '../src/demo.mjs';
import { loadReceipt } from '../src/receipt.mjs';
import { sourceFilesAt, withRepository } from '../src/repository.mjs';
import { runWorkflow, collectDiagnosis } from '../src/workflow.mjs';
import { readIntake } from '../src/intake.mjs';

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'ffm-integration-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]).toString().trim();
  git('init', '--quiet', '--template=');
  const docs = '# Quickstart\nRequires python 3.12\n```sh\npython3 helo.py\n```\nCreates hello.txt containing Welcome.\n';
  await writeFile(join(repo, 'README.md'), docs);
  await writeFile(join(repo, 'hello.py'), 'print(0)\n');
  await chmod(join(repo, 'hello.py'), 0o755);
  git('add', 'README.md', 'hello.py');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture');
  const revision = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'uncommitted data');
  await writeFile(join(repo, 'secret.env'), 'untracked');
  let sessions = 0;
  const agent = {
    propose: demoProposal,
    async run({ requestEnvironment, runStep }) {
      await requestEnvironment();
      await runStep();
      return { sessionId: String(++sessions) };
    },
    diagnose: async ({ readSource }) => {
      assert.equal(await readSource('hello.py'), 'print(0)\n');
      return { cause: 'The guide spells hello.py as helo.py.', confidence: 'high',
        edits: [{ path: 'README.md', before: 'python3 helo.py', after: 'python3 hello.py' }] };
    },
  };
  let machines = 0;
  function createSandbox({ environment, sourceFiles }) {
    assert.equal(sourceFiles.find(f => f.path === 'README.md').content.toString(), docs);
    assert.equal(sourceFiles.some(f => f.path === 'secret.env'), false);
    return {
      start: async () => ({ image: environment.image, sandboxId: String(++machines), sourceIdentity: revision, dependencies: [] }),
      run: async command => ({ exitCode: command.includes('helo.py') ? 1 : 0, output: '' }),
      observe: async (_, { precondition }) => ({ state: precondition ? 'absent' : 'met' }),
      stop: async () => 'confirmed',
    };
  }
  return { revision, repository: repo, localRepo: repo, agent, createSandbox, outDir: join(repo, 'receipts'),
    review: async () => true,
    config: { model: 'offline/test', catalog: [{ provider: 'vercel', runtime: 'python', version: '3.12.1',
      image: 'python@sha256:' + 'a'.repeat(64) }] } };
}

test('baseline, diagnosis and fresh replay agree on the frozen source and check', async t => {
  const options = await fixture(t);
  const result = await runWorkflow(options);
  assert.equal(result.verdict, 'blocked', result.markdown);
  const original = await loadReceipt(result.path);
  const intake = await readIntake(options.localRepo, options.revision);
  const diagnosis = await collectDiagnosis({ ...options, original, intake });
  assert.match(diagnosis.diff, /^\+python3 hello.py$/m);
  const replay = await runWorkflow({ ...options, original, edits: diagnosis.edits });
  assert.equal(replay.verdict, 'pass', replay.markdown);
  assert.equal(replay.replay.verified, true, replay.replay.reason);
  const loaded = await loadReceipt(replay.path);
  assert.equal(loaded.replay.verified, true);
});

test('declined approval and unsupported runtime skip provisioning', async t => {
  const options = await fixture(t);
  let creations = 0;
  options.createSandbox = () => { creations++; throw new Error('Unexpected create'); };
  assert.equal((await runWorkflow({ ...options, review: async () => false })).status, 'declined');
  assert.equal((await runWorkflow({ ...options, config: { ...options.config, catalog: [] } })).verdict, 'unsupported');
  assert.equal(creations, 0);
});

test('Git staging excludes untracked data and preserves executable modes', async t => {
  const options = await fixture(t);
  const files = await sourceFilesAt(options.localRepo, options.revision);
  assert.deepEqual(files.map(f => f.path), ['README.md', 'hello.py']);
  assert.equal(files[1].mode, 0o755);
  for (const uri of ['file:///tmp/repo', 'https://name:secret@example.invalid/repo']) {
    await assert.rejects(withRepository(uri, 'main', () => assert.fail('unsafe URL accepted')));
  }
});

test('rejected documentation links do not send credentials or query values to the model', async t => {
  const options = await fixture(t);
  await writeFile(join(options.localRepo, 'README.md'),
    '[Setup](https://person:private-password@example.invalid/setup?ticket=sensitive-ticket)\n');
  execFileSync('git', ['-C', options.localRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qam', 'Rejected external setup']);
  let prompt;
  const agent = { propose: async intake => {
    prompt = JSON.stringify(intake);
    return { status: 'ambiguous', reason: 'The linked guide is unavailable.', citation: { path: 'README.md', startLine: 1 } };
  } };
  await runWorkflow({ ...options, revision: 'HEAD', agent });
  assert.doesNotMatch(prompt, /sensitive-ticket|private-password/);
});

test('receipt leads with the comparison verdict when a fresh replay passes under changed conditions', async t => {
  const options = await fixture(t);
  const original = await loadReceipt((await runWorkflow(options)).path);
  const replay = await runWorkflow({ ...options, original, edits: [
    { path: 'README.md', before: 'python3 helo.py', after: 'python3 hello.py' },
  ], createSandbox(request) {
    const sandbox = options.createSandbox(request);
    const start = sandbox.start;
    return { ...sandbox, start: async () => ({ ...(await start()), dependencies: ['different'] }) };
  } });
  assert.equal(replay.verdict, 'inconclusive');
  assert.match(replay.markdown, /^# inconclusive/);
  assert.match(replay.markdown, /Replay attempt: pass/);
});
