import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { assertApprovedPlan } from './intake.mjs';

const require = createRequire(import.meta.url);
const agentRoot = fileURLToPath(new URL('../agent/', import.meta.url));
const MODEL = /^[a-z0-9][a-z0-9.-]{0,30}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/;
const MAX_PROMPT = 160 * 1024;
const boundedString = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const integer = { type: 'integer', minimum: 1 };
const obj = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const enumOf = (...values) => ({ type: 'string', enum: values });
const citation = obj({ path: boundedString(1024), startLine: integer, endLine: integer });
const replySchema = obj({
  status: enumOf('ready', 'missing', 'ambiguous', 'unsupported'),
  reason: boundedString(1000),
  citation,
  requirements: array(obj({ runtime: boundedString(30), version: boundedString(80), citation }), 8),
  steps: array(obj({ command: boundedString(4096), mode: enumOf('foreground', 'service'), citation }), 10),
  access: obj({ egress: array(boundedString(253), 8), credentials: { type: 'boolean' }, inbound: { type: 'boolean' } }),
  check: obj({ kind: enumOf('file', 'http'), precondition: enumOf('absent', 'unmet'), path: boundedString(511), url: boundedString(2048),
    status: { type: 'integer' }, contains: boundedString(1024), citation }, ['kind', 'citation']),
}, ['status', 'requirements', 'steps', 'access']);
const diagnosisSchema = obj({
  cause: boundedString(2000), confidence: enumOf('low', 'medium', 'high'),
  edits: array(obj({ path: boundedString(511), before: boundedString(16000),
    after: { type: 'string', maxLength: 16000 } }), 3),
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function secretsMatch(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleControllerRequest(session, op, input) {
  if (!session || session.signal?.aborted) return null;
  if (op === 'mode') return { mode: session.mode };
  if (session.mode === 'run' && op === 'request_environment' && !session.requested && !session.stopped) {
    session.requested = true;
    const result = await session.requestEnvironment();
    session.ready = result?.ready === true;
    if (!session.ready) session.stopped = true;
    return { ready: session.ready };
  }
  if (session.mode === 'run' && op === 'run_step' && session.ready && !session.stopped && !session.busy) {
    const expected = session.steps[session.index];
    if (!expected || input?.id !== expected.id || Object.keys(input).length !== 1) {
      session.stopped = true;
      return { more: false, refused: true };
    }
    session.busy = true;
    session.index++;
    try {
      const result = await session.runStep();
      session.stopped = !result?.more || result.exitCode !== 0;
      return result;
    } finally {
      session.busy = false;
    }
  }
  if (session.mode === 'diagnose' && op === 'read_source' && session.paths.has(input?.path) &&
      Object.keys(input).length === 1 && session.reads < 8 && session.bytes < 32000) {
    session.reads++;
    const bytes = Buffer.from(await session.readSource(input.path));
    const n = Math.min(bytes.length, 8000, 32000 - session.bytes);
    session.bytes += n;
    return { path: input.path, text: bytes.subarray(0, n).toString('utf8'), truncated: n < bytes.length };
  }
  return null;
}

function controllerServer(secret, sessions, maxRounds) {
  let rounds = 0;
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.method !== 'POST' || req.url !== '/' ||
        !secretsMatch(req.headers.authorization, 'Bearer ' + secret)) {
        res.writeHead(403).end('{}'); return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) { res.writeHead(413).end('{}'); return; }
      }
      const { sessionId, op, input } = JSON.parse(body);
      if (op === 'model_round' && sessionId === '') {
        if (++rounds > maxRounds) { res.writeHead(429).end('{}'); return; }
        res.end('{}'); return;
      }
      const response = await handleControllerRequest(sessions.get(sessionId), op, input);
      if (!response) { res.writeHead(403).end('{}'); return; }
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(500).end('{}');
    }
  });
}

function inspectLayout(info, model, modelConnection) {
  if (info.agent.model.id !== (modelConnection === 'openai' ? model : 'gateway/' + model) || info.sandbox.provider !== 'ffm-disabled' ||
      info.connections.length || info.hooks.length || info.schedules.length || info.memories.length ||
      info.subagents.total || info.remoteAgents.total || info.skills.static.length || info.skills.dynamic.length ||
      info.kernelEffects.length || info.diagnostics.discoveryErrors ||
      info.tools.static.length || info.tools.dynamic.length !== 1 ||
      info.tools.dynamic[0].slug !== 'controller') throw new Error('eve reported a different agent or unexpected capabilities (' + JSON.stringify({ model: info.agent.model.id, sandbox: info.sandbox.provider, tools: info.tools.static.map(t => t.name), dynamic: info.tools.dynamic.map(t => t.slug), effects: info.kernelEffects.length, errors: info.diagnostics.discoveryErrors }) + ')');
}

