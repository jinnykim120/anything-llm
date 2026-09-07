import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import PreLoader from "@/components/Preloader";
import ChatModelSelection from "./ChatModelSelection";
import RouterPickerSelection from "./RouterPickerSelection";
import { useTranslation } from "react-i18next";
import { PROVIDER_SETUP_EVENT, SAVE_LLM_SELECTOR_EVENT } from "./action";
import {
  WORKSPACE_LLM_PROVIDERS,
  autoScrollToSelectedLLMProvider,
  getConfiguredWorkspaceLLMProviders,
  getSystemModelForProvider,
  hasMissingCredentials,
  validatedModelSelection,
} from "./utils";
import LLMSelectorSidePanel from "./LLMSelector";
import { NoSetupWarning } from "./SetupProvider";
import showToast from "@/utils/toast";
import Workspace from "@/models/workspace";
import System from "@/models/system";

export default function LLMSelectorModal({
  workspaceSlug = null,
  initialProvider = null,
}) {
  const { slug: urlSlug } = useParams();
  const slug = urlSlug ?? workspaceSlug;
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState(null);
  const [selectedLLMProvider, setSelectedLLMProvider] = useState(null);
  const [selectedLLMModel, setSelectedLLMModel] = useState("");
  const [selectedRouterId, setSelectedRouterId] = useState(null);
  const [configuredProviders, setConfiguredProviders] = useState([]);
  const [availableProviders, setAvailableProviders] = useState([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [missingCredentials, setMissingCredentials] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    Promise.all([Workspace.bySlug(slug), System.keys()])
      .then(([workspace, systemSettings]) => {
        const savedProvider =
          workspace?.chatProvider ?? systemSettings?.LLMProvider;
        const configured = getConfiguredWorkspaceLLMProviders(
          systemSettings,
          [workspace?.chatProvider, initialProvider].filter(Boolean)
        );
        const providerToSelect = initialProvider ?? savedProvider;
        const modelToSelect =
          workspace?.chatProvider === providerToSelect && workspace?.chatModel
            ? workspace.chatModel
            : getSystemModelForProvider(systemSettings, providerToSelect);

        setConfiguredProviders(configured);
        setAvailableProviders(configured);
        setSettings(systemSettings);
        setSelectedLLMProvider(providerToSelect);
        autoScrollToSelectedLLMProvider(providerToSelect);
        setSelectedLLMModel(modelToSelect);
        setSelectedRouterId(
          workspace?.router_id || systemSettings?.ModelRouterId || null
        );
        setMissingCredentials(
          hasMissingCredentials(systemSettings, providerToSelect)
        );
        if (initialProvider && initialProvider !== savedProvider)
          setHasChanges(true);
      })
      .finally(() => setLoading(false));
  }, [slug, initialProvider]);

  function handleSearch(e) {
    const searchTerm = e.target.value.toLowerCase();
    const filteredProviders = configuredProviders.filter((provider) =>
      provider.name.toLowerCase().includes(searchTerm)
    );
    setAvailableProviders(filteredProviders);
  }

  function handleProviderSelection(provider) {
    setSelectedLLMProvider(provider);
    setAvailableProviders(configuredProviders);
    autoScrollToSelectedLLMProvider(provider, 50);
    const searchInput = document.getElementById("llm-search-input");
    if (searchInput) searchInput.value = "";
    setHasChanges(true);
    setMissingCredentials(hasMissingCredentials(settings, provider));
    setSelectedLLMModel(getSystemModelForProvider(settings, provider));
  }

  async function handleSave() {
    setSaving(true);
    try {
      setHasChanges(false);

      const isRouter = selectedLLMProvider === "anythingllm-router";
      if (isRouter && !selectedRouterId)
        throw new Error(t("model-router.chat.select-router-error"));

      const updateData = isRouter
        ? { chatProvider: selectedLLMProvider, router_id: selectedRouterId }
        : {
            chatProvider: selectedLLMProvider,
            chatModel: validatedModelSelection(selectedLLMModel),
          };

      if (!isRouter && !updateData.chatModel)
        throw new Error(t("model-router.chat.invalid-model"));

      const { message } = await Workspace.update(slug, updateData);

      if (!!message) throw new Error(message);
      window.dispatchEvent(new Event(SAVE_LLM_SELECTOR_EVENT));
    } catch (error) {
      console.error(error);
      showToast(error.message, "error", { clear: true });
    } finally {
      setSaving(false);
    }
  }

  const providerName =
    WORKSPACE_LLM_PROVIDERS.find((p) => p.value === selectedLLMProvider)
      ?.name || selectedLLMProvider;

  if (loading) {
    return (
      <div
        id="llm-selector-modal"
        className="w-full h-[388px] flex flex-col items-center justify-center gap-2"
      >
        <PreLoader size={12} />
        <p className="text-zinc-400 light:text-slate-500 text-sm">
          {t("chat_window.workspace_llm_manager.loading_workspace_settings")}
        </p>
      </div>
    );
  }

  return (
    <div id="llm-selector-modal" className="w-full h-[388px] flex">
      <LLMSelectorSidePanel
        availableProviders={availableProviders}
        selectedLLMProvider={selectedLLMProvider}
        onSearchChange={handleSearch}
        onProviderClick={handleProviderSelection}
      />
      <div className="w-[60%] h-full p-[18px] flex flex-col gap-2.5">
        <div className="flex flex-col gap-[15px]">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-white light:text-slate-800">
              {t("chat_window.workspace_llm_manager.available_models", {
                provider: providerName,
              })}
            </p>
            <p className="text-xs font-medium text-zinc-400 light:text-slate-500">
              {t(
                "chat_window.workspace_llm_manager.available_models_description"
              )}
            </p>
          </div>
          {!missingCredentials &&
            (selectedLLMProvider === "anythingllm-router" ? (
              <RouterPickerSelection
                selectedRouterId={selectedRouterId}
                setSelectedRouterId={setSelectedRouterId}
                setHasChanges={setHasChanges}
              />
            ) : (
              <ChatModelSelection
                provider={selectedLLMProvider}
                setHasChanges={setHasChanges}
                selectedLLMModel={selectedLLMModel}
                setSelectedLLMModel={setSelectedLLMModel}
                fallbackModel={selectedLLMModel}
              />
            ))}
        </div>
        <NoSetupWarning
          showing={missingCredentials}
          onSetupClick={() => {
            window.dispatchEvent(
              new CustomEvent(PROVIDER_SETUP_EVENT, {
                detail: {
                  provider: WORKSPACE_LLM_PROVIDERS.find(
                    (p) => p.value === selectedLLMProvider
                  ),
                  settings,
                },
              })
            );
          }}
        />
        {hasChanges && !missingCredentials && (
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="border-none text-xs px-4 py-1.5 font-semibold rounded-lg bg-white text-zinc-900 hover:bg-zinc-200 light:bg-slate-800 light:text-white light:hover:bg-slate-700 h-8 w-full cursor-pointer transition-colors mt-auto"
          >
            {saving
              ? t("chat_window.workspace_llm_manager.saving")
              : t("chat_window.workspace_llm_manager.save")}
          </button>
        )}
      </div>
    </div>
  );
}
