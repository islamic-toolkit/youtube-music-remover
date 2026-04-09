/**
 * Islamic Toolkit - Music Remover v4.0 - Background Service Worker
 *
 * v4.4 - Explicit provider pipelines.
 * Providers now belong to one of two first-class pipelines:
 *   1. direct_link  â†’ provider receives the original YouTube URL and processes remotely
 *   2. upload_audio â†’ extension downloads audio, splits it into chunks, then uploads chunks
 *
 * Provider abstraction:
 *   - direct_link providers implement start(job, signal) and poll(job, signal)
 *   - upload_audio providers implement prepareChunk(chunk, job, signal) and pollChunk(chunk, job, signal)
 */

importScripts("provider-catalog.js", "i18n.js");

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CONSTANTS & CONFIG
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const CACHE_KEY = "vocalsUrlCache";
const JOBS_KEY = "processingJobs";
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const JOB_CLOCK_SKEW_MS = 250;
const providersApi = globalThis.ITK_PROVIDERS || {};
const DEFAULT_PROVIDER = providersApi.DEFAULT_PROVIDER_ID || "removeMusic";
const DEFAULT_CHUNK_DURATION_SEC = 30;
const MIN_CHUNK_DURATION_SEC = 10;
const MAX_CHUNK_DURATION_SEC = 60;
const TERMINAL_JOB_STATUSES = new Set(["ready", "error", "cancelled"]);
const EXPECTED_STEMS = new Set(["vocals", "drums", "bass", "other", "metronome"]);

// Pipeline concurrency: how many chunks to start/poll at once
const PIPELINE_UPLOAD_CONCURRENCY = 5;
const PIPELINE_POLL_CONCURRENCY = 6;

// â”€â”€â”€ SoundBoost Config â”€â”€â”€
const BASE_API = "https://api.soundboost.ai";
const IMPORT_URL = `${BASE_API}/api/studio/public/import-youtube/`;
const STATUS_URL_T = (id) => `${BASE_API}/api/studio/originals/${id}/status/`;
const START_URL_T = (id) => `${BASE_API}/api/studio/originals/${id}/start/`;
const STEMS_URL_T = (id) => `${BASE_API}/api/studio/originals/${id}/stems/`;
const UI_API_KEY = "dk-654321-jhgpol-2789456-ghysvn-bkjsqb";
const COMMON_HEADERS = {
  "accept": "application/json, text/plain, */*",
  "content-type": "application/json",
  "ui-api-key": UI_API_KEY,
  "x-studio-public": "1",
};
const PENDING_STEMS_HTTP_STATUSES = new Set([202, 204, 404, 409, 423, 425, 429, 500, 502, 503, 504]);




// â”€â”€â”€ Remove Music (InverseAI VMS) Config â”€â”€â”€
const REMOVE_MUSIC_BASE = "https://api.vms.inverseai.com";
const REMOVE_MUSIC_SERVER_TIME_URL = `${REMOVE_MUSIC_BASE}/core/v1/server-time/`;
const REMOVE_MUSIC_UPLOAD_URL = `${REMOVE_MUSIC_BASE}/separator/v1/vocal-music-separations/upload/`;
const REMOVE_MUSIC_STATUS_URL_T = (id) => `${REMOVE_MUSIC_BASE}/separator/v1/vocal-music-separations/${id}/`;
const REMOVE_MUSIC_POLL_INTERVAL_MS = 2500;
const REMOVE_MUSIC_MAX_POLLS = 200;
const REMOVE_MUSIC_ORIGIN = "https://remove.music";
const REMOVE_MUSIC_REFERER = "https://remove.music/";
const REMOVE_MUSIC_PLATFORMS = ["1", "2", "3", "4"];  // Rotate across platforms

const backgroundI18n = globalThis.ITK_I18N || {};
let currentLang = typeof backgroundI18n.normalizeLang === "function"
  ? backgroundI18n.normalizeLang("en")
  : "en";

// â”€â”€â”€ Anti-Rate-Limit: Rotate IP fingerprint per session â”€â”€â”€
// The InverseAI API runs behind nginx and may trust X-Forwarded-For / X-Real-IP
// to identify clients. We generate a random IP per processing session so each
// batch of chunks appears to come from a different user.
let _currentSpoofIp = "";

function generateRandomPublicIp() {
  // Generate a random IP that looks like a real public address
  // Avoid private/reserved ranges
  const first = [22,31,34,37,38,41,44,46,47,49,58,61,63,64,65,66,67,68,69,70,
    71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,
    95,96,97,98,99,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,
    116,117,118,119,120,121,122,123,124,125,128,129,130,131,132,133,134,135,136,
    137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,
    156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,
    175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,
    194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,
    213,214,215,216,217,218,219,220,221,222,223];
  const o1 = first[Math.floor(Math.random() * first.length)];
  const o2 = Math.floor(Math.random() * 256);
  const o3 = Math.floor(Math.random() * 256);
  const o4 = Math.floor(Math.random() * 254) + 1;
  return `${o1}.${o2}.${o3}.${o4}`;
}

async function rotateSpoofIp() {
  _currentSpoofIp = generateRandomPublicIp();
  console.log("[IslamicToolkit] Rotated spoof IP to:", _currentSpoofIp);
  // Update the declarativeNetRequest rule and wait for it to take effect
  await _updateIpSpoofRule(_currentSpoofIp);
  return _currentSpoofIp;
}

async function getSpoofIp() {
  if (!_currentSpoofIp) await rotateSpoofIp();
  return _currentSpoofIp;
}

async function _updateIpSpoofRule(ip) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9003, 9004],
      addRules: [
        {
          id: 9003, priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Cookie", operation: "remove" },
              { header: "X-Forwarded-For", operation: "set", value: ip },
              { header: "X-Real-IP", operation: "set", value: ip },
            ],
            responseHeaders: [
              { header: "Set-Cookie", operation: "remove" },
            ],
          },
          condition: { urlFilter: "||api.vms.inverseai.com/", resourceTypes: ["xmlhttprequest"] },
        },
        {
          id: 9004, priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Cookie", operation: "remove" },
              { header: "X-Forwarded-For", operation: "set", value: ip },
              { header: "X-Real-IP", operation: "set", value: ip },
            ],
            responseHeaders: [
              { header: "Set-Cookie", operation: "remove" },
            ],
          },
          condition: { urlFilter: "||etacloud.org/", resourceTypes: ["xmlhttprequest"] },
        },
      ],
    });
  } catch (e) { console.warn("[IslamicToolkit] Could not update IP spoof rule:", e.message); }
}


// â”€â”€â”€ Y2Mate Config (used by iotacloud) â”€â”€â”€
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// UTILITY
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const jobAbortControllers = new Map();
const jobLocks = new Set();

function getJobStorageArea() {
  return chrome.storage.session && typeof chrome.storage.session.get === "function"
    ? chrome.storage.session
    : chrome.storage.local;
}

function nowTs() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isTerminalJob(job) { return !job || TERMINAL_JOB_STATUSES.has(job.status); }

function normalizeLang(value) {
  if (typeof backgroundI18n.normalizeLang === "function") return backgroundI18n.normalizeLang(value);
  return value === "ar" ? "ar" : "en";
}

function bgTr(key, replacements, lang = currentLang) {
  if (typeof backgroundI18n.t === "function") return backgroundI18n.t(key, normalizeLang(lang), replacements);
  return key;
}

function localizeRuntimeText(message, lang = currentLang) {
  if (typeof backgroundI18n.translateRuntimeText === "function") {
    return backgroundI18n.translateRuntimeText(message, normalizeLang(lang));
  }
  return message || "";
}

chrome.storage.local.get(["lang"], (result) => {
  currentLang = normalizeLang(result?.lang);
});

function normalizeProvider(value) {
  if (typeof providersApi.normalizeProviderId === "function") {
    return providersApi.normalizeProviderId(value);
  }
  return DEFAULT_PROVIDER;
}

function getProviderDefinition(value) {
  if (typeof providersApi.getProviderDefinition === "function") {
    return providersApi.getProviderDefinition(value);
  }

  return {
    id: DEFAULT_PROVIDER,
    pipelineType: "upload_audio",
    supportsChunkDuration: true,
    supportsPlaybackPrompt: true,
    selectionWarningKey: null
  };
}

function getProviderPipelineType(value) {
  if (typeof providersApi.getProviderPipelineType === "function") {
    return providersApi.getProviderPipelineType(value);
  }
  return getProviderDefinition(value).pipelineType;
}

function providerSupportsChunkDuration(value) {
  if (typeof providersApi.providerSupportsChunkDuration === "function") {
    return providersApi.providerSupportsChunkDuration(value);
  }
  return getProviderDefinition(value).supportsChunkDuration === true;
}

