// What each model can do, read from the core's model list: the thinking levels it takes
// and whether it offers Fast. The session process owns this, since it holds the list; it
// reports these facts with each model, and the supervisor decides with them.
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return [...THINKING_LEVELS].filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

// Fast is a root-owned family preference, not a model alias or a reasoning level.
export function supportsFastMode(model) {
  return ["gpt-6-astra", "gpt-6.1-sol"].includes(model?.id)
    && ((model.provider === "openai-codex" && model.api === "openai-codex-responses")
      || (model.provider === "openai" && model.api === "openai-responses"));
}

/** The request options for Fast, when the supervisor turned it on and the model offers it. */
export function fastModeOptions(model, enabled) {
  return enabled === true && supportsFastMode(model) ? { serviceTier: "priority" } : {};
}

/** A model as the session reports it: the core's description plus what it can do. */
export function withCapabilities(model) {
  return { ...model, thinkingLevels: supportedThinkingLevels(model), fastModeSupported: supportsFastMode(model) };
}

function preferredEntries(preferred) {
  const values = Array.isArray(preferred) ? preferred : preferred == null ? [] : [preferred];
  const entries = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (typeof value.provider !== "string" || typeof value.id !== "string") continue;
    const key = `${value.provider}\0${value.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ provider: value.provider, id: value.id });
  }
  return entries;
}

function preferredIndex(filtered, preferred) {
  const exact = filtered.findIndex((model) => model.provider === preferred.provider && model.id === preferred.id);
  if (exact >= 0) return exact;
  const idMatches = filtered.reduce((count, model) => count + (model.id === preferred.id ? 1 : 0), 0);
  if (idMatches === 1) return filtered.findIndex((model) => model.id === preferred.id);
  return -1;
}

// Models already described with their thinking levels, checked as the search returns them.
function searchable(models) {
  if (!Array.isArray(models) || models.length === 0 || models.length > 512) {
    throw new Error("availableModels must contain 1 through 512 models");
  }
  const seen = new Set();
  return models.map((model, index) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error(`availableModels[${index}] is required`);
    if (typeof model.provider !== "string" || !model.provider || model.provider.length > 128) {
      throw new Error(`availableModels[${index}].provider must be a non-empty bounded string`);
    }
    if (typeof model.id !== "string" || !model.id || model.id.length > 256) {
      throw new Error(`availableModels[${index}].id must be a non-empty bounded string`);
    }
    const key = `${model.provider}\0${model.id}`;
    if (seen.has(key)) throw new Error(`availableModels contains a duplicate: ${model.provider}/${model.id}`);
    seen.add(key);
    const reasoning = model.reasoning === true;
    if (!Array.isArray(model.thinkingLevels) || model.thinkingLevels.length === 0) {
      throw new Error(`availableModels[${index}].thinkingLevels must be a non-empty array`);
    }
    const thinkingLevels = [...new Set(model.thinkingLevels)];
    if (thinkingLevels.length !== model.thinkingLevels.length || thinkingLevels.some((level) => !THINKING_LEVELS.has(level))) {
      throw new Error(`availableModels[${index}].thinkingLevels contains an unsupported or duplicate level`);
    }
    if (!reasoning && (thinkingLevels.length !== 1 || thinkingLevels[0] !== "off")) {
      throw new Error(`availableModels[${index}] without reasoning must support only off`);
    }
    return { provider: model.provider, id: model.id,
      name: typeof model.name === "string" && model.name.length <= 256 ? model.name : model.id, reasoning, thinkingLevels };
  });
}

/** Models matching a search, with the preferred ones first; for Python's model listing. */
export function findModels(models, query = "", limit = 50, preferred = null) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 through 100");
  const needle = String(query ?? "").trim().toLowerCase();
  const filtered = searchable(models)
    .filter((model) => !needle || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle));
  for (const entry of preferredEntries(preferred).reverse()) {
    const index = preferredIndex(filtered, entry);
    if (index > 0) {
      const [preferredModel] = filtered.splice(index, 1);
      filtered.unshift(preferredModel);
    }
  }
  return filtered.slice(0, limit);
}
