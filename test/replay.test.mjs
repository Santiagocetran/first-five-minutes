import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyDocumentationEdits, canDiagnose, verifyReplay } from '../src/replay.mjs';

const makeDoc = (path, text, external = false) => ({
  path, text, bytes: Buffer.from(text), sha256: createHash('sha256').update(text).digest('hex'), external,
});
const documents = [
  makeDoc('README.md', '# Quickstart\n\n`node helo.mjs`\n'),
  makeDoc('https://example.invalid/setup', 'Read only', true),
];
const edit = { path: 'README.md', before: 'node helo.mjs', after: 'node hello.mjs' };
const approvedCheck = { kind: 'file', path: 'out.txt', precondition: 'absent', citation: { path: 'README.md', quote: 'Check the file.' } };
const original = {
  revision: 'fixed revision', model: 'offline/test', modelConnection: 'fixture',
  environment: { id: 'node', image: 'image sha256:known' },
  access: { network: 'none' },
  check: approvedCheck,
  documentation: documents,
  dependencies: [],
  artifacts: [{ path: 'hello.mjs', sha256: 'known source' }],
  freshness: { clean: true, priorState: false, sessionId: 'first session', sandboxId: 'first sandbox' },
  steps: [{ citation: 'README.md:3', state: 'completed', command: 'node helo.mjs', exitCode: 1 }],
  outcome: 'unchecked',
};
const proposal = applyDocumentationEdits({ documents, edits: [edit] });
const replay = {
  ...original,
  documentation: proposal.documents,
  editedLines: proposal.changes,
  check: { ...approvedCheck, citation: { ...approvedCheck.citation, startLine: 6 } },
  freshness: { clean: true, priorState: false, sessionId: 'replay session', sandboxId: 'replay sandbox' },
  steps: [{ citation: 'README.md:3', state: 'completed', command: 'node hello.mjs', exitCode: 0 }],
  outcome: 'met',
};

test('documentation patch is minimal and never mutates captured base docs', () => {
  assert.match(proposal.diff, /--- a\/README\.md\n\+\+\+ b\/README\.md/);
  assert.match(proposal.diff, /^-\x60node helo\.mjs\x60\n\+\x60node hello\.mjs\x60$/m);
  assert.notEqual(proposal.documents[0].sha256, documents[0].sha256);
  assert.equal(documents[0].text, '# Quickstart\n\n`node helo.mjs`\n');
  assert.equal(proposal.documents[1], documents[1]);
});

test('proposal rejects non-docs, external sources, mismatched bytes and ambiguous context', () => {
  for (const [docs, change] of [
    [documents, { ...edit, path: 'https://example.invalid/setup' }],
    [[makeDoc('src/hello.mjs', 'node helo.mjs')], { ...edit, path: 'src/hello.mjs' }],
    [[makeDoc('../README.md', 'node helo.mjs')], { ...edit, path: '../README.md' }],
    [[makeDoc('README.md', 'node helo.mjs. node helo.mjs')], edit],
    [[{ ...documents[0], text: 'node helo.mjs tampered' }], edit],
    [documents, { ...edit, after: edit.before }],
  ]) {
    assert.throws(() => applyDocumentationEdits({ documents: docs, edits: [change] }));
  }
});

test('a supported original blocker and fresh comparable pass verifies revised docs', () => {
  assert.equal(canDiagnose(original), true);
  assert.equal(verifyReplay({ original, replay }).verified, true);
});

for (const [name, changes] of [
  ['changed model', { model: 'another/model' }],
  ['changed revision', { revision: 'other' }],
  ['changed image', { environment: { ...replay.environment, image: 'other' } }],
  ['changed access', { access: { network: 'all' } }],
  ['changed check', { check: { ...approvedCheck, path: 'some-other-file' } }],
  ['changed artifacts', { artifacts: [{ path: 'hello.mjs', sha256: 'different source' }] }],
  ['changed dependencies', { dependencies: ['additional artifact'] }],
  ['missing artifact evidence', { artifacts: undefined }],
  ['unchanged docs', { documentation: original.documentation }],
  ['unchanged instructions in revised docs', { steps: [{ ...replay.steps[0], command: original.steps[0].command }] }],
  ['changed external docs', { documentation: [proposal.documents[0], makeDoc(documents[1].path, 'Changed', true)] }],
  ['reused VM', { freshness: { ...replay.freshness, sandboxId: original.freshness.sandboxId } }],
  ['reused session', { freshness: { ...replay.freshness, sessionId: original.freshness.sessionId } }],
  ['carried-over state', { freshness: { ...replay.freshness, priorState: true } }],
  ['failed observation', { outcome: 'error' }],
]) {
  test(name + ' prevents a verified improvement', () => {
    const comparison = verifyReplay({ original, replay: { ...replay, ...changes } });
    assert.equal(comparison.verdict, 'inconclusive');
    assert.equal(comparison.verified, false);
  });
}

test('infrastructure stop cannot be diagnosed as a supported blocker', () => {
  const attempt = { ...original, stop: { kind: 'platform', reason: 'Sandbox creation failed' } };
  assert.equal(canDiagnose(attempt), false);
  assert.equal(verifyReplay({ original: attempt, replay }).verified, false);
});

test('an edited downstream command cannot explain a previously failed step', () => {
  const first = original.steps[0];
  const originalRun = { ...original, steps: [first, { command: 'later', state: 'unrun' }] };
  const replayRun = { ...replay, steps: [{ ...first, exitCode: 0 },
    { command: 'revised-later', state: 'completed', exitCode: 0 }] };
  assert.equal(verifyReplay({ original: originalRun, replay: replayRun }).verified, false);
});

test('an unrelated edit in the same guide cannot verify switching between existing commands', () => {
  const text = 'Old title\nnode first.js\nnode second.js\n';
  const docs = [makeDoc('README.md', text)];
  const updated = applyDocumentationEdits({ documents: docs, edits: [{ path: 'README.md', before: 'Old title', after: 'New title' }] });
  const baseline = { ...original, documentation: docs,
    steps: [{ command: 'node first.js', state: 'completed', exitCode: 1, citation: 'README.md:2' }] };
  const rerun = { ...replay, documentation: updated.documents, editedLines: updated.changes,
    steps: [{ command: 'node second.js', state: 'completed', exitCode: 0, citation: 'README.md:3' }] };
  assert.equal(verifyReplay({ original: baseline, replay: rerun }).verified, false);
});