function getProviderJobReuseKeyValue(providerId, youtubeUrl, chunkDurationSec) {
  if (typeof providersApi.getProviderJobReuseKey === "function") {
    return providersApi.getProviderJobReuseKey({ providerId, youtubeUrl, chunkDurationSec });
  }
  return `${normalizeProvider(providerId)}::${youtubeUrl || ""}::${chunkDurationSec || ""}`;
}

function normalizeChunkDurationSec(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CHUNK_DURATION_SEC;
  return Math.min(MAX_CHUNK_DURATION_SEC, Math.max(MIN_CHUNK_DURATION_SEC, parsed));
}

function normalizePlaybackStartSec(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function extractVideoId(youtubeUrl) {
  try {
    const url = new URL(youtubeUrl);
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0];
    return url.searchParams.get("v") || "";
  } catch (e) { return ""; }
}

function createUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildHeaders(guestToken = "") {
  const headers = { ...COMMON_HEADERS };
  if (guestToken) headers["x-public-access-token"] = guestToken;
  return headers;
}

function extractStemNameFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const stem of EXPECTED_STEMS) {
      if (path.includes(stem)) return stem;
    }
  } catch (e) {}
  return "";
}

function findAllUrls(obj, collected = []) {
  if (!obj || typeof obj !== "object") return collected;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) {
      collected.push({ key, url: value });
    } else if (typeof value === "object") {
      findAllUrls(value, collected);
    }
  }
  return collected;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// JOB CRUD
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function createJobId() {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getReadyChunkCount(chunks) {
  return chunks.filter(c => c.status === "ready").length;
}

function getChunkDetail(chunks) {
  const ready = getReadyChunkCount(chunks);
  const total = chunks.length;
  const processing = chunks.filter(c => c.status === "processing").length;
  if (ready >= total) return `All ${total} chunks processed`;
  return `Chunks: ${ready}/${total} done, ${processing} processing`;
}

function createJob(youtubeUrl, tabId, options = {}) {
  const provider = normalizeProvider(options.provider);
  const chunkDurationSec = normalizeChunkDurationSec(options.chunkDurationSec);
  const pipelineType = getProviderPipelineType(provider);
  return {
    id: createJobId(),
    youtubeUrl,
    tabId,
    status: "processing",
    pipelineType,
    phase: pipelineType === "direct_link" ? "direct_link_start" : "download_audio",
    detail: pipelineType === "direct_link" ? bgTr("starting") : bgTr("extractingAudio"),
    error: "",
    vocalsUrl: "",
    createdAt: nowTs(),
    updatedAt: nowTs(),
    provider,
    chunkDurationSec,
    providerSessionUuid: "",
    totalDurationSec: 0,
    totalChunks: 0,
    readyChunkCount: 0,
    chunks: [],
    providerState: null,
    playbackStartSec: normalizePlaybackStartSec(options.playbackStartSec),
    fullAudioDurationSec: 0,
    audioMimeType: "",
    nextPollAt: 0,
  };
}

function toJobResponse(job) {
  if (!job) {
    return {
      jobId: "", status: "error", phase: "done", detail: bgTr("jobNotFound"),
      vocalsUrl: "", error: bgTr("jobNotFound"), nextPollAt: 0, nextPollInMs: 0,
      provider: DEFAULT_PROVIDER, chunkDurationSec: DEFAULT_CHUNK_DURATION_SEC,
      totalDurationSec: 0, totalChunks: 0, readyChunkCount: 0, chunks: [],
    };
  }
  const nextPollInMs = job.nextPollAt
    ? Math.max(0, job.nextPollAt - nowTs() + JOB_CLOCK_SKEW_MS)
    : 0;
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    detail: localizeRuntimeText(job.detail || ""),
    vocalsUrl: job.vocalsUrl || "",
    error: localizeRuntimeText(job.error || ""),
    nextPollAt: job.nextPollAt || 0,
    nextPollInMs,
    provider: job.provider || DEFAULT_PROVIDER,
    chunkDurationSec: job.chunkDurationSec || DEFAULT_CHUNK_DURATION_SEC,
    totalDurationSec: job.totalDurationSec || 0,
    totalChunks: job.totalChunks || 0,
    readyChunkCount: job.readyChunkCount || 0,
    playbackStartSec: job.playbackStartSec || 0,
    chunks: (job.chunks || []).map(c => ({
      index: c.index, startSec: c.startSec, endSec: c.endSec,
      durationSec: c.durationSec, status: c.status,
      detail: localizeRuntimeText(c.detail || ""), vocalsUrl: c.vocalsUrl || "", error: localizeRuntimeText(c.error || ""),
    })),
  };
}

function markJob(job, updates = {}) {
  return { ...job, ...updates, updatedAt: nowTs() };
}

function sendStatus(tabId, type, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: "PROCESS_STATUS", statusType: type, message: localizeRuntimeText(message),
  }).catch(() => {});
}

function getStatusMessageType(job) {
  if (!job) return "error";
  switch (job.status) {
    case "ready": return "ready";
    case "error": return "error";
    case "cancelled": return "error";
    default: return "processing";
  }
}

function beginJobFetch(jobId) {
  let controller = jobAbortControllers.get(jobId);
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    jobAbortControllers.set(jobId, controller);
  }
  return controller.signal;
}

function finishJobFetch(jobId) { /* no-op */ }

function abortJob(jobId) {
  const controller = jobAbortControllers.get(jobId);
  if (controller) {
    controller.abort();
    jobAbortControllers.delete(jobId);
  }
}

function pruneJobs(jobs) {
  const cutoff = nowTs() - JOB_TTL_MS;
  const pruned = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (job.updatedAt >= cutoff) pruned[id] = job;
  }
  return pruned;
}

async function getAllJobs() {
  const storage = getJobStorageArea();
  const data = await new Promise(r => storage.get(JOBS_KEY, r));
  return pruneJobs(data[JOBS_KEY] || {});
}

async function setAllJobs(jobs) {
  const storage = getJobStorageArea();
  await new Promise(r => storage.set({ [JOBS_KEY]: jobs }, r));
}

async function getJob(jobId) {
  const jobs = await getAllJobs();
  return jobs[jobId] || null;
}

async function saveJob(job) {
  const jobs = await getAllJobs();
  jobs[job.id] = job;
  await setAllJobs(jobs);
}

async function deleteJob(jobId) {
  const jobs = await getAllJobs();
  delete jobs[jobId];
  await setAllJobs(jobs);
}

function findReusableJob(youtubeUrl, provider, chunkDurationSec) {
  return getAllJobs().then(jobs => {
    const targetKey = getProviderJobReuseKeyValue(provider, youtubeUrl, chunkDurationSec);
    for (const job of Object.values(jobs)) {
      const jobKey = getProviderJobReuseKeyValue(job.provider, job.youtubeUrl, job.chunkDurationSec);
      if (jobKey === targetKey && !isTerminalJob(job)) {
        return job;
      }
    }
    return null;
  });
}

function findCompletedJob(youtubeUrl, provider, chunkDurationSec) {
  return getAllJobs().then(jobs => {
    const targetKey = getProviderJobReuseKeyValue(provider, youtubeUrl, chunkDurationSec);
    for (const job of Object.values(jobs)) {
      const jobKey = getProviderJobReuseKeyValue(job.provider, job.youtubeUrl, job.chunkDurationSec);
      if (jobKey === targetKey && job.status === "ready") {
        return job;
      }
    }
    return null;
  });
}

async function cancelJobsForUrl(youtubeUrl, reason) {
  const jobs = await getAllJobs();
  for (const job of Object.values(jobs)) {
    if (job.youtubeUrl === youtubeUrl && !isTerminalJob(job)) {
      abortJob(job.id);
      jobs[job.id] = markJob(job, {
        status: "cancelled", phase: "done", detail: reason || "Cancelled", nextPollAt: 0,
      });
    }
  }
  await setAllJobs(jobs);
}

async function cancelJobById(jobId) {
  abortJob(jobId);
  const job = await getJob(jobId);
  if (job && !isTerminalJob(job)) {
    await saveJob(markJob(job, {
      status: "cancelled", phase: "done", detail: "Cancelled", nextPollAt: 0,
    }));
  }
}

// â”€â”€â”€ Vocals URL Cache â”€â”€â”€

async function getCachedVocalsUrl(youtubeUrl) {
  const data = await new Promise(r => chrome.storage.local.get(CACHE_KEY, r));
  return (data[CACHE_KEY] || {})[youtubeUrl] || "";
}

async function setCachedVocalsUrl(youtubeUrl, vocalsUrl) {
  const data = await new Promise(r => chrome.storage.local.get(CACHE_KEY, r));
  const cache = data[CACHE_KEY] || {};
  cache[youtubeUrl] = vocalsUrl;
  await new Promise(r => chrome.storage.local.set({ [CACHE_KEY]: cache }, r));
}

