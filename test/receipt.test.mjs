import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAttempt, renderReceipt } from '../src/receipt.mjs';

// Synthetic controller evidence. No repository commands are executed here.
const baseline = {
  revision: 'fixture-v1',
  environment: 'synthetic Node environment',
  check: 'stdout contains Hello on its own line',
  outcome: 'met',
  teardown: 'simulated',
  steps: [{
    citation: 'README.md:4',
    command: 'node hello.mjs',
    state: 'completed',
    exitCode: 0,
    output: 'Hello',
  }],
};

test('successful guide produces a Markdown receipt from observed evidence', () => {
  assert.equal(classifyAttempt(baseline).verdict, 'pass');
  const report = renderReceipt(baseline);
  for (const expected of ['# pass', 'README.md:4', 'node hello.mjs', 'Hello', 'fixture-v1'])
    assert.ok(report.includes(expected));
});

test('mistyped filename blocks the attempt and preserves unrun steps', () => {
  const steps = [
    { ...baseline.steps[0], command: 'node helo.mjs', exitCode: 1, output: 'Module missing' },
    { citation: 'README.md:5', command: 'node verify.mjs', state: 'unrun' },
  ];
  const attempt = { ...baseline, outcome: 'unknown', steps };
  assert.equal(classifyAttempt(attempt).verdict, 'blocked');
  assert.match(renderReceipt(attempt), /unrun/);
});

test('a successful command with an observed missing outcome is blocked', () => {
  assert.equal(classifyAttempt({ ...baseline, outcome: 'absent' }).verdict, 'blocked');
});

for (const [kind, verdict] of [['platform', 'inconclusive'], ['unsupported', 'unsupported']]) {
  test(kind + ' before execution preserves the stop reason', () => {
    const stop = { kind, reason: 'Environment unavailable' };
    const attempt = { ...baseline, steps: [], outcome: 'unknown', stop };
    assert.deepEqual(classifyAttempt(attempt), { verdict, reason: stop.reason });
  });
}

test('missing evidence cannot produce a pass', () => {
  for (const change of [{ steps: [] }, { outcome: 'unknown' },
    { steps: [{ ...baseline.steps[0], exitCode: null }] }])
    assert.equal(classifyAttempt({ ...baseline, ...change }).verdict, 'inconclusive');
});

test('declined approval and observer failure cannot become documentation judgments', () => {
  assert.equal(classifyAttempt({ ...baseline, stop: { kind: 'declined', reason: 'Maintainer declined' } }).verdict, 'inconclusive');
  assert.equal(classifyAttempt({ ...baseline, outcome: { status: 'error' } }).verdict, 'inconclusive');
});

test('receipt reports actual commands, excerpts, observer evidence, and both timings', () => {
  const markdown = renderReceipt({
    ...baseline,
    check: { kind: 'file', path: 'hello.txt', citation: { path: 'README.md', startLine: 8, quote: 'Read hello.txt' } },
    observerEvidence: { present: true },
    steps: [{ ...baseline.steps[0], actualCommand: 'node ./hello.mjs', durationMs: 5 }],
    timings: { setupMs: 5, infrastructureMs: 18 },
    dependencies: [], artifacts: [{ sha256: 'example' }],
    diagnosis: { confidence: 'low' },
  });
  for (const fragment of ['README.md:8', 'Read hello.txt', 'node ./hello.mjs', '"present": true', 'Setup time: 5 ms', 'Infrastructure time: 18 ms', 'Diagnosis (unverified)']) {
    assert.ok(markdown.includes(fragment), fragment);
  }
});

test('both receipt formats are redacted before consulting the summarizer', async () => {
  const { mkdtemp, readFile, rm, stat, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { loadReceipt, persistReceipt } = await import('../src/receipt.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'ffm-receipt-'));
  const path = join(directory, 'receipt.md');
  const secret = 'example credential!';
  let summaryViewed = false;
  try {
    const attempt = {
      ...baseline,
      steps: [{ ...baseline.steps[0], output: [
        secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
        'Authorization: Bearer hidden-value', '\u001b[30mHello\u001b[0m', '<a href="https://danger.invalid">click</a>',
      ].join('\n') }],
    };
    const result = await persistReceipt({ attempt, path, secrets: [secret], summarize: async evidence => {
      summaryViewed = true;
      assert.equal((await loadReceipt(path)).outcome, 'met');
      assert.ok(!JSON.stringify(evidence).includes(secret));
      evidence.outcome = 'absent';
      throw new Error(secret);
    } });
    assert.equal(summaryViewed, true);
    assert.equal(result.verdict, 'pass');
    assert.match(result.summaryError, /saved/);
    for (const file of [path, result.evidencePath]) {
      const contents = await readFile(file, 'utf8');
      for (const redacted of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'hidden-value', '\u001b']) {
        assert.ok(!contents.includes(redacted), redacted);
      }
      assert.match(contents, /REDACTED/);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.match(result.markdown, /^    <a href=/m);
    await writeFile(path, '# Changed\n');
    await assert.rejects(loadReceipt(path), /do not match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
