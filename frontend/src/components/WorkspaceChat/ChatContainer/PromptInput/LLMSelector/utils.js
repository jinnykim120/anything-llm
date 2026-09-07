import { ALL_LLM_PROVIDERS } from "@/pages/GeneralSettings/LLMPreference";
import { DISABLED_PROVIDERS } from "@/hooks/useGetProvidersModels";
import AnthropicLogo from "@/media/llmprovider/anthropic.png";

// Claude Code is configured through the local CLI rather than an API key, so
// it intentionally does not appear in the general LLM provider settings list.
// It still needs to be selectable for workspaces when it is the active system
// provider.
export const CLAUDE_CLI_PROVIDER = {
  name: "Claude Code",
  value: "claudecli",
  logo: AnthropicLogo,
  description: "Use the Claude Code CLI with the machine's existing account.",
  requiredConfig: [],
};

export function autoScrollToSelectedLLMProvider(
  selectedLLMProvider,
  timeout = 500
) {
  setTimeout(() => {
    const selectedButton = document.querySelector(
      `[data-llm-value="${selectedLLMProvider}"]`
    );
    if (!selectedButton) return;
    selectedButton.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, timeout);
}

/**
 * Validates the model selection by checking if the model is in the select option in the available models
 * dropdown. If the model is not in the dropdown, it will return the first model in the dropdown.
 *
 * This exists when the user swaps providers, but did not select a model in the new provider's dropdown
 * and assumed the first model in the picker was OK. This prevents invalid provider<>model selection issues
 * @param {string} model - The model to validate
 * @returns {string} - The validated model
 */
export function validatedModelSelection(model) {
  try {
    // If the entire select element is not found, return the model as is and cross our fingers
    const selectOption = document.getElementById(`workspace-llm-model-select`);
    if (!selectOption) return model;

    // If the model is not in the dropdown, return the first model in the dropdown
    // to prevent invalid provider<>model selection issues
    const selectedOption = selectOption.querySelector(
      `option[value="${model}"]`
    );
    if (!selectedOption) return selectOption.querySelector(`option`).value;

    // If the model is in the dropdown, return the model as is
    return model;
  } catch {
    return null; // If the dropdown was empty or something else went wrong, return null to abort the save
  }
}

export function hasMissingCredentials(settings, provider) {
  if (!settings) return false;
  const providerEntry = [CLAUDE_CLI_PROVIDER, ...ALL_LLM_PROVIDERS].find(
    (p) => p.value === provider
  );
  if (!providerEntry) return false;

  for (const requiredKey of providerEntry.requiredConfig) {
    if (!settings.hasOwnProperty(requiredKey)) return true;
    if (!settings[requiredKey]) return true;
  }
  return false;
}

export const WORKSPACE_LLM_PROVIDERS = [
  CLAUDE_CLI_PROVIDER,
  ...ALL_LLM_PROVIDERS,
].filter((provider) => !DISABLED_PROVIDERS.includes(provider.value));

/**
 * Return the model configured for a provider in the system settings. A
 * workspace override always takes precedence when one is present.
 */
export function getSystemModelForProvider(settings, provider) {
  if (!settings || !provider) return "";

  const modelSettingByProvider = {
    openai: "OpenAiModelPref",
    azure: "AzureOpenAiModelPref",
    anthropic: "AnthropicModelPref",
    gemini: "GeminiLLMModelPref",
    lmstudio: "LMStudioModelPref",
    localai: "LocalAiModelPref",
    ollama: "OllamaLLMModelPref",
    togetherai: "TogetherAiModelPref",
    fireworksai: "FireworksAiLLMModelPref",
    perplexity: "PerplexityModelPref",
    openrouter: "OpenRouterModelPref",
    mistral: "MistralModelPref",
    groq: "GroqModelPref",
    koboldcpp: "KoboldCPPModelPref",
    textgenwebui: "TextGenWebUIModelPref",
    cohere: "CohereModelPref",
    litellm: "LiteLLMModelPref",
    "generic-openai": "GenericOpenAiModelPref",
    bedrock: "AwsBedrockLLMModel",
    deepseek: "DeepSeekModelPref",
    apipie: "ApipieLLMModelPref",
    novita: "NovitaLLMModelPref",
    xai: "XAIModelPref",
    "nvidia-nim": "NvidiaNimLLMModelPref",
    ppio: "PPIOModelPref",
    moonshotai: "MoonshotAiModelPref",
    cometapi: "CometApiLLMModelPref",
    foundry: "FoundryModelPref",
    zai: "ZAiModelPref",
    giteeai: "GiteeAIModelPref",
    "docker-model-runner": "DockerModelRunnerModelPref",
    privatemode: "PrivateModeModelPref",
    sambanova: "SambaNovaLLMModelPref",
    lemonade: "LemonadeLLMModelPref",
    minimax: "MinimaxModelPref",
    cerebras: "CerebrasModelPref",
    omlx: "OMLXLLMModelPref",
  };

  if (provider === "claudecli") {
    return settings.LLMProvider === provider ? settings.LLMModel || "" : "";
  }

  return modelSettingByProvider[provider]
    ? settings[modelSettingByProvider[provider]] || ""
    : "";
}

/**
 * Convert provider model ids into a compact label suitable for the chat
 * header while keeping the original id for API requests and persistence.
 */
export function formatLLMModelName(model = "") {
  const value = String(model || "").trim();
  if (!value) return "";

  const claudeModel = value.match(
    /^claude-(?:(\d+(?:-\d+)?)-)?(opus|sonnet|haiku)(?:-(.*))?$/i
  );
  if (claudeModel) {
    const [, version, family, suffix] = claudeModel;
    const readableVersion = version?.replace(/-/g, ".");
    const readableSuffix =
      suffix && !/^latest$/i.test(suffix)
        ? ` ${suffix.replace(/-/g, ".")}`
        : "";
    return `${family[0].toUpperCase()}${family.slice(1).toLowerCase()}${
      readableVersion ? ` ${readableVersion}` : ""
    }${readableSuffix}`;
  }

  return value;
}

/**
 * Only expose providers that have usable system configuration. The current
 * workspace/system provider is retained even when incomplete so the UI can
 * explain what needs to be configured instead of silently losing the saved
 * selection.
 */
export function getConfiguredWorkspaceLLMProviders(
  settings,
  providerOverrides = []
) {
  const activeProviders = new Set(
    [settings?.LLMProvider, ...providerOverrides].filter(Boolean)
  );

  return WORKSPACE_LLM_PROVIDERS.filter((provider) => {
    const hasConfiguration = provider.requiredConfig.length
      ? !hasMissingCredentials(settings, provider.value)
      : activeProviders.has(provider.value);
    return hasConfiguration || activeProviders.has(provider.value);
  });
}