async function deleteCachedVocalsUrl(youtubeUrl) {
  const data = await new Promise(r => chrome.storage.local.get(CACHE_KEY, r));
  const cache = data[CACHE_KEY] || {};
  delete cache[youtubeUrl];
  await new Promise(r => chrome.storage.local.set({ [CACHE_KEY]: cache }, r));
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// YOUTUBE AUDIO DOWNLOAD (Y2Mate proxy + fallback)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function getAudioInfoFromContentScript(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 15000);
    chrome.tabs.sendMessage(tabId, { type: "GET_YOUTUBE_AUDIO_INFO" }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!response) { reject(new Error("No response")); return; }
      if (response.error) { reject(new Error(response.error)); return; }
      resolve(response);
    });
  });
}

async function getAudioInfoFromInnertubeApi(videoId, signal) {
  const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": "2.20250401.00.00",
    },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: "WEB", clientVersion: "2.20250401.00.00", hl: "en", gl: "US" } },
      playbackContext: { contentPlaybackContext: { signatureTimestamp: 20073 } },
    }),
    signal,
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Innertube API failed: ${response.status}`);
  const data = await response.json();
  const playabilityStatus = data?.playabilityStatus?.status;
  if (playabilityStatus && playabilityStatus !== "OK") {
    throw new Error(`Video not playable: ${data?.playabilityStatus?.reason || playabilityStatus}`);
  }
  const durationSec = data?.videoDetails?.lengthSeconds ? parseInt(data.videoDetails.lengthSeconds, 10) : 0;
  return { durationSec: durationSec || 0 };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// YOUTUBE AUDIO DOWNLOAD (iotacloud primary + Loader.to fallback)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€â”€ Header Rules â”€â”€â”€

(async () => {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9001, 9002, 9003, 9004, 9005, 9006, 9007],
      addRules: [
        {
          id: 9002, priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: "https://remove.music" },
              { header: "Referer", operation: "set", value: "https://remove.music/" },
              { header: "Sec-Fetch-Site", operation: "set", value: "cross-site" },
            ],
          },
          condition: { urlFilter: "||api.vms.inverseai.com/", resourceTypes: ["xmlhttprequest"] },
        },
        {
          id: 9003, priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Cookie", operation: "remove" },
              { header: "X-Forwarded-For", operation: "set", value: generateRandomPublicIp() },
              { header: "X-Real-IP", operation: "set", value: generateRandomPublicIp() },
            ],
            responseHeaders: [
              { header: "Set-Cookie", operation: "remove" },
            ],
          },
          condition: { urlFilter: "||api.vms.inverseai.com/", resourceTypes: ["xmlhttprequest"] },
        },
        {
          id: 9005, priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://loader.to/" },
              { header: "Cookie", operation: "remove" },
            ],
            responseHeaders: [
              { header: "Set-Cookie", operation: "remove" },
            ],
          },
          condition: { urlFilter: "||loader.to/", resourceTypes: ["xmlhttprequest"] },
        },
        {
          id: 9006, priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: "https://y2mate.sc" },
              { header: "Referer", operation: "set", value: "https://y2mate.sc/" },
              { header: "Cookie", operation: "remove" },
            ],
            responseHeaders: [
              { header: "Set-Cookie", operation: "remove" },
            ],
          },
          condition: { urlFilter: "||iotacloud.org/", resourceTypes: ["xmlhttprequest"] },
        },
        {
          id: 9007, priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: "https://y2mate.sc" },
              { header: "Referer", operation: "set", value: "https://y2mate.sc/" },
              { header: "Cookie", operation: "remove" },
            ],
            responseHeaders: [
              { header: "Set-Cookie", operation: "remove" },
            ],
          },
          condition: { urlFilter: "||etacloud.org/", resourceTypes: ["xmlhttprequest"] },
        },
      ],
    });
  } catch (e) { console.warn("[IslamicToolkit] Could not install header rules:", e.message); }
})();

let y2mateConfigCache = null;
let y2mateConfigCacheTime = 0;
const Y2MATE_CONFIG_TTL_MS = 30 * 60 * 1000;

function getY2MateTimestampSec() {
  return Math.floor(Date.now() / 1000);
}

function decodeY2MateAuthorization(payload) {
  const source = Array.isArray(payload?.[0]) ? payload[0] : null;
  const offsets = Array.isArray(payload?.[2]) ? payload[2] : null;
  if (!source?.length || !offsets?.length) {
    throw new Error("Y2Mate auth payload is incomplete");
  }

  let authorization = "";
  for (let i = 0; i < source.length; i++) {
    authorization += String.fromCharCode(source[i] - offsets[offsets.length - (i + 1)]);
  }

  if (payload[1]) authorization = authorization.split("").reverse().join("");
  return authorization.length > 32 ? authorization.slice(0, 32) : authorization;
}

async function y2mateFetchConfig(signal) {
  const response = await fetch("https://y2mate.sc/", { signal });
  if (!response.ok) throw new Error(`Failed to fetch y2mate.sc page: ${response.status}`);
  const html = await response.text();
  const jsonMatch = html.match(/var\s+json\s*=\s*JSON\.parse\('([^']+)'\);/);
  if (!jsonMatch) throw new Error("Could not find auth payload on y2mate.sc page");
  const payload = JSON.parse(jsonMatch[1]);
  const key = decodeY2MateAuthorization(payload);
  const etacloudParamCode = Number(payload?.[6]);
  return {
    key,
    iotacloudParamName: "a",
    etacloudInitParamName: Number.isFinite(etacloudParamCode) ? String.fromCharCode(etacloudParamCode) : "r",
  };
}

async function getY2MateConfig(signal) {
  const now = Date.now();
  if (y2mateConfigCache && (now - y2mateConfigCacheTime) < Y2MATE_CONFIG_TTL_MS) return y2mateConfigCache;
  y2mateConfigCache = await y2mateFetchConfig(signal);
  y2mateConfigCacheTime = now;
  return y2mateConfigCache;
}

// â”€â”€â”€ Primary: iotacloud.org (handles all videos including long ones) â”€â”€â”€

async function iotacloudDownload(videoId, signal, statusCallback) {
  const config = await getY2MateConfig(signal);
  const timestamp = getY2MateTimestampSec();
  const apiUrl = `https://iotacloud.org/api/?${config.iotacloudParamName}=${encodeURIComponent(config.key)}&r=1&v=${encodeURIComponent(videoId)}&t=${timestamp}`;

  if (statusCallback) statusCallback("Converting video to audio...");

  const response = await fetch(apiUrl, {
    signal,
    headers: {
      "Accept": "*/*",
      "Origin": "https://y2mate.sc",
      "Referer": "https://y2mate.sc/",
    },
  });
  if (!response.ok) throw new Error(`iotacloud API failed: ${response.status}`);
  const data = await response.json();
  const downloadURL = data.downloadURL || data.url || "";

  if (data.progress === "error") throw new Error("iotacloud: conversion error");
  if (downloadURL) return { downloadURL, durationSec: data.durationSec || 0 };

  // Poll for completion
  const MAX_POLLS = 120;
  for (let pollCount = 2; pollCount <= MAX_POLLS; pollCount++) {
    await sleep(3000);
    if (statusCallback) statusCallback(`Converting audio... (poll ${pollCount}/${MAX_POLLS})`);

    const pollUrl = `https://iotacloud.org/api/?${config.iotacloudParamName}=${encodeURIComponent(config.key)}&r=${pollCount}&v=${encodeURIComponent(videoId)}&t=${timestamp}`;
    const pollResp = await fetch(pollUrl, {
      signal,
      headers: {
        "Accept": "*/*",
        "Origin": "https://y2mate.sc",
        "Referer": "https://y2mate.sc/",
      },
    });
    if (!pollResp.ok) throw new Error(`iotacloud poll failed: ${pollResp.status}`);
    const result = await pollResp.json();
    const pollDownloadURL = result.downloadURL || result.url || "";

    if (result.progress === "error") throw new Error("iotacloud: conversion error during polling");
    if (pollDownloadURL) return { downloadURL: pollDownloadURL, durationSec: result.durationSec || 0 };
  }

  throw new Error("iotacloud: conversion did not complete");
}

// â”€â”€â”€ Fallback: Y2Mate / Etacloud convert flow â”€â”€â”€

const ETACLOUD_INIT_URL = "https://eta.etacloud.org/api/v1/init";
const ETACLOUD_MAX_STEPS = 12;
const ETACLOUD_POLL_INTERVAL_MS = 3000;

