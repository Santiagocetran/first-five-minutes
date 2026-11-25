const imageIdentity = /^(?:[a-z0-9._:-]+\/)*[a-z0-9._-]+@sha256:[a-f0-9]{64}$/;
const runtimeVersion = /^\d+\.\d+\.\d+$/;

export function liveConfig(input, action) {
  if (!input || typeof input.model !== 'string' || !input.model.includes('/'))
    throw new Error('Configure an explicit provider/model ID.');
  if (!['gateway', 'openai'].includes(input.modelConnection ?? 'gateway'))
    throw new Error('modelConnection must be gateway or openai.');
  const config = {
    model: input.model, modelConnection: input.modelConnection ?? 'gateway',
    catalog: input.catalog ?? [], externalHosts: input.externalHosts ?? [],
    modelLimits: { modelTimeoutMs: 45000, modelInputTokens: 50000, modelOutputTokens: 5000, modelRounds: 24, modelCostUsd: 0.15 },
    limits: { attemptMs: 120000, stepMs: 25000, cleanupMs: 10000, outputBytes: 4096, lifetimeMs: 120000, logLimit: 131072 },
  };
  if (!Array.isArray(config.catalog) || !Array.isArray(config.externalHosts) ||
      config.externalHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host)))
    throw new Error('Invalid image catalog or documentation host list.');
  config.catalog = config.catalog.map(image => {
    const runtimes = image?.runtimes ?? { [image?.runtime]: image?.version };
    const region = image?.region ?? 'iad1';
    if (image?.provider !== 'vercel' || !imageIdentity.test(image.image) ||
        !/^[a-z]{3}[0-9]{1,2}$/.test(region) ||
        !Object.keys(runtimes).length || Object.entries(runtimes).some(([runtime, version]) =>
          !['node', 'python'].includes(runtime) || typeof version !== 'string' || !runtimeVersion.test(version)))
      throw new Error('Catalog entries need an immutable Vercel image and exact supported runtime versions.');
    return { provider: 'vercel', image: image.image, region, runtimes };
  });
  for (const [group, limits] of Object.entries({
    limits: { attemptMs: 120000, stepMs: 25000, cleanupMs: 10000, outputBytes: 4096, lifetimeMs: 120000, logLimit: 131072 },
    modelLimits: { modelTimeoutMs: 120000, modelInputTokens: 100000, modelOutputTokens: 16000, modelRounds: 32, modelCostUsd: Infinity },
  })) {
    for (const [name, value] of Object.entries(input[group] ?? {})) {
      if (!Object.hasOwn(limits, name) || typeof value !== 'number' || !Number.isFinite(value) ||
          value <= 0 || value > limits[name] || (name !== 'modelCostUsd' && !Number.isInteger(value)))
        throw new Error('Invalid ' + group + ' setting: ' + name);
      config[group][name] = value;
    }
  }
  if (action !== 'diagnose') {
    if (![input.teamId, input.projectId].every(id => typeof id === 'string' && id.trim()))
      throw new Error('Configure the intended sandbox teamId and projectId.');
    config.teamId = input.teamId;
    config.projectId = input.projectId;
  }
  return config;
}
