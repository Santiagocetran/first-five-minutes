import { defineDynamic, defineTool } from 'eve/tools';
import { z } from 'zod';
import { broker } from '../lib/broker';

const request_environment = defineTool({
  description: 'Request the single assigned environment for this approved attempt.',
  inputSchema: z.strictObject({}),
  execute: (_input, ctx) => broker(ctx.session.id, 'request_environment', {}, ctx.abortSignal),
});

const run_step = defineTool({
  description: 'Run the next approved documentary step by ID. Stop if the controller reports a failure.',
  inputSchema: z.strictObject({ id: z.string().regex(/^step-[1-9][0-9]*$/) }),
  execute: ({ id }, ctx) => broker(ctx.session.id, 'run_step', { id }, ctx.abortSignal),
});

const read_source = defineTool({
  description: 'Read a bounded source excerpt by path during diagnosis. Tools do not edit files.',
  inputSchema: z.strictObject({ path: z.string().min(1).max(512) }),
  execute: ({ path }, ctx) => broker(ctx.session.id, 'read_source', { path }, ctx.abortSignal),
});

export default defineDynamic(async (ctx) => {
  const { mode } = await ctx.memo(ctx.session.id, () => broker(ctx.session.id, 'mode'));
  if (mode === 'run') return { request_environment, run_step };
  if (mode === 'diagnose') return { read_source };
  return null;
});
