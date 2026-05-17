const DIRECT_LINK_PIPELINE = "direct_link";
const UPLOAD_AUDIO_PIPELINE = "upload_audio";
const DEFAULT_PROVIDER_ID = "removeMusic";

const PROVIDER_CATALOG = Object.freeze({
  soundboost: Object.freeze({
    id: "soundboost",
    labelKey: "providerSoundboost",
    pipelineType: DIRECT_LINK_PIPELINE,
    supportsChunkDuration: false,
    supportsPlaybackPrompt: true,
    selectionWarningKey: "directLinkProviderWarning"
  }),
  removeMusic: Object.freeze({
    id: "removeMusic",
    labelKey: "providerRemoveMusic",
    pipelineType: UPLOAD_AUDIO_PIPELINE,
    supportsChunkDuration: true,
    supportsPlaybackPrompt: true,
    selectionWarningKey: null
  }),
  lalal: Object.freeze({
    id: "lalal",
    labelKey: "providerLalal",
    pipelineType: UPLOAD_AUDIO_PIPELINE,
    supportsChunkDuration: true,
    supportsPlaybackPrompt: true,
    selectionWarningKey: null
  })
});

const PROVIDER_LIST = Object.freeze(Object.values(PROVIDER_CATALOG));

function normalizeProviderId(value) {
  return PROVIDER_CATALOG[value] ? value : DEFAULT_PROVIDER_ID;
}

function getProviderDefinition(value) {
  return PROVIDER_CATALOG[normalizeProviderId(value)] || PROVIDER_CATALOG[DEFAULT_PROVIDER_ID];
}

function listProviders() {
  return PROVIDER_LIST.slice();
}

function getProviderPipelineType(value) {
  return getProviderDefinition(value).pipelineType;
}

function isDirectLinkProvider(value) {
  return getProviderPipelineType(value) === DIRECT_LINK_PIPELINE;
}

function isUploadAudioProvider(value) {
  return getProviderPipelineType(value) === UPLOAD_AUDIO_PIPELINE;
}

function providerSupportsChunkDuration(value) {
  return getProviderDefinition(value).supportsChunkDuration === true;
}

function providerSupportsPlaybackPrompt(value) {
  return getProviderDefinition(value).supportsPlaybackPrompt === true;
}

function getProviderSelectionWarningKey(value) {
  return getProviderDefinition(value).selectionWarningKey || null;
}

function getProviderJobReuseKey({ providerId, youtubeUrl, chunkDurationSec }) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const normalizedUrl = String(youtubeUrl || "");

  if (providerSupportsChunkDuration(normalizedProviderId)) {
    return `${normalizedProviderId}::${normalizedUrl}::${String(chunkDurationSec ?? "")}`;
  }

  return `${normalizedProviderId}::${normalizedUrl}`;
}

const ITK_PROVIDERS = {
  DIRECT_LINK_PIPELINE,
  UPLOAD_AUDIO_PIPELINE,
  DEFAULT_PROVIDER_ID,
  PROVIDER_CATALOG,
  normalizeProviderId,
  getProviderDefinition,
  listProviders,
  getProviderPipelineType,
  isDirectLinkProvider,
  isUploadAudioProvider,
  providerSupportsChunkDuration,
  providerSupportsPlaybackPrompt,
  getProviderSelectionWarningKey,
  getProviderJobReuseKey
};

globalThis.ITK_PROVIDERS = ITK_PROVIDERS;