function buildUrlWithParams(rawUrl, params = {}) {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function appendUrlParams(rawUrl, params = {}) {
  const separator = rawUrl.includes("?") ? "&" : "?";
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return query ? `${rawUrl}${separator}${query}` : rawUrl;
}

function getProviderErrorCode(data) {
  const numericError = Number(data?.error);
  return Number.isFinite(numericError) ? numericError : 0;
}

function describeY2MateError(code) {
  switch (code) {
    case 214: return "Video type livestream";
    case 215: return "Video length exceeds provider limit";
    case 243: return "Video unavailable";
    case 244: return "Video unavailable";
    case 245: return "Provider rejected the conversion";
    default: return `Provider error ${code}`;
  }
}

async function etacloudDownload(videoId, signal, statusCallback) {
  const config = await getY2MateConfig(signal);
  const initUrl = buildUrlWithParams(ETACLOUD_INIT_URL, {
    [config.etacloudInitParamName]: config.key,
    t: getY2MateTimestampSec(),
  });

  if (statusCallback) statusCallback("Preparing Y2Mate fallback...");

  const initResp = await fetch(initUrl, {
    signal,
    headers: {
      "Accept": "application/json",
      "Origin": "https://y2mate.sc",
      "Referer": "https://y2mate.sc/",
    },
  });
  if (!initResp.ok) throw new Error(`Etacloud init failed: ${initResp.status}`);
  const initData = await initResp.json();
  const initError = getProviderErrorCode(initData);
  if (initError) throw new Error(describeY2MateError(initError));
  if (!initData.convertURL) throw new Error("Etacloud init returned no conversion URL");

  let requestUrl = buildUrlWithParams(initData.convertURL, {
    v: videoId,
    f: "mp3",
    t: getY2MateTimestampSec(),
  });

  for (let step = 1; step <= ETACLOUD_MAX_STEPS; step++) {
    if (statusCallback) statusCallback(`Trying Y2Mate fallback... (${step}/${ETACLOUD_MAX_STEPS})`);

    const response = await fetch(requestUrl, {
      signal,
      headers: {
        "Accept": "application/json",
        "Origin": "https://y2mate.sc",
        "Referer": "https://y2mate.sc/",
      },
    });
    if (!response.ok) throw new Error(`Etacloud request failed: ${response.status}`);
    const data = await response.json();
    const errorCode = getProviderErrorCode(data);
    if (errorCode) throw new Error(describeY2MateError(errorCode));

    const downloadURL = data.downloadURL || data.url || "";
    if (downloadURL) {
      return { downloadURL, durationSec: data.durationSec || 0 };
    }

    if (Number(data.redirect) === 1 && data.redirectURL) {
      requestUrl = buildUrlWithParams(data.redirectURL, {
        v: videoId,
        f: "mp3",
        t: getY2MateTimestampSec(),
      });
      continue;
    }

    if (data.progressURL) {
      await sleep(ETACLOUD_POLL_INTERVAL_MS);
      requestUrl = buildUrlWithParams(data.progressURL, {
        t: getY2MateTimestampSec(),
      });
      continue;
    }

    throw new Error("Etacloud returned no download or progress URL");
  }

  throw new Error("Etacloud conversion timed out");
}

// â”€â”€â”€ Main Download Function â”€â”€â”€

async function downloadYouTubeAudio(youtubeUrl, tabId, signal, statusCallback) {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) throw new Error("Could not extract video ID from YouTube URL");

  // Helper to resolve duration from multiple sources
  async function resolveDuration(audioBlob) {
    let durationSec = 0;
    try { const info = await getAudioInfoFromContentScript(tabId); durationSec = info?.durationSec || 0; } catch (e) {}
    if (!durationSec) {
      try { const info = await getAudioInfoFromInnertubeApi(videoId, signal); durationSec = info?.durationSec || 0; } catch (e) {}
    }
    if (!durationSec || durationSec <= 0) {
      durationSec = Math.max(1, Math.round((audioBlob.size * 8) / 192000));
    }
    return durationSec;
  }

  // Helper to download and validate an audio URL
  async function fetchAudioBlob(downloadURL, source) {
    const fullDownloadUrl = appendUrlParams(downloadURL, {
      s: 3,
      v: videoId,
      f: "mp3",
    });
    if (statusCallback) statusCallback(`Downloading audio file (${source})...`);
    const audioResponse = await fetch(fullDownloadUrl, { signal });
    if (!audioResponse.ok) throw new Error(`Audio download failed (${source}): ${audioResponse.status}`);
    const audioBlob = await audioResponse.blob();
    if (!audioBlob || audioBlob.size < 1000) {
      throw new Error(`Downloaded audio file is too small or empty (${source})`);
    }
    return audioBlob;
  }

  let lastError = null;

  // â€”â€”â€” Primary: iotacloud.org â€”â€”â€”
  try {
    if (statusCallback) statusCallback("Converting video to audio (iotacloud)...");
    const iotaResult = await iotacloudDownload(videoId, signal, statusCallback);
    if (iotaResult.downloadURL) {
      const audioBlob = await fetchAudioBlob(iotaResult.downloadURL, "iotacloud");
      const durationSec = await resolveDuration(audioBlob);
      console.log("[IslamicToolkit] Audio downloaded via iotacloud:", audioBlob.size, "bytes,", durationSec, "sec");
      return { blob: audioBlob, durationSec, mimeType: "audio/mpeg" };
    }
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    console.warn("[IslamicToolkit] iotacloud failed:", err.message);
    lastError = err;
  }

  // â€”â€”â€” Fallback: Y2Mate / Etacloud â€”â€”â€”
  console.log("[IslamicToolkit] iotacloud failed, trying Y2Mate fallback...");
  if (statusCallback) statusCallback("Trying alternative download (Y2Mate)...");

  try {
    const fallbackResult = await etacloudDownload(videoId, signal, statusCallback);
    if (!fallbackResult.downloadURL) throw new Error("Y2Mate fallback returned no download URL");
    const audioBlob = await fetchAudioBlob(fallbackResult.downloadURL, "y2mate");
    const durationSec = await resolveDuration(audioBlob);
    console.log("[IslamicToolkit] Audio downloaded via Y2Mate fallback:", audioBlob.size, "bytes,", durationSec, "sec");
    return { blob: audioBlob, durationSec, mimeType: "audio/mpeg" };

  } catch (fallbackErr) {
    if (fallbackErr && fallbackErr.name === "AbortError") throw fallbackErr;
    console.error("[IslamicToolkit] Y2Mate fallback also failed:", fallbackErr.message);
  }

  throw lastError || new Error("Audio download failed: all providers exhausted");
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUDIO CHUNKING
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function buildChunks(totalDurationSec, chunkDurationSec) {
  const total = Math.max(0, Math.ceil(totalDurationSec || 0));
  const chunkLen = normalizeChunkDurationSec(chunkDurationSec);
  const chunks = [];
  for (let startSec = 0, index = 0; startSec < total; startSec += chunkLen, index++) {
    const endSec = Math.min(total, startSec + chunkLen);
    chunks.push({
      index, startSec, endSec,
      durationSec: Math.max(1, endSec - startSec),
      status: "pending", detail: "Queued",
      providerJobId: "", taskUuid: "", vocalsUrl: "", error: "",
      // provider-specific metadata stored here too
      inputUrl: "", downloadUrl: "",
    });
  }
  return chunks;
}

function getPreferredChunkIndex(chunks, playbackStartSec) {
  if (!Array.isArray(chunks) || !chunks.length) return 0;

  const targetTimeSec = normalizePlaybackStartSec(playbackStartSec);
  const exactMatch = chunks.find(chunk => targetTimeSec >= chunk.startSec && targetTimeSec < chunk.endSec);
  if (exactMatch) return exactMatch.index;

  if (targetTimeSec >= chunks[chunks.length - 1].endSec) {
    return chunks[chunks.length - 1].index;
  }

  return chunks[0].index;
}

function getPrioritizedChunks(chunks, playbackStartSec, predicate = () => true) {
  if (!Array.isArray(chunks) || !chunks.length) return [];

  const chunkByIndex = new Map(chunks.map(chunk => [chunk.index, chunk]));
  const preferredIndex = getPreferredChunkIndex(chunks, playbackStartSec);
  const prioritized = [];

  for (let index = preferredIndex; index < chunks.length; index += 1) {
    const chunk = chunkByIndex.get(index);
    if (chunk && predicate(chunk)) prioritized.push(chunk);
  }

  for (let index = preferredIndex - 1; index >= 0; index -= 1) {
    const chunk = chunkByIndex.get(index);
    if (chunk && predicate(chunk)) prioritized.push(chunk);
  }

  return prioritized;
}

async function sliceAudioBlob(audioBlob, startSec, endSec, totalDurationSec) {
  const totalBytes = audioBlob.size;
  const mimeType = audioBlob.type || "audio/mpeg";

  // For non-MP3 formats, fallback to proportional slicing
  if (!mimeType.includes("mpeg") && !mimeType.includes("mp3")) {
    const startByte = Math.floor((startSec / totalDurationSec) * totalBytes);
    const endByte = Math.floor((endSec / totalDurationSec) * totalBytes);
    return audioBlob.slice(startByte, endByte, mimeType);
  }

  // MP3 frame-accurate slicing
  // Scan MP3 frame headers to build a timeâ†’byte index
  try {
    const buf = await audioBlob.arrayBuffer();
    const view = new Uint8Array(buf);
    const frames = scanMp3Frames(view);

    if (!frames || frames.length === 0) {
      // Fallback to proportional if we can't parse frames
      console.warn("[IslamicToolkit] MP3 frame scan failed, using proportional slice");
      const startByte = Math.floor((startSec / totalDurationSec) * totalBytes);
      const endByte = Math.floor((endSec / totalDurationSec) * totalBytes);
      return audioBlob.slice(startByte, endByte, mimeType);
    }

    // Find the byte offsets for start and end times
    let startByte = 0;
    let endByte = totalBytes;
    let accumulatedTime = 0;

    for (const frame of frames) {
      if (accumulatedTime + frame.durationSec <= startSec) {
        accumulatedTime += frame.durationSec;
        startByte = frame.offset + frame.size;
        continue;
      }
      if (accumulatedTime >= endSec) {
        endByte = frame.offset;
        break;
      }
      accumulatedTime += frame.durationSec;
    }

    console.log(`[IslamicToolkit] Frame-accurate slice: ${startSec}s-${endSec}s â†’ bytes ${startByte}-${endByte} (of ${totalBytes})`);
    return audioBlob.slice(startByte, endByte, mimeType);
  } catch (err) {
    console.warn("[IslamicToolkit] Frame-accurate slice failed, using proportional:", err.message);
    const startByte = Math.floor((startSec / totalDurationSec) * totalBytes);
    const endByte = Math.floor((endSec / totalDurationSec) * totalBytes);
    return audioBlob.slice(startByte, endByte, mimeType);
  }
}

/**
 * Scan MP3 frame headers to build a frame index.
 * Each frame has: offset, size (bytes), durationSec.
 * Returns array of { offset, size, durationSec }.
 */
function scanMp3Frames(data) {
  const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const MP3_SAMPLERATES_V1 = [44100, 48000, 32000, 0];
  const MP3_SAMPLERATES_V2 = [22050, 24000, 16000, 0];
  const MP3_SAMPLERATES_V25 = [11025, 12000, 8000, 0];

  const frames = [];
  let pos = 0;
  const len = data.length;

  // Skip ID3v2 tag if present
  if (len > 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    const s = data.subarray(6, 10);
    const tagSize = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3];
    pos = tagSize + 10;
    if (data[5] & 0x10) pos += 10; // footer
  }

  let maxFrames = 500000; // safety limit

  while (pos < len - 4 && maxFrames-- > 0) {
    // Look for sync word: 0xFF followed by 0xE0+ (11 sync bits)
    if (data[pos] !== 0xFF || (data[pos + 1] & 0xE0) !== 0xE0) {
      pos++;
      continue;
    }

    const b1 = data[pos + 1];
    const b2 = data[pos + 2];
    const b3 = data[pos + 3];

    // Parse header
    const versionBits = (b1 >> 3) & 0x03;  // 00=2.5, 01=reserved, 10=2, 11=1
    const layerBits = (b1 >> 1) & 0x03;     // 01=Layer3, 10=Layer2, 11=Layer1
    const bitrateIdx = (b2 >> 4) & 0x0F;
    const srIdx = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;

    // We only handle MPEG1/2/2.5 Layer 3
    if (versionBits === 0x01 || layerBits === 0x00 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      pos++;
      continue;
    }

    const isV1 = versionBits === 0x03;
    const isV2 = versionBits === 0x02;
    // const isV25 = versionBits === 0x00;

    const bitrate = isV1 ? MP3_BITRATES_V1_L3[bitrateIdx] : MP3_BITRATES_V2_L3[bitrateIdx];
    const sampleRate = isV1 ? MP3_SAMPLERATES_V1[srIdx] : (isV2 ? MP3_SAMPLERATES_V2[srIdx] : MP3_SAMPLERATES_V25[srIdx]);

    if (!bitrate || !sampleRate) {
      pos++;
      continue;
    }

    const samplesPerFrame = isV1 ? 1152 : 576;
    const frameSize = Math.floor((samplesPerFrame * bitrate * 1000 / 8) / sampleRate) + padding;
    const frameDuration = samplesPerFrame / sampleRate;

    if (frameSize < 4 || pos + frameSize > len) {
      pos++;
      continue;
    }

    // Validate: next position should also be a sync word (or end of file)
    const nextPos = pos + frameSize;
    if (nextPos < len - 1 && (data[nextPos] !== 0xFF || (data[nextPos + 1] & 0xE0) !== 0xE0)) {
      // Not a valid frame sequence, skip
      pos++;
      continue;
    }

    frames.push({ offset: pos, size: frameSize, durationSec: frameDuration });
    pos = nextPos;
  }

  return frames;
}

