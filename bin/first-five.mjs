#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { liveConfig } from '../src/config.mjs';
import { withRepository } from '../src/repository.mjs';
import { classifyAttempt, loadReceipt, redactEvidence } from '../src/receipt.mjs';

const help = `First Five Minutes

  first-five run REPO [REV] --config FILE
  first-five diagnose RECEIPT.md --config FILE
  first-five replay RECEIPT.md --edits DIAGNOSIS.json --config FILE
  first-five demo [--out DIRECTORY]

REPO can be a local Git repository or a public HTTPS Git URL. REV defaults to HEAD.
Live modes use the configured model. A VM is created only after plan approval.
Use --out DIRECTORY to choose where to save receipts (default .first-five).
For automation, --approve DIGEST approves only the exact plan shown previously.
The demo uses bundled synthetic repositories and local disposable Docker containers.`;

function getSecrets() {
  return Object.entries(process.env).filter(([k, v]) =>
    /(?:TOKEN|KEY|SECRET|PASSWORD)$/i.test(k) && v.length >= 4).map(([, v]) => v);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, approve: { type: 'string' }, out: { type: 'string' },
      edits: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !positionals.length) { console.log(help); return; }
  const [action, target, revision = 'HEAD'] = positionals;
  const outDir = resolve(values.out ?? '.first-five');
  if (action === 'demo' && positionals.length === 1) {
    const { runDemo } = await import('../src/demo.mjs');
    await runDemo(outDir);
    return;
  }
  if (!['run', 'replay', 'diagnose'].includes(action) || !target || !values.config ||
      positionals.length > (action === 'run' ? 3 : 2) || (action === 'replay' && !values.edits))
    throw new Error(help);

  const config = liveConfig(JSON.parse(await readFile(values.config, 'utf8')), action);
  const modelKey = config.modelConnection === 'openai' ? 'OPENAI_API_KEY' : 'AI_GATEWAY_API_KEY';
  if (!process.env[modelKey]) throw new Error('The selected model connection needs ' + modelKey + '.');
  const secrets = getSecrets();
  const { createEveAgent } = await import('../src/eve.mjs');
  const { makeVercelSandboxFactory } = await import('../src/sandbox.mjs');
  const { readIntake } = await import('../src/intake.mjs');
  const { runWorkflow, collectDiagnosis, saveDiagnosis } = await import('../src/workflow.mjs');
  const { Sandbox } = await import('@vercel/sandbox');
  const agent = await createEveAgent({ model: config.model, modelConnection: config.modelConnection, ...config.modelLimits });
  const review = async (plan, digest) => {
    console.log('Proposed attempt\n' + JSON.stringify(redactEvidence(plan, secrets), null, 2));
    console.log('Approval digest: ' + digest);
    if (values.approve) return values.approve === digest;
    if (!process.stdin.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await prompt.question('Run this plan? [y/N] ')).trim().toLowerCase() === 'y'; }
    finally { prompt.close(); }
  };
  try {
    const original = action !== 'run' ? await loadReceipt(target) : undefined;
    const repository = original?.repository ?? (target.includes('://') ? target : resolve(target));
    const ref = original?.revision ?? revision;
    await withRepository(repository, ref, async (localRepo, resolvedRef) => {
      if (action === 'diagnose') {
        const intake = await readIntake(localRepo, resolvedRef, { repository, externalHosts: config.externalHosts });
        const diagnosis = await collectDiagnosis({ original, intake, localRepo, agent, secrets });
        const file = resolve(target) + '.diagnosis.json';
        await saveDiagnosis(file, diagnosis);
        console.log(`Unverified diagnosis saved to ${file}\n${diagnosis.diff || diagnosis.cause}`);
        return;
      }
      let edits;
      if (original) {
        if (classifyAttempt(original).verdict !== 'blocked') throw new Error('Replay requires a blocked baseline.');
        const diagnosis = JSON.parse(await readFile(values.edits, 'utf8'));
        if (diagnosis.revision !== original.revision) throw new Error('The proposed edit targets another revision.');
        edits = diagnosis.edits;
      }
      const createSandbox = request => makeVercelSandboxFactory({
        Sandbox, auth: { projectId: config.projectId, teamId: config.teamId, token: process.env.VERCEL_TOKEN },
        limits: config.limits,
      })(request);
      const result = await runWorkflow({ repository, localRepo, revision: resolvedRef, original, edits,
        config, agent, createSandbox, review, outDir, secrets });
      if (result.status === 'declined') {
        console.log('Plan declined. No sandbox was created.');
        process.exitCode = 2;
      } else {
        console.log(result.markdown);
        console.log('Receipt: ' + result.path);
        if (result.verdict !== 'pass' || result.replay?.verified === false) process.exitCode = 1;
      }
    });
  } finally { await agent.close(); }
}

main().catch(error => {
  console.error(redactEvidence(String(error.message), getSecrets()));
  process.exitCode = 2;
});
