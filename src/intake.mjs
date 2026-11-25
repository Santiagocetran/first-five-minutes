import { documentedDownload } from './download.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posix, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import semver from 'semver';

const exec = promisify(execFile);
const approved = new WeakSet();
const MAX_DOC = 64 * 1024;
const MAX_DOCS = 12;
const MAX_TREE = 8 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const git = async (dir, args, maxBuffer = MAX_DOC) =>
  (await exec('git', ['--no-replace-objects', '-C', dir, ...args], {
    maxBuffer, encoding: 'buffer', timeout: 10000, env: {
      PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
    },
  })).stdout;
const plainPath = (p) => typeof p === 'string' && p.length > 0 && p.length < 512 &&
  !/[\\\u0000-\u001f\u007f]/u.test(p) && !p.startsWith('/') &&
  p.split('/').every((part) => part && !['.', '..', '.git'].includes(part.toLowerCase()));
const isGuide = (name) => /(?:getting[ _-]?started|quick[ _-]?start|setup|install|onboard|tutorial|usage|readme|run locally|local development)/i.test(name);
const localGuide = (name) => /\.(?:md|mdx|rst|txt|markdown)$/i.test(name);
const linesOf = (text) => text.split(/\r?\n/);

function links(text) {
  let fence;
  const visible = linesOf(text).filter((line) => {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence;
  }).join('\n').replace(/<!--[\s\S]*?-->/g, '');
  const refs = new Map([...visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*<?([^\s>]+)>?/gm)]
    .map((m) => [m[1].trim().toLowerCase(), m[2]]));
  return [
    ...[...visible.matchAll(/(?<!!)\[([^\]\n]+)\]\(<?([^\s)>]+)>?(?:[ \t]+["'][^"']*["'])?\)/g)].map((m) => [m[1], m[2]]),
    ...[...visible.matchAll(/(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/g)]
      .map((m) => [m[1], refs.get((m[2] || m[1]).trim().toLowerCase())]).filter(([, url]) => url),
    ...[...visible.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi)].map((m) => [m[2], m[1]]),
  ].filter(([label, url]) => isGuide(label) || isGuide(url) || localGuide(url.split('#')[0]));
}