/**
 * Strip ID3v2 (header) and ID3v1 (footer) tags from an audio blob.
 * The InverseAI API fingerprints uploads by ID3 metadata (title, artist,
 * album art) to track per-song demo usage. Removing these tags makes each
 * chunk appear as anonymous raw audio, bypassing the fingerprint check.
 */
async function stripId3Tags(blob) {
  const buf = await blob.arrayBuffer();
  const view = new Uint8Array(buf);
  let start = 0;
  let end = view.length;

  // Strip ID3v2 header (appears at the start)
  // Format: "ID3" + version(2b) + flags(1b) + size(4b synchsafe)
  if (view.length > 10 && view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) {
    const s = view.subarray(6, 10);
    const tagSize = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3];
    start = tagSize + 10;
    // Some files have a footer (10 more bytes) if flags bit 4 is set
    if (view[5] & 0x10) start += 10;
    console.log("[IslamicToolkit] Stripped ID3v2 tag:", tagSize, "bytes");
  }

  // Strip ID3v1 footer (last 128 bytes, starts with "TAG")
  if (end - start > 128) {
    const tail = view.subarray(end - 128, end - 125);
    if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
      end -= 128;
      console.log("[IslamicToolkit] Stripped ID3v1 tag (128 bytes)");
    }
  }

  if (start > 0 || end < view.length) {
    return new Blob([view.subarray(start, end)], { type: blob.type || "audio/mpeg" });
  }
  return blob; // No ID3 tags found
}

// Global map: jobId â†’ { blob, durationSec, mimeType }
const audioBlobs = new Map();

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROVIDER INTERFACE (Plugin Pattern)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Each provider implements one explicit pipeline contract:
//   direct_link  â†’ start(job, signal), poll(job, signal), getPollInterval()
//   upload_audio â†’ prepareChunk(chunk, job, signal), pollChunk(chunk, job, signal), getPollInterval()
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•



// â”€â”€â”€ SoundBoost Provider (direct-link pipeline) â”€â”€â”€

const SoundBoostProvider = {
  getPollInterval() { return 1000; },

  async start(job, signal) {
    // SoundBoost imports the whole YouTube URL â€” not a sliced blob
    sendStatus(job.tabId, "importing", bgTr("importingTrack"));
    const importData = await importYouTube(job.youtubeUrl, signal);
    const originalId = importData.studio_original_id;
    const guestToken = importData.public_access_token || "";
    if (!originalId) throw new Error(bgTr("noStudioOriginalId"));

    // Try prewarm
    try { await startSplitting(originalId, guestToken, signal); } catch (e) {}

    return markJob(job, {
      status: "processing",
      phase: "direct_link_processing",
      detail: bgTr("separatingFromMusic"),
      error: "",
      providerState: {
        phase: "wait_import",
        originalId,
        guestToken,
        importPollCount: 0,
        stemsPollCount: 0
      },
      nextPollAt: nowTs() + this.getPollInterval()
    });
  },

  async poll(job, signal) {
    const providerState = job.providerState || {};
    const originalId = providerState.originalId || "";
    const guestToken = providerState.guestToken || "";
    const phase = providerState.phase || "wait_import";

    if (phase === "wait_import") {
      const importPollCount = (providerState.importPollCount || 0) + 1;
      const data = await getImportStatus(originalId, guestToken, signal);
      const importStatus = (data.import_status || data.status || "").toLowerCase();

      if (["ready", "completed", "done", "imported", "complete"].includes(importStatus)) {
        await startSplitting(originalId, guestToken, signal);
        return markJob(job, {
          detail: bgTr("separatingVocalsShort"),
          providerState: {
            ...providerState,
            phase: "wait_stems",
            importPollCount
          },
          nextPollAt: nowTs() + this.getPollInterval()
        });
      }
      if (["failed", "error"].includes(importStatus)) {
        const errorMessage = `Import failed: ${JSON.stringify(data)}`;
        return markJob(job, {
          status: "error",
          phase: "done",
          detail: errorMessage,
          error: errorMessage,
          nextPollAt: 0
        });
      }
      if (importPollCount >= 300) {
        const errorMessage = bgTr("timedOutWaitingImport");
        return markJob(job, {
          status: "error",
          phase: "done",
          detail: errorMessage,
          error: errorMessage,
          nextPollAt: 0
        });
      }
      return markJob(job, {
        detail: bgTr("importingAudio", { n: importPollCount }),
        providerState: {
          ...providerState,
          importPollCount
        },
        nextPollAt: nowTs() + this.getPollInterval()
      });
    }

    if (phase === "wait_stems") {
      const stemsPollCount = (providerState.stemsPollCount || 0) + 1;
      const vocalsUrl = await _getVocalsUrl(originalId, guestToken, signal);

      if (vocalsUrl) {
        await setCachedVocalsUrl(job.youtubeUrl, vocalsUrl);
        return markJob(job, {
          status: "ready",
          phase: "done",
          detail: bgTr("vocalsReady"),
          vocalsUrl,
          error: "",
          providerState: {
            ...providerState,
            stemsPollCount
          },
          nextPollAt: 0
        });
      }
      if (stemsPollCount >= 300) {
        const errorMessage = bgTr("timedOutWaitingStems");
        return markJob(job, {
          status: "error",
          phase: "done",
          detail: errorMessage,
          error: errorMessage,
          nextPollAt: 0
        });
      }
      return markJob(job, {
        detail: bgTr("separatingVocalsPoll", { n: stemsPollCount }),
        providerState: {
          ...providerState,
          stemsPollCount
        },
        nextPollAt: nowTs() + this.getPollInterval()
      });
    }

    return job;
  },
};

