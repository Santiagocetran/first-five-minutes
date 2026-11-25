import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function outcomeStatus(outcome) {
  return typeof outcome === 'object' ? outcome?.status : outcome;
}

function citationText(citation) {
  if (typeof citation === 'string') return citation;
  if (!citation?.path) return 'unavailable';
  const line = citation.startLine;
  return line ? `${citation.path}:${line}${citation.endLine > line ? '-' + citation.endLine : ''}` : citation.path;
}

// Only controller observations are inputs to this judgment, never model prose.
export function classifyAttempt({ stop, steps = [], outcome }) {
  if (stop) {
    let verdict = 'inconclusive';
    if (stop.kind === 'unsupported') verdict = 'unsupported';
    if (stop.kind === 'documentation') verdict = 'blocked';
    return { verdict, reason: stop.reason };
  }
  for (const step of steps) {
    if (step.state !== 'completed' || !Number.isInteger(step.exitCode)) {
      return { verdict: 'inconclusive', reason: 'A documented step has no confirmed result.' };
    }
    if (step.exitCode !== 0) {
      return { verdict: 'blocked', reason: `The step at ${citationText(step.citation)} exited with ${step.exitCode}.` };
    }
  }
  if (steps.length && outcomeStatus(outcome) === 'met') {
    return { verdict: 'pass', reason: 'The approved outcome was observed.' };
  }
  if (steps.length && outcomeStatus(outcome) === 'absent') {
    return { verdict: 'blocked', reason: 'The observer confirmed the expected outcome was absent.' };
  }
  return { verdict: 'inconclusive', reason: 'Evidence for the approved outcome is incomplete.' };
}

const SECRET_KEY = /^(?:password|secret|secrets|credential|credentials|authorization|cookie|accessToken|refreshToken|apiKey|privateKey|.*_(?:TOKEN|KEY|PASSWORD|SECRET))$/i;