export async function startLocalEveRuntime({ model, modelConnection, modelInputTokens, modelOutputTokens, modelCostUsd, modelRounds }, sourceDir = agentRoot) {
  const { Client } = await import('eve/client');
  const root = await mkdtemp(join(tmpdir(), 'ffm-eve-'));
  const secret = randomBytes(32).toString('hex');
  const sessions = new Map();
  const server = controllerServer(secret, sessions, modelRounds);
  let child, exited, closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    sessions.clear();
    if (child?.pid) {
      const kill = (signal) => {
        try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      kill('SIGTERM');
      await Promise.race([exited, wait(3000, undefined, { ref: false })]);
      kill('SIGKILL');
    }
    await closeServer(server);
    await rm(root, { force: true, recursive: true, maxRetries: 2 });
  }
  try {
    const evePackage = dirname(require.resolve('eve/package.json'));
    const scratchModules = join(root, 'node_modules');
    await Promise.all([
      cp(sourceDir, join(root, 'agent'), { recursive: true }),
      symlink(dirname(evePackage), scratchModules, 'dir'),
      writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ffm-agent', type: 'module',
        dependencies: { ai: '7.0.172', eve: '1.5.0', zod: '4.6.7' } })),
    ]);
    const brokerPort = await listen(server);
    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    const env = {
      PATH: process.env.PATH, HOME: root, TERM: 'dumb',
      EVE_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
      ...(modelConnection === 'openai'
        ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
        : { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY }),
      FFM_EVE_MODEL_CONNECTION: modelConnection,
      FFM_EVE_MODEL: model, FFM_EVE_SECRET: secret, FFM_EVE_BROKER: 'http://127.0.0.1:' + brokerPort,
      FFM_EVE_INPUT_TOKENS: String(modelInputTokens), FFM_EVE_OUTPUT_TOKENS: String(modelOutputTokens),
      FFM_EVE_COST_USD: String(modelCostUsd),
    };
    child = spawn(process.execPath, [join(evePackage, 'bin/eve.js'), 'dev', '--no-ui', '--no-default-extensions',
      '--host', '127.0.0.1', '--port', String(port)], {
      cwd: root, env, detached: true, stdio: 'ignore',
    });
    let exitStatus = null;
    exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => { exitStatus = String(code ?? signal); resolve(); });
      child.once('error', () => { exitStatus = 'spawn error'; resolve(); });
    });
    const client = new Client({ baseUrl: 'http://127.0.0.1:' + port, auth: { bearer: secret } });
    const startup = AbortSignal.timeout(30000);
    while (!startup.aborted && !exitStatus) {
      try {
        await client.health({ signal: AbortSignal.timeout(1000) });
        break;
      } catch { await wait(150); }
    }
    if (exitStatus || startup.aborted) throw new Error('eve did not start locally' + (exitStatus ? ' (' + exitStatus + ')' : ''));
    const info = await client.info({ signal: AbortSignal.timeout(3000) });
    inspectLayout(info, model, modelConnection);
    return {
      info, close,
      async turn({ message, outputSchema, state, signal }) {
        const { session } = await client.sessions.create({ signal });
        sessions.set(session.id, { ...state, signal });
        try {
          const delivery = await session.send(message, { outputSchema, signal });
          const result = await delivery.result({ signal });
          if (result.status !== 'completed') throw new Error('eve did not complete the model turn (' + result.status + ', ' + (result.error?.code ?? 'no error code') + ')', { cause: sourceDir !== agentRoot ? result.error : undefined });
          return { ...result, sessionId: session.id };
        } finally {
          sessions.delete(session.id);
          if (signal.aborted) await session.cancel({ signal: AbortSignal.timeout(1000) }).catch(() => {});
          await session.end({ signal: AbortSignal.timeout(1000) }).catch(() => {});
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const docsData = (documents) => documents.map(({ path, text, sha256 }) => ({
  path, sha256, lines: text.split(/\r?\n/).map((line, i) => [i + 1, line]),
}));

export function createEveAgent({
  model, modelConnection = 'gateway', modelTimeoutMs = 45000, modelInputTokens = 50000,
  modelOutputTokens = 5000, modelCostUsd = 0.15, modelRounds = 24, startRuntime = startLocalEveRuntime,
} = {}) {
  if (!MODEL.test(model ?? '')) throw new Error('A pinned eve model in provider/model format is required');
  if (!['gateway', 'openai'].includes(modelConnection) || (modelConnection === 'openai' && !model.startsWith('openai/')))
    throw new Error('Use the gateway connection or a direct openai/ model');
  if (!Number.isInteger(modelRounds) || modelRounds < 1 || modelRounds > 32) throw new Error('Invalid model round limit');
  if (!Number.isInteger(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > 120000 ||
      !Number.isInteger(modelInputTokens) || modelInputTokens < 1 || modelInputTokens > 100000 ||
      !Number.isInteger(modelOutputTokens) || modelOutputTokens < 1 || modelOutputTokens > 16000 ||
      !Number.isFinite(modelCostUsd) || modelCostUsd <= 0) throw new Error('Invalid eve model limits');
  let runtime, closed = false;
  function open() {
    if (closed) throw new Error('The eve controller is closed');
    return runtime ??= startRuntime({ model, modelConnection, modelInputTokens, modelOutputTokens, modelCostUsd, modelRounds });
  }
  async function turn(message, state, outputSchema, outerSignal) {
    if (Buffer.byteLength(message) > MAX_PROMPT) throw new RangeError('Documentation/evidence exceeds the eve input bound');
    const timeout = AbortSignal.timeout(modelTimeoutMs);
    const signal = outerSignal ? AbortSignal.any([timeout, outerSignal]) : timeout;
    const client = await open();
    signal.throwIfAborted();
    return client.turn({ message, outputSchema, state, signal });
  }
  return {
    async inspect() { return (await open()).info; },
    async propose(intake) {
      if (!intake.readme || !intake.documents.some(({ path }) => path === intake.readme)) return null;
      const result = await turn(
        'Mode: propose. Return one structured proposal. Data follows. Start at the README. ' +
        'Use status "missing" for a specific necessary instruction omitted, "ambiguous" for material choice or unclear outcome, ' +
        'and "unsupported" for explicitly required capabilities that a constrained Linux VM cannot supply. Cite the limiting passage. ' +
        'For ready, choose an observable file path or explicit loopback HTTP URL, with documented expected content when applicable. ' +
        'Use precondition "absent" for creation, "unmet" for a change of existing content or status. Treat a persistent documented server as mode "service". Cite command lines, the result, and each starting runtime. ' +
        'Express runtime version constraints as semver ranges, "*" if the cited runtime is named without a version. ' +
        'Give only hostnames needed for documented installs and flag credentials or inbound access. No tools are available in this phase.\n' +
        JSON.stringify({ readme: intake.readme, unavailable: intake.unavailable, documents: docsData(intake.documents) }),
        { mode: 'propose' }, replySchema,
      );
      if (!result.data) throw new Error('eve produced no structured plan');
      return result.data;
    },
    async run({ requestEnvironment, runStep, plan, signal }) {
      assertApprovedPlan(plan);
      const result = await turn(
        'Mode: approved newcomer attempt. First call request_environment, then run_step in order by the exact IDs shown. ' +
        'Stop when a tool reports not ready, exitCode nonzero, refused, or more false. ' +
        'The controller owns the outcome check. Do not guess or run any other command.\n' +
        JSON.stringify({ steps: plan.steps, requirements: plan.requirements }),
        { mode: 'run', requestEnvironment, runStep, steps: plan.steps, index: 0 }, undefined, signal,
      );
      return { sessionId: result.sessionId };
    },
    async diagnose({ attempt, documents, paths, readSource }) {
      const result = await turn(
        'Mode: diagnose. Based on the original blocker, use read_source only as needed for a diagnosis. ' +
        'Report a cause and confidence, and suggest only exact text replacements in the original repo guides. ' +
        'Return an empty edits list when no docs-only change is supported. Do not claim the edit is verified.\n' +
        JSON.stringify({ attempt, documents: docsData(documents), paths }),
        { mode: 'diagnose', paths: new Set(paths), readSource, reads: 0, bytes: 0 }, diagnosisSchema,
      );
      if (!result.data) throw new Error('eve produced no structured diagnosis');
      return result.data;
    },
    async close() {
      if (!closed) {
        closed = true;
        if (runtime) await (await runtime.catch(() => null))?.close();
      }
    },
  };
}