async function externalGuide(url) {
  // Connect to the same verified public IP that DNS returned. No redirect, cookies, or auth.
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
    throw new Error('External guide DNS did not resolve to public addresses only');
  }
  return new Promise((resolveBytes, reject) => {
    const ip = addresses[0];
    const req = request(url, {
      lookup: (_name, options, cb) => options.all ? cb(null, [ip]) : cb(null, ip.address, ip.family),
      headers: { accept: 'text/markdown, text/plain, text/html' }, signal: AbortSignal.timeout(5000),
    }, (res) => {
      if (res.statusCode !== 200 || !/^text\/(markdown|plain|html|x-markdown)(?:;|$)/i.test(res.headers['content-type'] ?? '')) {
        res.resume();
        reject(new Error('External guide did not return a supported text response'));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('error', reject);
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_DOC) req.destroy(new Error('External guide exceeded the byte limit'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolveBytes(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

function document(path, bytes, external) {
  const raw = Buffer.from(bytes);
  const text = utf8.decode(raw);
  if (text.includes('\0')) throw new Error('Not a text guide');
  return Object.freeze({ path, sha256: sha(raw), external, text, get bytes() { return Buffer.from(raw); } });
}

export async function readIntake(localRepo, ref = 'HEAD', { repository, externalHosts = [] } = {}) {
  const dir = resolve(localRepo);
  if (typeof ref !== 'string' || !ref || ref.length > 512 || /[\x00-\x20]/.test(ref)) throw new Error('Invalid revision');
  const revision = (await git(dir, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).toString().trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('Expected a Git commit identity');
  const entries = new Map();
  for (const entry of utf8.decode(await git(dir, ['ls-tree', '-r', '-z', revision], MAX_TREE)).split('\0').filter(Boolean)) {
    const match = entry.match(/^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/);
    if (!match) throw new Error('Unexpected Git tree entry');
    entries.set(match[4], { mode: match[1], oid: match[3] });
  }
  const root = [...entries.keys()].filter((p) => /^readme(?:\.(?:md|mdx|rst|txt|markdown))?$/i.test(p))
    .sort((a, b) => Number(!/\.md$/i.test(a)) - Number(!/\.md$/i.test(b)) || a.localeCompare(b))[0];
  const documents = [];
  const unavailable = [];
  const seen = new Set();
  const pending = root ? [{ path: root, external: false }] : [];
  const allow = new Set(externalHosts.map((h) => h.toLowerCase()));
  const blob = (entry, max) => git(dir, ['cat-file', 'blob', entry.oid], max);
  while (pending.length && documents.length < MAX_DOCS) {
    const { path, external, linkedFrom } = pending.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const entry = entries.get(path);
      if (!external && (!entry || !/^100(?:644|755)$/.test(entry.mode)))
        throw new Error('Not a committed regular file');
      const doc = document(path, external ? await externalGuide(new URL(path)) : await blob(entry, MAX_DOC), external);
      documents.push(doc);
      for (const [, target] of links(doc.text)) {
        if (target.startsWith('#')) continue;
        try {
          if (external || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) {
            const url = external ? new URL(target, doc.path) : new URL(target);
            url.hash = '';
            if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search ||
              !allow.has(url.hostname)) throw new Error('External guide is outside the approved HTTPS host list');
            pending.push({ path: url.href, external: true, linkedFrom: path });
          } else {
            const raw = decodeURIComponent(target.split('#', 1)[0]);
            const refPath = raw.startsWith('/') ? posix.normalize(raw.slice(1)) : posix.join(posix.dirname(path), raw);
            if (!plainPath(refPath)) throw new Error('Unsafe documentation link');
            const found = entries.has(refPath) ? refPath
              : [...entries.keys()].find((p) => posix.dirname(p) === refPath.replace(/\/$/, '') && /^readme(?:\.|$)/i.test(posix.basename(p)));
            const guidePath = found ?? refPath;
            if (!localGuide(guidePath) && !/^readme$/i.test(posix.basename(guidePath))) continue;
            pending.push({ path: guidePath, external: false, linkedFrom: path });
          }
        } catch {
          if (unavailable.length < MAX_DOCS) unavailable.push({ linkedFrom: path, reason: 'Documentation link not readable under the intake policy' });
        }
      }
    } catch {
      unavailable.push({ path, linkedFrom, reason: 'Guide bytes unavailable or unsupported under the intake limits' });
    }
  }
  if (pending.some(({ path }) => !seen.has(path))) unavailable.push({ reason: 'Linked guide traversal limit reached' });
  const intake = Object.freeze({ repository: repository ?? dir, revision, readme: root ?? null,
    documents: Object.freeze(documents), unavailable: frozen(unavailable) });
  return intake;
}

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const field of Object.values(value)) frozen(field);
    Object.freeze(value);
  }
  return value;
}

function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export function approvalDigest(plan) {
  return sha(canon(plan));
}

export function approvePlan(plan, digest) {
  if (plan?.status !== 'ready' || typeof digest !== 'string' || digest !== approvalDigest(plan)) {
    throw new Error('Approval must match the exact ready plan digest');
  }
  // Take a private, immutable copy so callers cannot change evidence after approval.
  const result = frozen(JSON.parse(JSON.stringify(plan)));
  approved.add(result);
  return result;
}

export function assertApprovedPlan(plan) {
  if (!approved.has(plan)) throw new Error('Execution requires a controller-approved plan');
  return plan;
}

function citation(intake, raw) {
  const doc = intake.documents.find(({ path }) => path === raw?.path);
  const startLine = raw?.startLine;
  const endLine = raw?.endLine ?? startLine;
  if (!doc || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 ||
      endLine < startLine || endLine > linesOf(doc.text).length || endLine - startLine > 30) throw new Error('Invalid documentary citation');
  return { path: doc.path, startLine, endLine, sha256: doc.sha256,
    quote: linesOf(doc.text).slice(startLine - 1, endLine).join('\n') };
}

function checkOf(intake, raw) {
  const cite = citation(intake, raw?.citation);
  const precondition = raw.precondition ?? (raw.contains || raw.kind === 'http' ? 'unmet' : 'absent');
  if (!['absent', 'unmet'].includes(precondition)) throw new Error('Invalid observer precondition');
  const result = { kind: raw.kind, citation: cite, precondition };
  if (raw.kind === 'file') {
    if (!plainPath(raw.path) || !cite.quote.includes(raw.path)) throw new Error('The file check must use a cited repository-relative path');
    result.path = raw.path;
  } else if (raw.kind === 'http') {
    const url = new URL(raw.url);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.username || url.password || url.hash || !cite.quote.includes(raw.url)) throw new Error('The HTTP check must use a cited loopback URL');
    if (raw.status != null && (raw.status !== 200 && !cite.quote.includes(String(raw.status)) ||
        !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599)) throw new Error('Invalid HTTP status check');
    result.url = raw.url;
    result.status = raw.status ?? 200;
  } else throw new Error('Only a file or loopback HTTP check is supported');
  if (raw.contains != null) {
    if (typeof raw.contains !== 'string' || !raw.contains || raw.contains.length > 1024 || /[\r\n\0]/.test(raw.contains) || !cite.quote.includes(raw.contains))
      throw new Error('Expected content must appear in the cited guide');
    result.contains = raw.contains;
  }
  return result;
}

function citationContainsCommand(quote, command) {
  const lines = quote.split('\n').map((line) => line.trim().replace(/^\$ /, ''));
  if (command.includes('\n')) {
    const parts = command.split('\n');
    return lines.some((_, i) => parts.every((part, j) => part.trim() === lines[i + j]));
  }
  return lines.includes(command) || [...quote.matchAll(/`([^`\n]+)`/g)].some(([, inline]) => inline === command);
}

function citedRuntime({ runtime, version }, cite) {
  const names = { node: /\bnode(?:\.js|js)?\b/i, python: /\bpython[23]?\b/i };
  const runtimePattern = Object.hasOwn(names, runtime) ? names[runtime] :
    new RegExp('(^|[^a-z0-9])' + runtime.replace(/[.]/g, '\\.') + '(?=[^a-z0-9]|$)', 'i');
  const versions = version.match(/\d+(?:\.\d+){0,2}/g) ?? [];
  if (!runtimePattern.test(cite.quote) || versions.some((v) =>
    !new RegExp('(?:^|[^0-9])' + v.replace(/[.]/g, '\\.') + '(?![0-9])').test(cite.quote))) {
    throw new Error('Runtime and version must be grounded in the cited prerequisites');
  }
  return { runtime, version, citation: cite };
}

export function resolvePlan(intake, proposal, catalog = []) {
  const plan = {
    status: 'ambiguous', repository: intake.repository, revision: intake.revision,
    documentation: intake.documents.map(({ path, sha256, external }) => ({ path, sha256, external })),
    steps: [], requirements: [], environment: null, access: { egress: [] }, check: null,
  };
  const stop = (status, reason, cite) => frozen({ ...plan, status, reason, ...(cite ? { citation: cite } : {}) });
  if (!intake.readme) return stop('missing', 'No README at the resolved revision');
  if (!intake.documents.some(({ path }) => path === intake.readme))
    return stop('unsupported', 'README is not readable under the intake policy');
  try {
    if (!proposal || !['ready', 'missing', 'ambiguous', 'unsupported'].includes(proposal.status))
      throw new Error('Agent did not return a recognized proposal');
    const steps = proposal.steps ?? [];
    if (!Array.isArray(steps) || steps.length > 10) throw new Error('Documented step count exceeds the attempt limit');
    plan.steps = steps.map((step, i) => {
      const cite = citation(intake, step.citation);
      const command = step.command;
      if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\x00-\x08\x0b-\x1f\x7f]/.test(command) ||
          !citationContainsCommand(cite.quote, command))
        throw new Error('Each command must appear verbatim in its cited instructions');
      if (!['service', 'foreground', undefined].includes(step.mode)) throw new Error('Invalid step mode');
      return { id: 'step-' + (i + 1), mode: step.mode ?? 'foreground', command, citation: cite };
    });
    const requirements = proposal.requirements ?? [];
    if (!Array.isArray(requirements) || requirements.length > 8) throw new Error('Invalid runtime requirements');
    plan.requirements = requirements.map((req) => {
      if (typeof req.runtime !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,29}$/.test(req.runtime) ||
          typeof req.version !== 'string' || req.version.length > 80) throw new Error('Invalid runtime requirement');
      return citedRuntime(req, citation(intake, req.citation));
    });
    if (proposal.status !== 'ready') {
      const cite = citation(intake, proposal.citation);
      if (typeof proposal.reason !== 'string' || !proposal.reason.trim()) throw new Error('A non-ready result needs an explanation');
      return stop(proposal.status, proposal.reason.slice(0, 1000), cite);
    }
    if (!plan.steps.length) throw new Error('No documented action to run');
    plan.check = checkOf(intake, proposal.check);
    const egress = proposal.access?.egress ?? [];
    if (!Array.isArray(egress) || egress.length > 8 || egress.some((h) => typeof h !== 'string' ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)))
      return stop('unsupported', 'Requested access is not a bounded set of public registry hostnames');
    plan.access = { egress: [...new Set(egress)].sort() };
    if (plan.access.egress.length) {
      const download = documentedDownload(plan.steps, plan.access.egress);
      if (!download) return stop('unsupported',
        'This network install has no supported way to capture its downloaded artifact identities.', plan.steps[0].citation);
      plan.access.download = download;
    }
    if (proposal.access?.credentials || proposal.access?.inbound)
      return stop('unsupported', 'Credentials and inbound access are outside this runner');
    const candidates = catalog.filter((image) => ['vercel', 'docker-fixture'].includes(image?.provider) &&
      typeof image.image === 'string' && /^[^@\s]+@sha256:[a-f0-9]{64}$/.test(image.image) &&
      plan.requirements.every(({ runtime, version }) => {
        const actual = image.runtimes?.[runtime] ?? (image.runtime === runtime ? image.version : undefined);
        return Boolean(semver.valid(actual) && semver.validRange(version) && semver.satisfies(actual, version));
      }));
    if (candidates.length === 0) return stop('unsupported', 'No immutable catalog image satisfies the documented requirements', plan.requirements[0]?.citation);
    if (!plan.requirements.length && candidates.length !== 1)
      return stop('ambiguous', 'No documented runtime preference selects one of the available images', plan.steps[0].citation);
    plan.environment = JSON.parse(JSON.stringify(candidates[0]));
    return frozen({ ...plan, status: 'ready' });
  } catch (error) {
    return stop('ambiguous', 'Plan not actionable: ' + error.message);
  }
}
