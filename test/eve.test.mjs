import test from 'node:test';
import assert from 'node:assert/strict';
import { createEveAgent, handleControllerRequest } from '../src/eve.mjs';
import { approvePlan, approvalDigest } from '../src/intake.mjs';

test('controller broker denies cross-phase tools, out-of-order and concurrent calls', async () => {
  let steps = 0;
  let finish;
  const state = {
    mode: 'run', steps: [{ id: 'step-1' }, { id: 'step-2' }], index: 0,
    requestEnvironment: async () => ({ ready: true }),
    runStep: () => new Promise((resolve) => { steps++; finish = resolve; }),
  };
  const op = (name, input) => handleControllerRequest(state, name, input);
  assert.equal(await op('read_source', { path: 'package.json' }), null);
  assert.equal(await op('bash', { command: 'anything' }), null);
  assert.equal(await op('run_step', { id: 'step-1' }), null);
  assert.deepEqual(await op('request_environment', {}), { ready: true });
  assert.equal(await op('request_environment', {}), null);
  const underway = op('run_step', { id: 'step-1' });
  assert.equal(await op('run_step', { id: 'step-2' }), null);
  finish({ exitCode: 1, more: false });
  assert.deepEqual(await underway, { exitCode: 1, more: false });
  assert.equal(await op('run_step', { id: 'step-2' }), null);
  assert.equal(steps, 1);
});

test('eve adapter uses independent turns and passes the observer nothing to the newcomer', async () => {
  const modes = [];
  let closed = false;
  const agent = createEveAgent({
    model: 'openai/test',
    startRuntime: async () => ({
      close: async () => { closed = true; },
      turn: async ({ message, state, outputSchema }) => {
        modes.push(state.mode);
        if (state.mode === 'propose') {
          assert.ok(outputSchema);
          assert.equal(await handleControllerRequest(state, 'request_environment', {}), null);
          return { data: { status: 'ready' } };
        }
        assert.doesNotMatch(message, /observer-private/);
        assert.deepEqual(await handleControllerRequest(state, 'request_environment', {}), { ready: true });
        assert.deepEqual(await handleControllerRequest(state, 'run_step', { id: 'step-1' }), { exitCode: 0, more: false });
        return { sessionId: 'newcomer-1' };
      },
    }),
  });
  const doc = { path: 'README.md', text: 'Start here' };
  await agent.propose({ readme: doc.path, documents: [doc] });
  const ready = { status: 'ready', steps: [{ id: 'step-1' }], check: { path: 'observer-private' } };
  const plan = approvePlan(ready, approvalDigest(ready));
  assert.deepEqual(await agent.run({
    plan, requestEnvironment: async () => ({ ready: true }), runStep: async () => ({ exitCode: 0, more: false }),
  }), { sessionId: 'newcomer-1' });
  await agent.close();
  assert.deepEqual(modes, ['propose', 'run']);
  assert.ok(closed);
});

test('pinned eve boots with no alternate tools or session VM', {
  skip: Number(process.versions.node.split('.')[0]) < 24, timeout: 35000,
}, async () => {
  const agent = createEveAgent({ model: 'openai/gpt-5.4-mini' });
  try {
    const info = await agent.inspect();
    assert.deepEqual(info.tools.static, []);
    assert.deepEqual(info.tools.dynamic.map((tool) => tool.slug), ['controller']);
    assert.equal(info.sandbox.provider, 'ffm-disabled');
  } finally {
    await agent.close();
  }
});

test('direct OpenAI configuration passes the effective runtime check before any model call', {
  skip: Number(process.versions.node.split('.')[0]) < 24, timeout: 35000,
}, async () => {
  const agent = createEveAgent({ model: 'openai/gpt-5.4-mini', modelConnection: 'openai' });
  try {
    assert.equal((await agent.inspect()).agent.model.id, 'openai/gpt-5.4-mini');
  } finally { await agent.close(); }
});

test('real eve sends only the approved phase tools to a synthetic local model', {
  skip: Number(process.versions.node.split('.')[0]) < 24, timeout: 50000,
}, async (t) => {
  const { cp, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const scratch = await mkdtemp(join(tmpdir(), 'ffm-provider-audit-'));
  const testAgent = join(scratch, 'agent');
  t.after(() => rm(scratch, { force: true, recursive: true }));
  await cp(new URL('../agent/', import.meta.url), testAgent, { recursive: true });
  const { startLocalEveRuntime } = await import('../src/eve.mjs');
  const source = await readFile(join(testAgent, 'agent.ts'), 'utf8');
  const fake = await readFile(new URL('./fixtures/eve-model.ts.txt', import.meta.url), 'utf8');
  await writeFile(join(testAgent, 'agent.ts'), source.replace(
    'const provider = direct ? openai(id) : gateway(id);', fake,
  ));
  const agent = createEveAgent({ model: 'openai/test', startRuntime: (config) => startLocalEveRuntime(config, testAgent) });
  t.after(() => agent.close());
  const doc = { path: 'README.md', sha256: 'a'.repeat(64), text: 'No outcome has been documented.' };
  const proposal = await agent.propose({ readme: 'README.md', documents: [doc] });
  assert.equal(proposal.status, 'missing');
  const ready = { status: 'ready', steps: [{ id: 'step-1' }], check: { path: 'observer-private' } };
  const plan = approvePlan(ready, approvalDigest(ready));
  const called = [];
  const result = await agent.run({
    plan,
    requestEnvironment: async () => { called.push('env'); return { ready: true }; },
    runStep: async () => { called.push('step'); return { exitCode: 0, more: false }; },
  });
  assert.ok(result.sessionId);
  assert.deepEqual(called, ['env', 'step']);
  const diagnosis = await agent.diagnose({
    attempt: { outcome: 'absent' }, documents: [doc], paths: ['test.js'],
    readSource: (path) => { called.push(path); return 'fixture'; },
  });
  assert.equal(diagnosis.confidence, 'medium');
  assert.deepEqual(called, ['env', 'step', 'test.js']);
});