// SoundBoost API helpers
async function importYouTube(youtubeUrl, signal) {
  const response = await fetch(IMPORT_URL, {
    method: "POST", headers: buildHeaders("", "import"),
    body: JSON.stringify({ url: youtubeUrl, flow: "studio", public: true, async_import: true }),
    signal,
  });
  if (!response.ok) throw new Error(`Import failed: ${response.status}`);
  return response.json();
}

async function getImportStatus(originalId, guestToken, signal) {
  const response = await fetch(STATUS_URL_T(originalId), { headers: buildHeaders(guestToken), signal });
  if (response.status === 404 || response.status === 202) {
    // Resource not yet created or still being set up â€” treat as "processing"
    return { import_status: "processing" };
  }
  if (!response.ok) throw new Error(`Status check failed: ${response.status}`);
  return response.json();
}

async function startSplitting(originalId, guestToken, signal) {
  const response = await fetch(START_URL_T(originalId), {
    method: "POST", headers: buildHeaders(guestToken), body: "{}", signal,
  });
  const text = await response.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(text); } catch (e) {}
  return { accepted: response.ok, ...data };
}

async function _getVocalsUrl(originalId, guestToken, signal) {
  const response = await fetch(STEMS_URL_T(originalId), { headers: buildHeaders(guestToken), signal });
  if (PENDING_STEMS_HTTP_STATUSES.has(response.status)) return "";
  if (!response.ok) throw new Error(`Stems request failed: ${response.status}`);
  const data = await response.json();
  const allUrls = findAllUrls(data);
  for (const entry of allUrls) {
    const stemName = entry.key || extractStemNameFromUrl(entry.url);
    if (stemName === "vocals") return entry.url;
  }
  for (const entry of allUrls) {
    if (extractStemNameFromUrl(entry.url) === "vocals") return entry.url;
  }
  return "";
}



// â”€â”€â”€ Remove Music (InverseAI VMS) Provider â”€â”€â”€

const RemoveMusicProvider = {
  getPollInterval() { return REMOVE_MUSIC_POLL_INTERVAL_MS; },

  async prepareChunk(chunk, job, signal) {
    const audioData = audioBlobs.get(job.id);
    if (!audioData) throw new Error("Audio blob not found. Please restart.");

    let chunkBlob = await sliceAudioBlob(audioData.blob, chunk.startSec, chunk.endSec, audioData.durationSec);
    // Strip ID3 metadata to prevent the API from fingerprinting the song
    chunkBlob = await stripId3Tags(chunkBlob);
    const sessionPart = (job.providerSessionUuid || "unknown").slice(0, 8);
    const mimeType = audioData.mimeType || "audio/mpeg";
    const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("webm") ? "webm" : "mp3";
    // Use random filename per upload to avoid pattern-based tracking
    const rnd = Math.random().toString(36).substring(2, 10);
    const fileName = `audio_${rnd}.${ext}`;

    // Step 1: Get server time
    const serverTime = await removeMusicGetServerTime(signal);

    // Step 2: Upload chunk
    const uploadResult = await removeMusicUpload({
      audioBlob: chunkBlob,
      fileName,
      mimeType,
      fileSize: chunkBlob.size,
      serverTime,
      signal,
    });

    const separatorId = uploadResult.separatorId;
    if (!separatorId) throw new Error("Remove Music: no separator job ID in upload response");

    return {
      ...chunk,
      status: "processing",
      detail: `Separating chunk ${chunk.index + 1}...`,
      providerJobId: String(separatorId),
      _rmPollCount: 0,
      _rmAccessToken: uploadResult.accessToken || "",
      error: "",
    };
  },

  async pollChunk(chunk, job, signal) {
    if (!chunk.providerJobId) return { ...chunk, status: "error", error: "No provider job ID" };

    const pollCount = (chunk._rmPollCount || 0) + 1;
    if (pollCount > REMOVE_MUSIC_MAX_POLLS) {
      return { ...chunk, status: "error", error: "Remove Music processing timed out" };
    }

    // First poll: give the API a moment to register the job
    if (pollCount <= 1) {
      return {
        ...chunk,
        detail: `Waiting for processing to start...`,
        _rmPollCount: pollCount,
      };
    }

    const data = await removeMusicGetStatus(chunk.providerJobId, signal, chunk._rmAccessToken);
    const conversionStatus = data.conversion_status;
    const progress = data.progress_percentage || 0;

    // conversion_status: 1=queued, 2=processing, 3=done
    if (conversionStatus === 3) {
      const vocalsUrl = data.output_vocal_audio || "";
      if (!vocalsUrl) {
        return { ...chunk, status: "error", error: "Remove Music: separation done but no vocals URL" };
      }
      return {
        ...chunk,
        status: "ready",
        detail: "Done",
        vocalsUrl,
        _rmPollCount: pollCount,
      };
    }

    if (conversionStatus >= 4) {
      return { ...chunk, status: "error", error: `Remove Music separation failed (status: ${conversionStatus})` };
    }

    return {
      ...chunk,
      detail: `Separating... ${progress}%`,
      _rmPollCount: pollCount,
    };
  },
};

// â”€â”€â”€ Remove Music API helpers â”€â”€â”€

let _rmPlatformIdx = Math.floor(Math.random() * REMOVE_MUSIC_PLATFORMS.length);
function getRandomPlatform() {
  // Round-robin with jitter so each chunk uses a different platform
  _rmPlatformIdx = (_rmPlatformIdx + 1) % REMOVE_MUSIC_PLATFORMS.length;
  return REMOVE_MUSIC_PLATFORMS[_rmPlatformIdx];
}

async function removeMusicGetServerTime(signal) {
  const spoofIp = await getSpoofIp();
  const response = await fetch(REMOVE_MUSIC_SERVER_TIME_URL, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Origin": REMOVE_MUSIC_ORIGIN,
      "Referer": REMOVE_MUSIC_REFERER,
      "X-Forwarded-For": spoofIp,
      "X-Real-IP": spoofIp,
    },
    signal,
    credentials: "omit",
  });
  if (!response.ok) {
    // Fallback to local time if server-time endpoint fails
    console.warn("[IslamicToolkit] server-time failed, using local time");
    return new Date().toISOString();
  }
  const data = await response.json();
  return data.server_time || new Date().toISOString();
}

const REMOVE_MUSIC_MAX_UPLOAD_RETRIES = 4;
const REMOVE_MUSIC_RETRY_BASE_DELAY_MS = 1500;

async function removeMusicUpload(options) {
  const { audioBlob, fileName, mimeType, fileSize, serverTime, signal } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= REMOVE_MUSIC_MAX_UPLOAD_RETRIES; attempt++) {
    // Rotate identity on every attempt (fresh IP + platform per chunk/retry)
    await rotateSpoofIp();
    // Small random delay before upload to break timing patterns (skip first attempt)
    if (attempt > 0) {
      const jitter = REMOVE_MUSIC_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 2000);
      await sleep(jitter);
    }

    const spoofIp = await getSpoofIp();
    const platform = getRandomPlatform();

    // Rebuild FormData each attempt (consumed by fetch)
    const formData = new FormData();
    formData.append("input_audio", audioBlob, "input.mp3");
    formData.append("platform", platform);
    formData.append("original_file_format", mimeType || "audio/mpeg");
    formData.append("original_file_size", String(fileSize));
    formData.append("original_file_name", fileName);
    formData.append("upload_started_at", serverTime);
    formData.append("pre_processing_time", String(Math.floor(Math.random() * 4) + 1));

    const response = await fetch(REMOVE_MUSIC_UPLOAD_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Origin": REMOVE_MUSIC_ORIGIN,
        "Referer": REMOVE_MUSIC_REFERER,
        "X-Forwarded-For": spoofIp,
        "X-Real-IP": spoofIp,
      },
      body: formData,
      signal,
      credentials: "omit",
    });

    if (response.ok) {
      const data = await response.json();
      const separatorInfos = data.vocal_music_separator_infos || [];
      const separatorId = separatorInfos.length > 0 ? separatorInfos[0].id : null;
      const accessToken = data.access_token || "";
      return { uploadId: data.id, separatorId, accessToken };
    }

    const text = await response.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    const message = data?.message || text;

    // If demo limit hit, rotate identity and retry
    if (response.status === 400 && /Demo Limit/i.test(message)) {
      console.warn(`[IslamicToolkit] Demo limit hit on attempt ${attempt + 1}, rotating identity and retrying...`);
      lastError = new Error(`Demo Limit Exceeded (attempt ${attempt + 1})`);
      continue;
    }

    // Non-demo-limit error: throw immediately
    throw new Error(`Remove Music upload failed: ${response.status} - ${text}`);
  }

  // All retries exhausted
  throw lastError || new Error("Remove Music upload failed after all retries (Demo Limit).");
}

