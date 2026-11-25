import { structuredPatch, formatPatch } from 'diff';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { classifyAttempt } from './receipt.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isDocumentationPath = path => typeof path === 'string'
  && path === posix.normalize(path) && /^[a-z0-9_./ -]+$/i.test(path)
  && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))
  && /\.(?:md|markdown|mdx|rst|txt|adoc)$/i.test(path);

// Apply the proposed text replacements to an in-memory copy of the original guides.
export function applyDocumentationEdits({ documents, edits }) {
  if (!Array.isArray(documents) || !Array.isArray(edits) || !edits.length) throw new Error('No documentation edits supplied');
  const original = new Map(documents.map(doc => [doc.path, doc]));
  if (original.size !== documents.length) throw new Error('Duplicate documentation source');
  const updated = new Map();
  for (const edit of edits) {
    const { path, before, after } = edit;
    const doc = original.get(path);
    if (!isDocumentationPath(path) || !doc || doc.external !== false || typeof doc.text !== 'string') {
      throw new Error('Edit target is not a captured local documentation file');
    }
    if (typeof before !== 'string' || !before || typeof after !== 'string' || before === after) {
      throw new Error('Edit must supply different original and replacement text');
    }
    if (doc.sha256 && sha256(Buffer.from(doc.text, 'utf8')) !== doc.sha256) {
      throw new Error('Original documentation bytes do not match the source identity');
    }
    const text = updated.get(path) ?? doc.text;
    const index = text.indexOf(before);
    if (index < 0 || text.indexOf(before, index + 1) >= 0) {
      throw new Error('Original edit text must occur exactly once');
    }
    updated.set(path, text.slice(0, index) + after + text.slice(index + before.length));
  }
  const changes = [];
  let diff = '';
  for (const [path, text] of updated) {
    const doc = original.get(path);
    if (text === doc.text) continue;
    const patch = structuredPatch('a/' + path, 'b/' + path, doc.text, text, undefined, undefined,
      { context: 0, timeout: 500 });
    if (!patch) throw new Error('Documentation diff exceeded the supported comparison limit');
    diff += formatPatch(patch);
    for (const { oldStart, oldLines, newStart, newLines } of patch.hunks)
      changes.push({ path, before: doc.sha256, after: sha256(text), oldStart, oldLines, newStart, newLines });
  }
  if (!diff) throw new Error('Proposed documentation changes cancel out');
  return {
    diff, changes,
    documents: documents.map(doc => {
      const text = updated.get(doc.path);
      if (text == null || text === doc.text) return doc;
      const bytes = Buffer.from(text, 'utf8');
      return { ...doc, text, bytes, sha256: sha256(bytes) };
    }),
  };
}

export function canDiagnose(attempt) {
  return classifyAttempt(attempt).verdict === 'blocked';
}

function withoutCitation(check) {
  if (typeof check !== 'object' || check == null) return check;
  const { citation, ...definition } = check;
  return definition;
}

function comparableValue(value) {
  if (value == null || value === '' || value === '[REDACTED]') return false;
  return !JSON.stringify(value).includes('[REDACTED');
}

function fresh(freshness) {
  return freshness?.clean === true && freshness?.priorState === false
    && [freshness.sessionId, freshness.sandboxId].every(id => typeof id === 'string' && comparableValue(id));
}

function documentationIds(documents) {
  if (!Array.isArray(documents) || !documents.length) return null;
  const entries = new Map();
  for (const doc of documents) {
    if (typeof doc.path !== 'string' || !doc.path || entries.has(doc.path) || !/^[a-f0-9]{64}$/.test(doc.sha256)) return null;
    entries.set(doc.path, { sha256: doc.sha256, external: doc.external });
  }
  return entries;
}