function redactString(value, variants) {
  let result = value
    // Drop ANSI CSI/OSC sequences and terminal/bidi control characters.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
  for (const item of variants) result = result.split(item).join('[REDACTED]');
  return result
    .replace(/\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b((?:(?:[\w-]+[-_])?(?:ACCESS[-_]?TOKEN|REFRESH[-_]?TOKEN|API[-_]?KEY|PRIVATE[-_]?KEY|TOKEN|PASSWORD|SECRET)|COOKIE)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/[^\s?#)<>]+)\?[^\s#)<>]*/gi, '$1?[REDACTED]')
    .replace(/\b(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-(?:proj-)?[\w-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]');
}

export function redactEvidence(value, secrets = []) {
  const variants = [...new Set(secrets.filter(item => typeof item === 'string' && item.length).flatMap(item =>
    [item, encodeURIComponent(item), Buffer.from(item).toString('base64'), JSON.stringify(item).slice(1, -1)],
  ))].sort((a, b) => b.length - a.length);
  function visit(item) {
    if (typeof item === 'string') return redactString(item, variants);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) =>
        [redactString(key, variants), SECRET_KEY.test(key) ? '[REDACTED]' : visit(entry)]));
    }
    return item;
  }
  return visit(value);
}

function evidenceForStorage(attempt, secrets) {
  const { documentation, ...rest } = attempt;
  const evidence = redactEvidence({
    ...rest,
    ...(documentation ? { documentation: Array.isArray(documentation)
      ? documentation.map(({ text, bytes, ...reference }) => reference) : documentation } : {}),
  }, secrets);
  return JSON.parse(JSON.stringify(evidence));
}

const plain = value => String(value ?? 'not recorded')
  .replace(/\s+/g, ' ')
  .replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  .replace(/[\\`*_{}\[\]()!|]/g, '\\$&');
const indent = value => String(value).split('\n').map(line => '    ' + line).join('\n');
const serialized = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function renderSanitized(attempt) {
  const { verdict, reason } = classifyAttempt(attempt);
  const outcome = outcomeStatus(attempt.outcome);
  const steps = attempt.steps ?? [];
  const last = steps.filter(step => step.state === 'completed' && step.exitCode === 0).at(-1);
  const failed = steps.find(step => step.state === 'completed' && Number.isInteger(step.exitCode) && step.exitCode !== 0);
  const unrun = steps.filter(step => step.state === 'unrun');
  const checkCitation = typeof attempt.check === 'object' ? attempt.check?.citation : undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify(attempt)).digest('hex');
  const lines = [
    `# ${attempt.replay?.verdict ?? verdict}`, '', plain(attempt.replay?.reason ?? reason), '',
    ...(attempt.replay ? [`- Replay attempt: ${verdict}. ${plain(reason)}`] : []),
    `- Run: ${plain(attempt.runId)}`,
    `- Model: ${plain(attempt.model)} (${plain(attempt.modelConnection)})`,
    `- Repository: ${plain(attempt.repository)}`,
    `- Revision: ${plain(attempt.revision)}`,
    `- Environment: ${plain(typeof attempt.environment === 'object' ? attempt.environment?.image ?? attempt.environment?.id : attempt.environment)}`,
    `- Approval: ${plain(typeof attempt.approval === 'object' ? attempt.approval?.status : attempt.approval)}`,
    `- Observed outcome: ${plain(outcome)}`,
    `- Precondition: ${plain(attempt.precondition)}`,
    `- Last successful action: ${last ? plain(last.actualCommand ?? last.command) + ' (' + plain(citationText(last.citation)) + ')' : 'none'}`,
    `- First blocker: ${attempt.stop || failed || outcome === 'absent' ? plain(reason) : 'none recorded'}`,
    `- Steps left unrun: ${unrun.length}`,
    `- Setup time: ${plain(attempt.timings?.setupMs ?? attempt.setupMs)}${(attempt.timings?.setupMs ?? attempt.setupMs) != null ? ' ms' : ''}`,
    `- Infrastructure time: ${plain(attempt.timings?.infrastructureMs ?? attempt.infrastructureMs)}${(attempt.timings?.infrastructureMs ?? attempt.infrastructureMs) != null ? ' ms' : ''}`,
    `- Teardown: ${plain(typeof attempt.teardown === 'object' ? attempt.teardown?.status : attempt.teardown)}`,
    `- Evidence SHA-256: ${fingerprint}`,
    '', '## Approved check', '',
  ];
  function code(value) {
    if (value != null && value !== '') lines.push(indent(serialized(value)), '');
  }
  function cited(citation) {
    if (!citation) return;
    lines.push(`Source: ${plain(citationText(citation))}`, '');
    if (citation.sha256) lines.push(`Source SHA-256: ${plain(citation.sha256)}`, '');
    code(citation.quote);
  }
  code(attempt.check && typeof attempt.check === 'object'
    ? Object.fromEntries(Object.entries(attempt.check).filter(([key]) => key !== 'citation')) : attempt.check);
  cited(checkCitation);
  if (attempt.stop?.citation) cited(attempt.stop.citation);
  if (attempt.observerEvidence ?? attempt.outcome?.evidence) {
    lines.push('Observer evidence', '');
    code(attempt.observerEvidence ?? attempt.outcome?.evidence);
  }
  if (attempt.requirements?.length) {
    lines.push('## Documented prerequisites', '');
    for (const requirement of attempt.requirements) {
      lines.push(plain(requirement.runtime) + ' ' + plain(requirement.version), '');
      cited(requirement.citation);
    }
  }
  lines.push('## Documented steps', '');
  for (const step of steps) {
    lines.push(`### ${plain(citationText(step.citation))} (${plain(step.state)})`, '');
    cited(step.citation);
    lines.push('Requested command', '');
    code(step.command);
    if (step.actualCommand) {
      lines.push('Actual command', '');
      code(step.actualCommand);
    }
    if (Number.isInteger(step.exitCode)) lines.push(`Exit code: ${step.exitCode}`, '');
    if (Number.isFinite(step.durationMs)) lines.push(`Elapsed: ${step.durationMs} ms`, '');
    for (const output of [step.output, step.stdout, step.stderr]) code(output);
  }
  for (const [title, value] of [
    ['Environment identity', typeof attempt.environment === 'object' ? attempt.environment : undefined],
    ['Freshness evidence', attempt.freshness],
    ['Access rules', attempt.access], ['Documentation sources', attempt.documentation],
    ['Dependency identities', attempt.dependencies], ['Artifact identities', attempt.artifacts],
    ['Diagnosis (unverified)', attempt.diagnosis], ['Replay comparison', attempt.replay],
  ]) {
    if (value == null) continue;
    lines.push(`## ${title}`, '');
    code(value);
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function renderReceipt(attempt, { secrets = [] } = {}) {
  return renderSanitized(evidenceForStorage(attempt, secrets));
}

async function atomicWrite(path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Markdown is the deterministic receipt. The adjacent structured evidence is for replay.
export async function persistReceipt({ attempt, path, secrets = [], summarize }) {
  const evidence = evidenceForStorage(attempt, secrets);
  const markdown = renderSanitized(evidence);
  const evidencePath = path + '.json';
  await atomicWrite(path, markdown);
  await atomicWrite(evidencePath, JSON.stringify({ version: 1, attempt: evidence }, null, 2) + '\n');
  const result = { ...(evidence.replay ?? classifyAttempt(evidence)), path, evidencePath, markdown };
  if (summarize) {
    try {
      result.summary = redactEvidence(await summarize(structuredClone(evidence)), secrets);
    } catch {
      result.summaryError = 'Model summary failed. The deterministic receipt was saved.';
    }
  }
  return result;
}

export async function loadReceipt(path) {
  const stored = JSON.parse(await readFile(path + '.json', 'utf8'));
  if (stored?.version !== 1 || !stored.attempt || typeof stored.attempt !== 'object'
      || !Array.isArray(stored.attempt.steps)) throw new Error('Unrecognized receipt evidence');
  const markdown = await readFile(path, 'utf8');
  if (markdown !== renderSanitized(stored.attempt)) throw new Error('Markdown and structured evidence do not match');
  return stored.attempt;
}
