import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalDigest, approvePlan } from '../src/intake.mjs';
import { executeAttempt } from '../src/execution.mjs';
import { classifyAttempt } from '../src/receipt.mjs';

const image = 'vercel/sandbox/node@sha256:' + 'a'.repeat(64);
const basic = {
  status: 'ready', revision: 'b'.repeat(40), repository: 'fixture', documentation: [], requirements: [],
  environment: { provider: 'vercel', image, runtime: 'node', version: '24.0.0' },
  access: { egress: [] }, check: { kind: 'file', path: 'welcome.txt', precondition: 'absent' },
  steps: [{ command: 'cd example', citation: 'README.md:2' }, { command: 'make welcome', citation: 'README.md:3' }],
};
const approve = plan => approvePlan(plan, approvalDigest(plan));
const setup = (overrides = {}) => {
  const activity = [];
  return { activity, createSandbox: () => {
    activity.push('construct');
    return {
      async start() { activity.push('start'); return { image, sandboxId: 'sandbox-fixture' }; },
      async run(command) { activity.push(command); return { exitCode: 0, output: 'token=abc' }; },
      async observe(_check, { precondition }) {
        activity.push(precondition ? 'before' : 'after');
        return { state: precondition ? 'absent' : 'met' };
      },
      async stop() { activity.push('stop'); return 'confirmed'; },
      ...overrides,
    };
  } };
};

test('only the frozen approved commands run and only the controller observes', async () => {
  const { activity, createSandbox } = setup();
  await assert.rejects(executeAttempt({ plan: basic, createSandbox }), /approved/i);
  assert.deepEqual(activity, []);
  const attempt = await executeAttempt({
    plan: approve(basic), createSandbox, redactValues: ['abc'],
    drive: async tools => {
      assert.deepEqual(Object.keys(tools).sort(), ['requestEnvironment', 'runNext']);
      assert.equal((await tools.runNext()).refused, true);
      assert.equal((await tools.requestEnvironment({ image: 'alternate' })).ready, false);
      assert.equal((await tools.requestEnvironment()).ready, true);
      assert.equal((await tools.requestEnvironment()).ready, false);
      assert.equal((await tools.runNext('rm file')).refused, true);
      const [first, concurrent] = await Promise.all([tools.runNext(), tools.runNext()]);
      assert.equal(concurrent.refused, true);
      assert.doesNotMatch(first.output, /abc/);
      assert.equal((await tools.runNext()).more, false);
      assert.equal((await tools.runNext()).refused, true);
    },
  });
  assert.equal(classifyAttempt(attempt).verdict, 'pass');
  assert.deepEqual(activity, ['construct', 'start', 'before', 'cd example', 'make welcome', 'after', 'stop']);
  assert.deepEqual(attempt.steps.map(step => step.actualCommand), ['cd example', 'make welcome']);
  assert.equal(attempt.teardown, 'confirmed');
});

test('stops on the first failed command and preserves the unrun remainder', async () => {
  const { activity, createSandbox } = setup({ run: async () => ({ exitCode: 2, output: 'expected failure' }) });
  const attempt = await executeAttempt({ plan: approve(basic), createSandbox });
  assert.equal(classifyAttempt(attempt).verdict, 'blocked');
  assert.deepEqual(attempt.steps.map(s => s.state), ['completed', 'unrun']);
  assert.deepEqual(activity, ['construct', 'start', 'before', 'stop']);
});

test('a pre-existing result prevents execution and an observer error is not a missing result', async () => {
  const early = setup({ observe: async () => ({ state: 'met' }) });
  const precondition = await executeAttempt({ plan: approve(basic), createSandbox: early.createSandbox });
  assert.equal(classifyAttempt(precondition).verdict, 'inconclusive');
  assert.match(precondition.stop.reason, /already existed/);
  assert.deepEqual(early.activity, ['construct', 'start', 'stop']);

  for (const [state, verdict] of [['absent', 'blocked'], ['error', 'inconclusive']]) {
    const { createSandbox } = setup({ observe: async (_, { precondition }) => ({ state: precondition ? 'absent' : state }) });
    assert.equal(classifyAttempt(await executeAttempt({ plan: approve(basic), createSandbox })).verdict, verdict);
  }
});

test('provision failure, command timeouts and failed teardown remain inconclusive', async () => {
  const provision = setup({ start: async () => { throw new Error('untrusted error'); } });
  const first = await executeAttempt({ plan: approve(basic), createSandbox: provision.createSandbox });
  assert.equal(first.teardown, 'confirmed');
  assert.deepEqual(provision.activity, ['construct', 'stop']);
  assert.doesNotMatch(first.stop.reason, /untrusted/);

  const timeout = setup({ run: async () => new Promise(() => {}) });
  const second = await executeAttempt({ plan: approve(basic), createSandbox: timeout.createSandbox, limits: { stepMs: 10 } });
  assert.equal(second.steps[0].state, 'timed out');
  assert.equal(second.teardown, 'confirmed');

  const teardown = setup({ stop: async () => { throw new Error('cannot stop'); } });
  const third = await executeAttempt({ plan: approve(basic), createSandbox: teardown.createSandbox });
  assert.equal(third.teardown, 'unconfirmed');
  assert.equal(classifyAttempt(third).verdict, 'inconclusive');
});

test('a driver that exits early cannot continue using a saved tool', async () => {
  const { activity, createSandbox } = setup();
  let saved;
  const attempt = await executeAttempt({
    plan: approve(basic), createSandbox,
    drive: async ({ requestEnvironment, runNext }) => {
      await requestEnvironment();
      saved = runNext;
    },
  });
  assert.equal(classifyAttempt(attempt).verdict, 'inconclusive');
  assert.equal((await saved()).refused, true);
  assert.deepEqual(activity, ['construct', 'start', 'before', 'stop']);
});
