import { broker } from './lib/broker';
import { defineAgent } from 'eve';
import { openai } from 'eve/models/openai';
import { gateway, wrapLanguageModel } from 'ai';

const id = process.env.FFM_EVE_MODEL;
if (!id) throw new Error('Start eve through the First Five Minutes controller');
const outputLimit = Number(process.env.FFM_EVE_OUTPUT_TOKENS);
const direct = process.env.FFM_EVE_MODEL_CONNECTION === 'openai';
const provider = direct ? openai(id) : gateway(id);

const toolSets = [
  'eve__reply',
  'request_environment,run_step',
  'eve__reply,read_source',
];

export default defineAgent({
  model: wrapLanguageModel({
    model: provider,
    modelId: direct ? id.slice('openai/'.length) : id,
    providerId: direct ? 'openai.responses' : 'gateway',
    middleware: {
      transformParams: async ({ params }) => {
        const tools = (params.tools ?? []).map((tool) => {
          if (tool.type !== 'function') throw new Error('Unexpected provider tool');
          return tool.name;
        }).sort().join(',');
        if (!toolSets.includes(tools)) throw new Error('Unexpected effective eve tools: ' + tools);
        await broker('', 'model_round');
        return { ...params, maxOutputTokens: Math.min(params.maxOutputTokens ?? 4096, outputLimit, 4096) };
      },
    },
  }),
  defaultTools: false,
  modelContextWindowTokens: 120000,
  limits: {
    sessionTimeoutMs: 60000,
    sessionUsage: ({ total }) =>
      total.inputTokens >= Number(process.env.FFM_EVE_INPUT_TOKENS) ||
      total.outputTokens >= outputLimit ||
      (total.costUsd ?? 0) >= Number(process.env.FFM_EVE_COST_USD),
  },
});