async function removeMusicGetStatus(separatorId, signal, accessToken) {
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Origin": REMOVE_MUSIC_ORIGIN,
    "Referer": REMOVE_MUSIC_REFERER,
  };
  if (accessToken) headers["Access-Token"] = accessToken;
  const spoofIp = await getSpoofIp();
  headers["X-Forwarded-For"] = spoofIp;
  headers["X-Real-IP"] = spoofIp;
  const response = await fetch(REMOVE_MUSIC_STATUS_URL_T(separatorId), {
    headers,
    signal,
    credentials: "omit",
  });
  // 404 means the job hasn't fully propagated yet â€” treat as "queued"
  if (response.status === 404) {
    return { conversion_status: 1, progress_percentage: 0 };
  }
  if (!response.ok) throw new Error(`Remove Music status check failed: ${response.status}`);
  return response.json();
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROVIDER REGISTRY
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const DIRECT_LINK_PROVIDERS = {
  soundboost: SoundBoostProvider,
};

const UPLOAD_AUDIO_PROVIDERS = {
  removeMusic: RemoveMusicProvider,
};

function getDirectLinkProvider(name) {
  const providerId = normalizeProvider(name);
  const fallbackProvider = DIRECT_LINK_PROVIDERS[Object.keys(DIRECT_LINK_PROVIDERS)[0]];
  return DIRECT_LINK_PROVIDERS[providerId] || fallbackProvider;
}

function getUploadAudioProvider(name) {
  const providerId = normalizeProvider(name);
  const fallbackProvider = UPLOAD_AUDIO_PROVIDERS[Object.keys(UPLOAD_AUDIO_PROVIDERS)[0]];
  return UPLOAD_AUDIO_PROVIDERS[providerId] || fallbackProvider;
}

async function advanceDirectLinkJob(job, signal) {
  const provider = getDirectLinkProvider(job.provider);

  if (job.phase === "direct_link_start") {
    return provider.start(job, signal);
  }

  if (job.phase === "direct_link_processing") {
    return provider.poll(job, signal);
  }

  return job;
}

async function advanceUploadAudioJob(job, signal) {
  const provider = getUploadAudioProvider(job.provider);

  if (job.phase === "download_audio") {
    await rotateSpoofIp();
    sendStatus(job.tabId, "processing", bgTr("extractingAudio"));
    const audioResult = await downloadYouTubeAudio(
      job.youtubeUrl,
      job.tabId,
      signal,
      (msg) => sendStatus(job.tabId, "processing", msg)
    );

    audioBlobs.set(job.id, {
      blob: audioResult.blob,
      durationSec: audioResult.durationSec,
      mimeType: audioResult.mimeType,
    });

    const chunks = buildChunks(audioResult.durationSec, job.chunkDurationSec);
    if (!chunks.length) throw new Error(bgTr("noAudioChunksCreated"));

    sendStatus(
      job.tabId,
      "processing",
      bgTr("audioDownloadedProcessing", {
        durationSec: audioResult.durationSec,
        sizeMb: (audioResult.blob.size / 1024 / 1024).toFixed(1),
        chunks: chunks.length
      })
    );

    return markJob(job, {
      phase: "chunked_processing",
      detail: bgTr("preparingChunks", { total: chunks.length }),
      providerSessionUuid: job.providerSessionUuid || createUuid(),
      totalDurationSec: audioResult.durationSec,
      fullAudioDurationSec: audioResult.durationSec,
      totalChunks: chunks.length,
      readyChunkCount: 0,
      audioMimeType: audioResult.mimeType,
      chunks,
      nextPollAt: nowTs(),
    });
  }

  if (job.phase === "chunked_processing") {
    const chunks = Array.isArray(job.chunks) ? job.chunks.map(c => ({ ...c })) : [];
    if (!chunks.length) throw new Error(bgTr("missingChunkList"));

    const failedChunk = chunks.find(c => c.status === "error");
    if (failedChunk) throw new Error(failedChunk.error || bgTr("chunkFailed", { n: failedChunk.index + 1 }));

    const hasActiveChunks = chunks.some(c => c.status === "processing" || c.status === "ready");
    if (!hasActiveChunks) {
      const priorityChunk = getPrioritizedChunks(
        chunks,
        job.playbackStartSec,
        c => c.status === "pending"
      )[0];

      if (priorityChunk) {
        const startedChunk = await provider.prepareChunk(priorityChunk, job, signal);
        chunks[startedChunk.index] = startedChunk;
      }
    }

    const readyCountBeforePoll = getReadyChunkCount(chunks);
    const chunksToPoll = getPrioritizedChunks(
      chunks,
      job.playbackStartSec,
      c => c.status === "processing" && c.providerJobId
    ).slice(0, PIPELINE_POLL_CONCURRENCY);

    if (chunksToPoll.length) {
      const polled = await Promise.all(
        chunksToPoll.map(c => provider.pollChunk(c, job, signal))
      );
      for (const polledChunk of polled) chunks[polledChunk.index] = polledChunk;
    }

    const readyCountAfterPoll = getReadyChunkCount(chunks);
    const unlockedPlaybackThisCycle = readyCountAfterPoll > readyCountBeforePoll;

    if (!unlockedPlaybackThisCycle) {
      const activeCount = chunks.filter(c => c.status === "processing").length;
      const pendingSlots = Math.max(0, PIPELINE_UPLOAD_CONCURRENCY - activeCount);
      const pendingChunks = getPrioritizedChunks(
        chunks,
        job.playbackStartSec,
        c => c.status === "pending"
      ).slice(0, pendingSlots);

      if (pendingChunks.length) {
        const startedChunks = await Promise.all(
          pendingChunks.map(c => provider.prepareChunk(c, job, signal))
        );
        for (const startedChunk of startedChunks) chunks[startedChunk.index] = startedChunk;
      }
    }

    const readyCount = getReadyChunkCount(chunks);
    const totalChunks = chunks.length;
    const allDone = readyCount >= totalChunks;

    if (allDone) audioBlobs.delete(job.id);

    return markJob(job, {
      status: allDone ? "ready" : "processing",
      phase: allDone ? "done" : "chunked_processing",
      detail: getChunkDetail(chunks),
      chunks,
      totalChunks,
      readyChunkCount: readyCount,
      nextPollAt: allDone ? 0 : nowTs() + provider.getPollInterval(),
    });
  }

  return job;
}

