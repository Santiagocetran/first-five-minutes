import { performance } from 'node:perf_hooks';
import { assertApprovedPlan } from './intake.mjs';
import { SandboxAdapterError } from './sandbox.mjs';
import { redactEvidence } from './receipt.mjs';

const platform = reason => ({ kind: 'platform', reason });

export function bound(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function redactOutput(value, secrets = [], maxBytes = 4096) {
  const text = redactEvidence(String(value ?? ''), secrets);
  const bytes = Buffer.from(text);
  if (bytes.length > maxBytes) return bytes.subarray(0, maxBytes).toString().replace(/\uFFFD$/, '') + '\n[excerpt truncated]';
  return text;
}

function deadline(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Deadline exceeded.')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer), cancel: () => {
    clearTimeout(timer);
    controller.abort(new Error('Execution tools closed.'));
  } };
}

const boundedLimit = (value, fallback, max) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError('Invalid execution limit.');
  return value;
};

export const sequentialDrive = async ({ requestEnvironment, runNext }) => {
  if (!(await requestEnvironment()).ready) return;
  for (;;) {
    const result = await runNext();
    if (!result.more) return;
  }
};

/** Only the controller can translate the approved sequence to sandbox operations. */
export async function executeAttempt({
  plan, createSandbox, sourceFiles, drive = sequentialDrive, limits = {}, redactValues = [],
}) {
  assertApprovedPlan(plan);
  const attemptMs = boundedLimit(limits.attemptMs, 120_000, 120_000);
  const stepMs = boundedLimit(limits.stepMs, 25_000, 25_000);
  const cleanupMs = boundedLimit(limits.cleanupMs, 10_000, 10_000);
  const outputBytes = boundedLimit(limits.outputBytes, 4096, 4096);
  const attemptDeadline = deadline(attemptMs);
  const { signal } = attemptDeadline;
  const result = {
    repository: plan.repository, revision: plan.revision, requirements: plan.requirements, environment: plan.environment, check: plan.check,
    documentation: plan.documentation, access: plan.access, approval: 'approved',
    outcome: 'unchecked', teardown: 'not created', steps: plan.steps.map(s => ({ ...s, state: 'unrun' })),
    timings: { setupMs: 0, infrastructureMs: 0 },
  };
  let sandbox, active = true, ready = false, busy = false, requested = false, index = 0;
  const clean = value => redactOutput(value, redactValues, outputBytes);
  const stop = reason => { result.stop ??= platform(reason); };
  const inFlightFailure = () => signal.aborted ? 'The approved attempt timed out.' : 'The sandbox operation failed.';
  const requestEnvironment = async (...args) => {
    if (args.length || !active || requested || result.stop) return { ready: false };
    requested = true;
    busy = true;
    const started = performance.now();
    try {
      signal.throwIfAborted();
      // Synchronous adapter construction puts the handle within reach before provisioning.
      sandbox = createSandbox({ environment: plan.environment, access: plan.access, revision: plan.revision,
        requirements: plan.requirements, documentation: plan.documentation, sourceFiles });
      if (!sandbox || typeof sandbox.start !== 'function') throw new TypeError('Sandbox factory must return a lifecycle handle.');
      result.teardown = 'unconfirmed';
      const details = await bound(sandbox.start({ signal }), signal);
      if (!active) return { ready: false };
      if (details?.image !== plan.environment.image) {
        stop('The sandbox did not confirm the approved immutable base image.');
        return { ready: false };
      }
      result.environment = { ...plan.environment, actualImage: details.image };
      if (details.actualRegion) result.environment.actualRegion = details.actualRegion;
      if (details.actualRuntimes) result.environment.actualRuntimes = details.actualRuntimes;
      if (details.sandboxId) result.freshness = { sandboxId: details.sandboxId, clean: true, priorState: false };
      if (details?.sourceIdentity) result.artifacts = { source: details.sourceIdentity };
      if (details?.dependencies) result.dependencies = details.dependencies;
      if (['absent', 'unmet'].includes(plan.check.precondition) || plan.check.absentBefore === true) {
        const before = await bound(sandbox.observe(plan.check, { signal, precondition: true }), signal);
        if (!active) return { ready: false };
        if (before.state !== 'absent') {
          stop(before.state === 'met' ? 'The outcome already existed before the attempt.' : 'The outcome precondition could not be verified.');
          return { ready: false };
        }
        result.precondition = plan.check.precondition ?? 'absent';
      }
      ready = true;
      return { ready: true };
    } catch (error) {
      if (active && !signal.aborted && error instanceof SandboxAdapterError) {
        result.stop = { kind: error.kind, reason: error.message };
      } else if (active) stop(inFlightFailure());
      return { ready: false };
    } finally {
      busy = false;
      if (active) result.timings.infrastructureMs += Math.round(performance.now() - started);
    }
  };
  const runNext = async (...args) => {
    if (args.length || !active || !ready || busy || result.stop || index >= result.steps.length ||
        (index > 0 && result.steps[index - 1].exitCode !== 0)) return { more: false, refused: true };
    busy = true;
    const approved = plan.steps[index];
    const step = result.steps[index++];
    const started = performance.now();
    const stepDeadline = deadline(stepMs);
    const stepSignal = AbortSignal.any([signal, stepDeadline.signal]);
    step.state = 'started';
    step.actualCommand = approved.command;
    try {
      stepSignal.throwIfAborted();
      const response = await bound(sandbox.run(approved.command, { signal: stepSignal, mode: approved.mode }), stepSignal);
      if (!active) return { more: false };
      if (!Number.isInteger(response?.exitCode)) throw new Error('Unconfirmed exit code.');
      step.state = 'completed';
      step.exitCode = response.exitCode;
      step.output = clean(response.output);
      if (response.networkFailure) stop('The artifact transfer failed at the network layer. See the recorded command output.');
      if (response.artifact) result.artifacts = { ...result.artifacts, downloaded: response.artifact };
      if (response.dependencies) result.dependencies = response.dependencies;
      if (response.startedService) step.service = 'started';
      return { exitCode: step.exitCode, output: step.output, more: step.exitCode === 0 && index < result.steps.length };
    } catch (error) {
      if (active) {
        if (error instanceof SandboxAdapterError) result.stop ??= { kind: error.kind, reason: error.message };
        step.state = stepSignal.aborted ? 'timed out' : 'interrupted';
        stop(stepSignal.aborted ? 'A step exceeded the approved runtime limit.' : 'A documented step has no confirmed sandbox result.');
      }
      return { more: false };
    } finally {
      stepDeadline.clear();
      busy = false;
      if (active) {
        step.durationMs = Math.round(performance.now() - started);
        result.timings.setupMs += step.durationMs;
      }
    }
  };
  try {
    try {
      await bound(Promise.resolve().then(() => drive(Object.freeze({ requestEnvironment, runNext }), { signal })), signal);
    } catch {
      if (!result.steps.some(step => Number.isInteger(step.exitCode) && step.exitCode !== 0)) {
        stop(signal.aborted ? 'The approved attempt timed out.' : 'The attempt driver did not complete.');
      }
    }
    if (busy) stop('The driver ended with an unfinished tool call.');
    active = false;
    if (!result.stop && !result.steps.some(s => Number.isInteger(s.exitCode) && s.exitCode !== 0)) {
      if (!ready || result.steps.some(s => s.state !== 'completed')) stop('The driver did not run the full approved sequence.');
      else if (plan.access.egress?.length && (!result.dependencies || !result.artifacts?.downloaded?.sha256)) {
        stop('Downloaded artifact identities could not be established.');
      } else {
        const started = performance.now();
        try {
          const observation = await bound(sandbox.observe(plan.check, { signal }), signal);
          result.outcome = ['met', 'absent'].includes(observation?.state) ? observation.state : 'error';
          if (observation?.evidence) result.observerEvidence = clean(observation.evidence);
        } catch {
          result.outcome = 'error';
        } finally {
          result.timings.infrastructureMs += Math.round(performance.now() - started);
        }
      }
    }
  } finally {
    active = false;
    attemptDeadline.cancel();
    if (sandbox) {
      const cleanupDeadline = deadline(cleanupMs);
      const cleanupSignal = cleanupDeadline.signal;
      const started = performance.now();
      try {
        const state = await bound(sandbox.stop({ signal: cleanupSignal }), cleanupSignal);
        if (state !== 'confirmed' && state !== 'not created') throw new Error('Teardown not confirmed.');
        result.teardown = state;
      } catch {
        stop('Sandbox teardown could not be confirmed.');
      } finally {
        cleanupDeadline.clear();
        result.timings.infrastructureMs += Math.round(performance.now() - started);
      }
    }
  }
  return result;
}
