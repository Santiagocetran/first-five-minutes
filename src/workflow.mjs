import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readIntake, resolvePlan, approvalDigest, approvePlan } from './intake.mjs';
import { sourceFilesAt } from './repository.mjs';
import { executeAttempt } from './execution.mjs';
import { persistReceipt, redactEvidence } from './receipt.mjs';
import { applyDocumentationEdits, canDiagnose, verifyReplay } from './replay.mjs';

const references = docs => docs.map(({ path, sha256, external }) => ({ path, sha256, external }));

// Redact common credentials before public repository text enters a model session.
// Citation resolution still uses the preserved original bytes.
function modelDocuments(documents, secrets) {
  return redactEvidence(documents.map(({ path, sha256, text, external }) => ({ path, sha256, text, external })), secrets);
}

function confirmOriginal(intake, original) {
  if (intake.revision !== original.revision ||
      !isDeepStrictEqual(references(intake.documents), references(original.documentation))) {
    throw new Error('The original revision or documentation has changed. Start a new baseline.');
  }
}

export async function collectDiagnosis({ intake, original, localRepo, agent, secrets = [] }) {
  if (!canDiagnose(original)) throw new Error('Diagnosis requires a supported blocker.');
  confirmOriginal(intake, original);
  const files = await sourceFilesAt(localRepo, intake.revision);
  const sources = new Map(files.filter(file => file.content.length <= 128_000 &&
    !file.content.includes(0) && !/(?:^|\/)(?:\.env(?:\.|$)|.*\.(?:key|pem)$)/i.test(file.path))
    .map(file => [file.path, file.content]));
  const result = await agent.diagnose({
    attempt: original, documents: modelDocuments(intake.documents, secrets), paths: [...sources.keys()].filter(path => redactEvidence(path, secrets) === path),
    readSource: path => {
      const bytes = sources.get(path);
      if (!bytes) throw new Error('This source is unavailable for diagnosis.');
      return redactEvidence(bytes.toString('utf8'), secrets);
    },
  });
  const safe = redactEvidence(result, secrets);
  if (!isDeepStrictEqual(safe.edits, result.edits)) throw new Error('The proposed edit contains sensitive data.');
  const diff = safe.edits?.length ? redactEvidence(applyDocumentationEdits({ documents: intake.documents, edits: safe.edits }).diff, secrets) : '';
  return { version: 1, verified: false, revision: intake.revision, cause: safe.cause, confidence: safe.confidence, edits: safe.edits ?? [], diff };
}

function comparableCheck(check) {
  if (!check) return null;
  const { citation, ...predicate } = check;
  return predicate;
}

export async function runWorkflow({
  repository, localRepo, revision, config, agent, createSandbox, review,
  outDir, secrets = [], original, edits, summarize,
}) {
  const runId = randomUUID();
  const dir = join(outDir, runId);
  const path = join(dir, 'receipt.md');
  let attempt = {
    runId, repository, revision, model: config.model, modelConnection: config.modelConnection ?? 'fixture', steps: [], outcome: 'unknown',
    approval: 'not requested', teardown: 'not created',
  };
  let result;
  let captured = [];
  try {
    let intake = await readIntake(localRepo, revision, { repository, externalHosts: config.externalHosts ?? [] });
    attempt.revision = intake.revision;
    if (original) {
      confirmOriginal(intake, original);
      if (original.model !== attempt.model || original.modelConnection !== attempt.modelConnection)
        throw new Error('Replay requires the original model and model connection.');
      const updated = applyDocumentationEdits({ documents: intake.documents, edits });
      attempt.editedLines = updated.changes;
      intake = { ...intake, documents: updated.documents };
    }
    captured = intake.documents;
    attempt.documentation = references(captured);
    const proposal = await agent.propose({ readme: redactEvidence(intake.readme, secrets),
      unavailable: redactEvidence(intake.unavailable, secrets), documents: modelDocuments(captured, secrets) });
    const resolved = resolvePlan(intake, proposal, config.catalog);
    const plan = { ...resolved, execution: {
      model: config.model, modelConnection: config.modelConnection,
      teamId: config.teamId, projectId: config.projectId,
      limits: config.limits ?? {}, modelLimits: config.modelLimits ?? {},
    } };
    attempt.environment = plan.environment;
    attempt.check = plan.check;
    attempt.access = plan.access;
    attempt.steps = (plan.steps ?? []).map(step => ({ ...step, state: 'unrun' }));
    if (plan.status !== 'ready') {
      attempt.stop = plan.stop ?? {
        kind: { unsupported: 'unsupported', missing: 'documentation' }[plan.status] ?? 'platform',
        citation: plan.citation,
        reason: plan.reason ?? 'The documentation did not establish a supported attempt.',
      };
    } else if (!isDeepStrictEqual(redactEvidence(plan.steps, secrets), plan.steps) ||
        !isDeepStrictEqual(redactEvidence(plan.requirements, secrets), plan.requirements) ||
        !isDeepStrictEqual(redactEvidence(plan.check, secrets), plan.check)) {
      attempt.stop = { kind: 'unsupported', reason: 'The cited plan contains sensitive or hidden text that cannot be reviewed verbatim.' };
    } else if (original && (!isDeepStrictEqual(comparableCheck(plan.check), comparableCheck(original.check)) ||
      !isDeepStrictEqual(plan.access, original.access) || plan.environment.image !== original.environment?.image)) {
      attempt.stop = { kind: 'platform', reason: 'The proposed replay changed the original check, image or access.' };
    } else {
      const sourceFiles = await sourceFilesAt(localRepo, intake.revision);
      // A replay changes what the newcomer reads. Stage the original source tree.
      const digest = approvalDigest(plan);
      if (!(await review(plan, digest))) return { status: 'declined' };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      attempt.approval = { status: 'approved', digest };
      const approved = approvePlan(plan, digest);
      const executed = await executeAttempt({
        plan: approved, createSandbox, sourceFiles, limits: config.limits, redactValues: secrets,
        drive: async ({ requestEnvironment, runNext }, { signal }) => {
          result = await agent.run({ requestEnvironment, runStep: runNext, plan: approved, signal });
        },
      });
      attempt = { ...attempt, ...executed, approval: { status: 'approved', digest }, documentation: references(intake.documents) };
      if (result?.sessionId && attempt.freshness) attempt.freshness.sessionId = result.sessionId;
    }
  } catch (error) {
    attempt.stop = { kind: error instanceof RangeError ? 'unsupported' : 'platform',
      reason: error.message || 'The attempt could not be completed.' };
  }
  if (original) attempt.replay = verifyReplay({ original, replay: attempt });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Preserve exact external guide bytes when they are shareable. Local guides are
  // reproducible from the pinned Git tree, including uncommitted replay overlays below.
  const captures = captured.filter(doc => doc.external || original);
  for (const doc of captures) {
    if (redactEvidence(doc.text, secrets) !== doc.text) continue;
    if (createHash('sha256').update(doc.bytes).digest('hex') !== doc.sha256) continue;
    await writeFile(join(dir, doc.sha256 + '.guide'), doc.bytes, { mode: 0o600 });
  }
  const saved = await persistReceipt({ path, attempt, secrets, summarize });
  return { status: 'reported', replay: attempt.replay, ...saved };
}

export async function saveDiagnosis(path, diagnosis) {
  await writeFile(path, JSON.stringify(diagnosis, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
