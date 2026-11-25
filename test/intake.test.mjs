import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIntake, resolvePlan, approvalDigest, approvePlan, assertApprovedPlan } from '../src/intake.mjs';

const catalog = [
  { provider: 'vercel', runtime: 'node', version: '22.1.0', image: 'vercel/sandbox/node@sha256:' + 'a'.repeat(64) },
  { provider: 'vercel', runtime: 'python', version: '3.13.2', image: 'vercel/sandbox/python@sha256:' + 'b'.repeat(64) },
];
const cite = (line) => ({ path: 'docs/quickstart.md', startLine: line, endLine: line });

async function fixture(t, guide) {
  const repo = await mkdtemp(join(tmpdir(), 'ffm-git-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q');
  await mkdir(join(repo, 'docs'));
  await writeFile(join(repo, 'README.md'), '[Quickstart][setup]\n\n[setup]: docs/quickstart.md\n');
  await writeFile(join(repo, 'docs/quickstart.md'), guide);
  await writeFile(join(repo, 'internal.md'), 'Private if unlinked');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'docs/quickstart.md'), 'Uncommitted fake instructions');
  return { intake: await readIntake(repo, 'HEAD'), revision };
}

test('reads exact README and explicit guide from the resolved Git commit and freezes approval', async (t) => {
  const guide = 'Requires Node.js 22.\r\nRun `npm test`.\r\nThen run `npm run serve`.\r\nOpen http://localhost:3000 and see Welcome.\r\n';
  const { intake, revision } = await fixture(t, guide);
  assert.equal(intake.revision, revision);
  assert.deepEqual(intake.documents.map((doc) => doc.path), ['README.md', 'docs/quickstart.md']);
  assert.equal(intake.documents[1].bytes.toString(), guide);
  intake.documents[1].bytes[0] = 0;
  assert.equal(intake.documents[1].bytes.toString(), guide);
  const proposal = {
    status: 'ready', requirements: [{ runtime: 'node', version: '22.x', citation: cite(1) }],
    steps: [
      { command: 'npm test', citation: cite(2) },
      { command: 'npm run serve', mode: 'service', citation: cite(3) },
    ],
    access: { egress: [] },
    check: { kind: 'http', url: 'http://localhost:3000', contains: 'Welcome', citation: cite(4) },
  };
  assert.equal(resolvePlan(intake, { ...proposal, access: { egress: ['registry.npmjs.org'] } }, catalog).status, 'unsupported');
  const plan = resolvePlan(intake, proposal, catalog);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.environment.image, 'vercel/sandbox/node@sha256:' + 'a'.repeat(64));
  assert.match(plan.steps[1].citation.quote, /npm run serve/);
  assert.throws(() => approvePlan(plan, 'declined'), /match/);
  assert.throws(() => assertApprovedPlan(plan), /approved/);
  const approved = approvePlan(plan, approvalDigest(plan));
  assert.throws(() => { approved.check.url = 'http://localhost:8080'; }, TypeError);
  assert.equal(assertApprovedPlan(approved), approved);
  proposal.requirements[0].version = '24.x';
  assert.equal(resolvePlan(intake, proposal, catalog).status, 'ambiguous');
  proposal.requirements[0].version = '22.x';
  proposal.steps[1].command = 'run serve';
  assert.equal(resolvePlan(intake, proposal, catalog).status, 'ambiguous');
});

test('resolves Python and a cited file check without a repository profile', async (t) => {
  const { intake } = await fixture(t, 'You need Python 3.13 or later.\n`python3 build.py`\nLook for result.json.\n');
  const proposal = {
    status: 'ready', requirements: [{ runtime: 'python', version: '>=3.13', citation: cite(1) }],
    steps: [{ command: 'python3 build.py', citation: cite(2) }],
    check: { kind: 'file', path: 'result.json', citation: cite(3) },
  };
  const [node] = catalog;
  assert.equal(resolvePlan(intake, proposal, [node]).status, 'unsupported');
  assert.equal(resolvePlan(intake, proposal, catalog).environment.image, 'vercel/sandbox/python@sha256:' + 'b'.repeat(64));
  assert.equal(resolvePlan(intake, { status: 'ambiguous', reason: 'Unclear path', citation: cite(3) }, catalog).status, 'ambiguous');
  assert.equal(resolvePlan(intake, { status: 'missing', reason: 'Unspecified output name', citation: cite(3) }, catalog).status, 'missing');
});