async function advanceJob(jobId) {
  if (jobLocks.has(jobId)) return getJob(jobId);
  jobLocks.add(jobId);

  try {
    let job = await getJob(jobId);
    if (!job || isTerminalJob(job)) return job;
    if (job.nextPollAt && nowTs() + JOB_CLOCK_SKEW_MS < job.nextPollAt) return job;

    const signal = beginJobFetch(jobId);

    try {
      const pipelineType = job.pipelineType || getProviderPipelineType(job.provider);
      job = pipelineType === "direct_link"
        ? await advanceDirectLinkJob(job, signal)
        : await advanceUploadAudioJob(job, signal);
    } finally {
      finishJobFetch(jobId);
    }

    await saveJob(job);
    sendStatus(job.tabId, getStatusMessageType(job), job.detail);
    return job;

  } catch (error) {
    if (error && error.name === "AbortError") {
      const job = await getJob(jobId);
      if (!job) return null;
      const cancelled = markJob(job, {
        status: "cancelled", phase: "done", detail: "Cancelled", error: "", nextPollAt: 0,
      });
      await saveJob(cancelled);
      audioBlobs.delete(jobId);
      return cancelled;
    }

    const job = await getJob(jobId);
    if (!job) return null;
    console.error("[IslamicToolkit]", error);
    return failJob(job, error.message || "Unexpected processing error");

  } finally {
    finishJobFetch(jobId);
    jobLocks.delete(jobId);
  }
}
async function failJob(job, errorMessage) {
  const failed = markJob(job, {
    status: "error", phase: "done",
    detail: errorMessage || "Processing failed",
    error: errorMessage || "Processing failed",
    nextPollAt: 0,
  });
  await saveJob(failed);
  sendStatus(failed.tabId, "error", failed.detail);
  audioBlobs.delete(job.id);
  return failed;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STATE & MESSAGE LISTENER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function getStateResponse(result) {
  return {
    enabled: result.enabled !== false,
    autoStart: result.autoStart === true,
    lang: normalizeLang(result.lang),
    provider: normalizeProvider(result.provider),
    chunkDurationSec: normalizeChunkDurationSec(result.chunkDurationSec),
    playImmediately: result.playImmediately === true,
    playbackPromptEnabled: result.playbackPromptEnabled !== false,
  };
}

function broadcastToYouTubeTabs(message) {
  chrome.tabs.query({ url: ["*://www.youtube.com/*", "*://m.youtube.com/*"] }, (tabs) => {
    for (const tab of tabs || []) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_PROCESS_YOUTUBE") {
    (async () => {
      try {
        const langState = await new Promise((resolve) => chrome.storage.local.get(["lang"], resolve));
        currentLang = normalizeLang(langState?.lang || msg.lang || currentLang);
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ error: bgTr("noTabId") }); return; }
        const youtubeUrl = msg.url;
        if (!youtubeUrl) { sendResponse({ error: bgTr("noYouTubeUrl") }); return; }

        const provider = normalizeProvider(msg.provider);
        const chunkDurationSec = normalizeChunkDurationSec(msg.chunkDurationSec);
        const playbackStartSec = normalizePlaybackStartSec(msg.playbackStartSec);
        const pipelineType = getProviderPipelineType(provider);

        if (msg.forceFresh === true) {
          await deleteCachedVocalsUrl(youtubeUrl);
          await cancelJobsForUrl(youtubeUrl, "Refreshing...");
          // Also delete completed jobs so they aren't reused
          const allJobs = await getAllJobs();
          for (const j of Object.values(allJobs)) {
            if (j.youtubeUrl === youtubeUrl && j.status === "ready") {
              delete allJobs[j.id];
            }
          }
          await setAllJobs(allJobs);
        } else if (pipelineType === "direct_link") {
          const cachedUrl = await getCachedVocalsUrl(youtubeUrl);
          if (cachedUrl) {
            sendStatus(tabId, "ready", bgTr("usingCache"));
            sendResponse({
              jobId: "", status: "ready", phase: "done", detail: bgTr("usingCache"),
              vocalsUrl: cachedUrl, error: "", fromCache: true,
              nextPollAt: 0, nextPollInMs: 0, provider, chunkDurationSec,
              totalDurationSec: 0, totalChunks: 0, readyChunkCount: 0, chunks: [],
            });
            return;
          }
        }

        // Check for a previously completed job for either supported provider
        if (!msg.forceFresh) {
          const completedJob = await findCompletedJob(youtubeUrl, provider, chunkDurationSec);
          if (completedJob) {
            // Update tabId in case tab changed
            if (completedJob.tabId !== tabId) {
              const updated = markJob(completedJob, { tabId });
              await saveJob(updated);
            }
            sendStatus(tabId, "ready", bgTr("usingCache"));
            sendResponse(toJobResponse(completedJob));
            return;
          }
        }

        let job = await findReusableJob(youtubeUrl, provider, chunkDurationSec);
        if (!job) {
          job = createJob(youtubeUrl, tabId, { provider, chunkDurationSec, playbackStartSec });
          await saveJob(job);
        } else {
          job = markJob(job, { tabId, provider, chunkDurationSec, playbackStartSec });
          await saveJob(job);
        }

        job = await advanceJob(job.id);
        sendResponse(toJobResponse(job));
      } catch (error) {
        sendResponse({ error: localizeRuntimeText(error.message || bgTr("failedToStart")) });
      }
    })();
    return true;
  }

  if (msg.type === "POLL_PROCESS_YOUTUBE") {
    (async () => {
      try {
        const langState = await new Promise((resolve) => chrome.storage.local.get(["lang"], resolve));
        currentLang = normalizeLang(langState?.lang || currentLang);
        const jobId = msg.jobId;
        if (!jobId) { sendResponse({ error: bgTr("noJobId") }); return; }
        let job = await getJob(jobId);
        if (!job) { sendResponse({ error: bgTr("jobNotFound") }); return; }
        const playbackStartSec = normalizePlaybackStartSec(msg.playbackStartSec);

        const tabId = sender.tab?.id;
        if (tabId && job.tabId !== tabId) {
          job = markJob(job, { tabId, playbackStartSec });
          await saveJob(job);
        } else if (getProviderPipelineType(job.provider) === "upload_audio" && Math.abs((job.playbackStartSec || 0) - playbackStartSec) > 0.25) {
          job = markJob(job, { playbackStartSec });
          await saveJob(job);
        }

        if (!isTerminalJob(job)) {
          job = await advanceJob(job.id);
        }
        sendResponse(toJobResponse(job));
      } catch (error) {
        sendResponse({ error: localizeRuntimeText(error.message || bgTr("failedToPoll")) });
      }
    })();
    return true;
  }

  if (msg.type === "CANCEL_PROCESSING") {
    (async () => {
      try {
        if (msg.jobId) {
          await cancelJobById(msg.jobId);
        } else if (sender.tab?.id) {
          const jobs = await getAllJobs();
          const tabJobs = Object.values(jobs).filter(j => j.tabId === sender.tab.id && !isTerminalJob(j));
          await Promise.all(tabJobs.map(j => cancelJobById(j.id)));
        }
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ error: localizeRuntimeText(error.message) });
      }
    })();
    return true;
  }

  if (msg.type === "INVALIDATE_VOCALS_CACHE") {
    (async () => {
      try {
        if (msg.url) {
          await deleteCachedVocalsUrl(msg.url);
          await cancelJobsForUrl(msg.url, "Refreshing...");
        }
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ error: localizeRuntimeText(error.message) });
      }
    })();
    return true;
  }

  if (msg.type === "FETCH_AUDIO_PROXY") {
    (async () => {
      try {
        const headers = {};
        if (msg.range) headers.Range = msg.range;
        const response = await fetch(msg.audioUrl, { headers });
        const contentType = response.headers.get("content-type") || "audio/mpeg";
        const contentRange = response.headers.get("content-range") || "";
        const contentLength = response.headers.get("content-length") || "";
        const acceptRanges = response.headers.get("accept-ranges") || "";
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const chunkSize = 32768;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        sendResponse({ base64: btoa(binary), contentType, contentRange, contentLength, acceptRanges, status: response.status });
      } catch (error) {
        sendResponse({ error: localizeRuntimeText(error.message) });
      }
    })();
    return true;
  }

  if (msg.type === "GET_STATE" || msg.type === "GET_SETTINGS") {
    chrome.storage.local.get(["enabled", "autoStart", "lang", "provider", "chunkDurationSec", "playImmediately", "playbackPromptEnabled"], (result) => {
      sendResponse(getStateResponse(result));
    });
    return true;
  }

  if (msg.type === "SET_STATE") {
    chrome.storage.local.set({ enabled: msg.enabled }, () => {
      broadcastToYouTubeTabs({ type: "STATE_CHANGED", enabled: msg.enabled !== false });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SET_AUTO_START") {
    chrome.storage.local.set({ autoStart: msg.autoStart }, () => {
      broadcastToYouTubeTabs({ type: "AUTO_START_CHANGED", autoStart: msg.autoStart });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SET_LANG") {
    const lang = normalizeLang(msg.lang);
    currentLang = lang;
    chrome.storage.local.set({ lang }, () => {
      broadcastToYouTubeTabs({ type: "LANG_CHANGED", lang });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SET_PROCESSING_SETTINGS") {
    const provider = normalizeProvider(msg.provider);
    const chunkDurationSec = normalizeChunkDurationSec(msg.chunkDurationSec);
    chrome.storage.local.set({ provider, chunkDurationSec }, () => {
      broadcastToYouTubeTabs({ type: "PROCESSING_SETTINGS_CHANGED", provider, chunkDurationSec });
      sendResponse({ ok: true, provider, chunkDurationSec });
    });
    return true;
  }

  if (msg.type === "SET_PLAY_IMMEDIATELY") {
    const playImmediately = msg.playImmediately === true;
    chrome.storage.local.set({ playImmediately }, () => {
      broadcastToYouTubeTabs({ type: "PLAY_IMMEDIATELY_CHANGED", playImmediately });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SET_PLAYBACK_PROMPT_ENABLED") {
    const playbackPromptEnabled = msg.playbackPromptEnabled !== false;
    chrome.storage.local.set({ playbackPromptEnabled }, () => {
      broadcastToYouTubeTabs({ type: "PLAYBACK_PROMPT_CHANGED", playbackPromptEnabled });
      sendResponse({ ok: true });
    });
    return true;
  }

});