// Compare independent controller records. The check citation may change with the guide,
// but the actual observer predicate must not change.
export function verifyReplay({ original, replay }) {
  const mismatch = reason => ({ verdict: 'inconclusive', verified: false, reason });
  if (!original || !replay || !canDiagnose(original)) return mismatch('The original attempt did not record a supported blocker.');
  if (classifyAttempt(replay).verdict !== 'pass') return mismatch('The replay did not independently pass.');
  if (!fresh(original.freshness) || !fresh(replay.freshness)
      || original.freshness.sessionId === replay.freshness.sessionId
      || original.freshness.sandboxId === replay.freshness.sandboxId) {
    return mismatch('Independent sessions and sandboxes without carried-over state were not established.');
  }
  const fields = [
    ['revision', original.revision, replay.revision],
    ['model', original.model, replay.model],
    ['model connection', original.modelConnection, replay.modelConnection],
    ['environment identity', original.environment, replay.environment],
    ['approved check', withoutCitation(original.check), withoutCitation(replay.check)],
    ['access rules', original.access, replay.access],
    ['dependency identities', original.dependencies, replay.dependencies],
    ['artifact identities', original.artifacts, replay.artifacts],
  ];
  for (const [name, a, b] of fields) {
    if (!comparableValue(a) || !comparableValue(b)) return mismatch(`Missing or redacted ${name}.`);
    if (!isDeepStrictEqual(a, b)) return mismatch(`Replay changed the ${name}.`);
  }
  const before = documentationIds(original.documentation);
  const after = documentationIds(replay.documentation);
  if (!before || !after) return mismatch('Original and replay documentation identities were not recorded.');
  const changed = new Set();
  for (const [path, doc] of before) {
    const revised = after.get(path);
    if (!revised || revised.external !== doc.external) return mismatch('Replay changed the documentation source set.');
    if (revised.sha256 !== doc.sha256) {
      if (doc.external !== false || !isDocumentationPath(path)) return mismatch('Replay changed an ineligible documentation source.');
      changed.add(path);
    }
  }
  if (after.size !== before.size) return mismatch('Replay changed the documentation source set.');
  if (!changed.size) return mismatch('Replay used unchanged documentation.');
  const failure = original.steps.findIndex(step => step.state === 'completed' && step.exitCode !== 0);
  const prefix = failure < 0 ? original.steps : original.steps.slice(0, failure + 1);
  const updated = failure < 0 ? replay.steps : replay.steps.slice(0, prefix.length);
  const same = (a, b) => a?.command === b?.command && (a?.mode ?? 'foreground') === (b?.mode ?? 'foreground');
  let first = 0;
  while (first < prefix.length && first < updated.length && same(prefix[first], updated[first])) first++;
  if (first === prefix.length && first === updated.length)
    return mismatch('The revised guide did not change the procedure through the original blocker.');
  const touched = (step, side) => {
    if (!step) return false;
    const reference = typeof step.citation === 'string' ? /^(.*):(\d+)$/.exec(step.citation) : null;
    const path = reference?.[1] ?? step.citation?.path;
    const start = Number(reference?.[2] ?? step.citation?.startLine);
    if (!changed.has(path) || !Number.isInteger(start)) return false;
    const source = step.citation?.quote;
    const locations = source ? source.split('\n').flatMap((line, index) =>
      step.command.split('\n').some(cmd => line.trim().replace(/^\$ /, '') === cmd.trim() ||
        line.includes('`' + cmd + '`')) ? [start + index] : []) : [start];
    return replay.editedLines?.some(change =>
      change.path === path && change.before === before.get(path).sha256 && change.after === after.get(path).sha256 &&
      locations.some(line => line >= change[side + 'Start'] && line < change[side + 'Start'] + change[side + 'Lines']));
  };
  if (!touched(prefix[first], 'old') && !touched(updated[first], 'new'))
    return mismatch('The first changed action through the blocker did not overlap an edited command line.');
  return { verdict: 'pass', verified: true, reason: 'The original blocked and the revised documentation passed an independent, comparable replay.' };
}
