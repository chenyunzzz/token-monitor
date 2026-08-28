'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultDeviceId, loadDotEnv, parseArgs, pidFilePath } = require('../shared/config');
const { appVersion } = require('../shared/appVersion');
const { DEFAULT_CLIENTS, clientsCsvForSetting } = require('../shared/clientTracking');
const { clientDataDirPresence, normalizeHistoryIntervalMs } = require('../shared/collector');
const {
  normalizeLimitsRefreshMode,
  normalizeLimitsRefreshMs,
  parseBoolean,
  parseLimitProviders
} = require('../shared/limitCollector');
const { postSyncPayload } = require('../shared/syncPayload');
const { applyProjectRollups, normalizeProviderHints } = require('../shared/usage');
const { runAgent, runAgentOnce } = require('./runtime');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  writeSessionUsageArchive
} = require('../shared/sessionUsageArchive');

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const hubUrl = String(args.hub || args.hubUrl || process.env.TOKEN_MONITOR_HUB_URL || 'http://127.0.0.1:17321').replace(/\/$/, '');
const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
const deviceId = String(args.device || args.deviceId || process.env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId());
// Headless agents commonly run beside several active CLI tools. Keep their
// default refresh cost bounded while retaining near-live updates; users who
// explicitly need the old cadence can opt into performance mode.
const resourceMode = String(
  args.resourceMode
    ?? args['resource-mode']
    ?? process.env.TOKEN_MONITOR_RESOURCE_MODE
    ?? 'low'
).trim().toLowerCase() === 'performance' ? 'performance' : 'low';
const lowResourceMode = resourceMode === 'low';
const intervalMs = Number(
  args.interval
    ?? args.intervalMs
    ?? process.env.TOKEN_MONITOR_INTERVAL_MS
    ?? (lowResourceMode ? 15 * 60 * 1000 : 5 * 60 * 1000)
);
// Recursive file watching is the largest resident cost on a headless WSL
// machine: chokidar must retain one native watch/cache entry per directory in
// every session tree. Low mode therefore uses the bounded interval loop as its
// source of truth. An explicit TOKEN_MONITOR_WATCH=1 still opts back into live
// events for users who accept that resident cost.
const watchSetting = args.watch ?? process.env.TOKEN_MONITOR_WATCH;
const watchEnabled = String(watchSetting ?? (lowResourceMode ? '0' : '1')) !== '0';
const watchDebounceMs = Number(
  args.watchDebounceMs
    ?? process.env.TOKEN_MONITOR_WATCH_DEBOUNCE_MS
    ?? (lowResourceMode ? 3000 : 1500)
);
const watchMinIntervalMs = Number(
  args.watchMinIntervalMs
    ?? process.env.TOKEN_MONITOR_WATCH_MIN_INTERVAL_MS
    ?? (lowResourceMode ? 30 * 1000 : 5000)
);
const explicitClients = args.clients ?? process.env.TOKEN_MONITOR_CLIENTS;
const detectedDefaultClients = Object.entries(clientDataDirPresence(DEFAULT_CLIENTS))
  .filter(([, present]) => present)
  .map(([client]) => client)
  .join(',');
const clients = explicitClients === undefined
  ? clientsCsvForSetting(detectedDefaultClients, '')
  : clientsCsvForSetting(explicitClients);
const allTimeSince = String(args.since || args.allTimeSince || process.env.TOKEN_MONITOR_ALL_TIME_SINCE || '2024-01-01');
const commandTimeoutMs = Number(args.timeoutMs || process.env.TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS || 120 * 1000);
const explicitLimitProviders = args.limitProviders ?? process.env.TOKEN_MONITOR_LIMIT_PROVIDERS;
const limitsEnabled = parseBoolean(
  args.limits ?? args.limitsEnabled ?? process.env.TOKEN_MONITOR_LIMITS_ENABLED,
  explicitLimitProviders !== undefined
);
const limitProviders = parseLimitProviders(explicitLimitProviders).join(',');
const limitsRefreshMs = normalizeLimitsRefreshMs(args.limitsRefreshMs || process.env.TOKEN_MONITOR_LIMITS_REFRESH_MS);
const limitsRefreshMode = normalizeLimitsRefreshMode(args.limitsRefreshMode || process.env.TOKEN_MONITOR_LIMITS_REFRESH_MODE);
const historyEnabled = parseBoolean(args.history ?? args.historyEnabled ?? process.env.TOKEN_MONITOR_HISTORY_ENABLED, false);
const projectsEnabled = parseBoolean(args.projects ?? args.projectsEnabled ?? process.env.TOKEN_MONITOR_PROJECTS_ENABLED, false);
const sessionUsageArchiveEnabled = parseBoolean(args.sessionArchive ?? args.sessionUsageArchiveEnabled ?? process.env.TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED, false);
const sessionDetailsEnabled = parseBoolean(
  args.sessionDetails ?? args.sessionDetailsEnabled ?? process.env.TOKEN_MONITOR_SESSION_DETAILS,
  false
);
const wslScanEnabled = parseBoolean(args.wslScan ?? args.wslScanEnabled ?? process.env.TOKEN_MONITOR_WSL_SCAN, true);
const intervalRequiresActivity = parseBoolean(
  args.intervalRequiresActivity ?? process.env.TOKEN_MONITOR_INTERVAL_REQUIRES_ACTIVITY,
  watchEnabled
);
const opencodeLocalLimitsEnabled = parseBoolean(
  args['opencode-local-limits']
    ?? args.opencodeLocalLimits
    ?? args.opencodeLocalLimitsEnabled
    ?? process.env.TOKEN_MONITOR_OPENCODE_LOCAL_LIMITS,
  false
);
// The key OpenCode stores for itself needs no configuration, so an unattended
// agent reports it by default. Switched off for a machine signed in to an
// account whose quota should not leave it. The widget resolves the same setting
// through settings.json; here it is env or flag, like every other agent option.
const opencodeAmbientEnabled = parseBoolean(
  args['opencode-ambient']
    ?? args.opencodeAmbient
    ?? args.opencodeAmbientEnabled
    ?? process.env.TOKEN_MONITOR_OPENCODE_AMBIENT,
  true
);
const opencodeCookie = String(process.env.TOKEN_MONITOR_OPENCODE_COOKIE || '').trim();
const once = Boolean(args.once);
const dryRun = Boolean(args['dry-run'] || args.dryRun);
const providerHints = normalizeProviderHints(
  args.providerHints
    ?? args['provider-hints']
    ?? process.env.TOKEN_MONITOR_PROVIDER_HINTS
    ?? process.env.TOKEN_MONITOR_PROVIDER_MAP
);

const usageOptions = {
  clients,
  allTimeSince,
  commandTimeoutMs,
  deviceId,
  agentVersion: appVersion(),
  agentRuntime: 'headless-agent',
  projectsEnabled,
  historyEnabled,
  sessionDetailsEnabled,
  historyIntervalMs: normalizeHistoryIntervalMs(process.env.TOKEN_MONITOR_HISTORY_INTERVAL_MS),
  dailyHistoryArchiveEnabled: sessionUsageArchiveEnabled,
  dailyHistoryArchiveWriteEnabled: !dryRun,
  anchorPersistenceEnabled: !once && !dryRun,
  intervalMs,
  intervalRequiresActivity,
  watchEnabled,
  watchDebounceMs,
  watchMinIntervalMs,
  providerHints,
  wslScanEnabled,
  onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`),
  logger: (message) => (dryRun ? console.error(message) : console.log(message))
};
const limitsOptions = {
  limitsEnabled,
  limitProviders,
  limitsRefreshMode,
  limitsRefreshMs,
  claudeWebCookie: '',
  opencodeLocalLimitsEnabled,
  opencodeAmbientEnabled,
  opencodeCookie
};
let sessionUsageArchive;

function summaryWithSessionUsageArchive(summary, now = new Date()) {
  let visibleSummary = summary;
  if (sessionUsageArchiveEnabled) {
    const archiveDate = sessionUsageArchiveDate(summary, now);
    const previous = sessionUsageArchive || readSessionUsageArchive();
    const next = captureSessionUsageArchive(previous, summary, archiveDate);
    if (!dryRun && JSON.stringify(next) !== JSON.stringify(previous)) {
      try {
        writeSessionUsageArchive(next);
        sessionUsageArchive = next;
      } catch (error) {
        console.error(`[session-archive] write failed: ${error.message}`);
      }
    } else if (!dryRun) {
      sessionUsageArchive = next;
    }
    visibleSummary = applySessionUsageArchive(summary, next, { now: archiveDate, activeClients: clients });
  }
  return projectsEnabled ? applyProjectRollups(visibleSummary) : visibleSummary;
}

async function postUsage(summary) {
  const { response } = await postSyncPayload(fetch, `${hubUrl}/api/ingest`, {
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    summary,
    replaceUntrackedClients: true,
    logger: (message) => console.warn(`[sync] ${message}`)
  });
  if (!response.ok) throw new Error(`Hub responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function deliver(summary) {
  if (dryRun) { console.log(JSON.stringify(summary, null, 2)); return; }
  await postUsage(summary);
  console.log(`[${new Date().toISOString()}] posted ${summary.deviceId}: today=${summary.today.totalTokens} month=${summary.month.totalTokens} allTime=${summary.allTime.totalTokens}`);
}

function registerPidFile(stopRuntime) {
  const pidPath = pidFilePath();
  const lockPath = `${pidPath}.lock`;
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existingPid = 0;
    try { existingPid = Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch (_) {}
    let running = false;
    if (Number.isInteger(existingPid) && existingPid > 0) {
      try { process.kill(existingPid, 0); running = true; } catch (probeError) { running = probeError.code === 'EPERM'; }
    }
    if (running) {
      console.error(`Token Monitor agent is already running (pid ${existingPid}).`);
      return false;
    }
    try { fs.unlinkSync(lockPath); } catch (_) { return false; }
    lockFd = fs.openSync(lockPath, 'wx');
  }
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.unlinkSync(pidPath); } catch (_) {}
    try { fs.closeSync(lockFd); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { stopRuntime?.(); } catch (_) {}
      cleanup();
      process.exit(0);
    });
  }
  return true;
}

async function main() {
  const startupMessage = `Token Monitor agent device=${deviceId} hub=${hubUrl} resourceMode=${resourceMode} intervalMs=${intervalMs} watch=${watchEnabled} watchMinIntervalMs=${watchMinIntervalMs} projects=${projectsEnabled ? 'on' : 'off'} history=${historyEnabled ? 'on' : 'off'} sessionDetails=${sessionDetailsEnabled ? 'on' : 'off'} sessionArchive=${sessionUsageArchiveEnabled ? 'on' : 'off'} limits=${limitsEnabled ? `${limitProviders || 'none'}:${limitsRefreshMode === 'adaptive' ? 'adaptive' : `${limitsRefreshMs}ms`}` : 'off'}`;
  if (dryRun) console.error(startupMessage);
  else console.log(startupMessage);
  if (!secret) console.warn('Warning: TOKEN_MONITOR_SECRET is not set. Posting without authorization header.');
  // Claim archive ownership before either a one-shot or long-running scan so
  // Electron can yield before its history read-modify-write reaches disk.
  let runtimeHandle = null;
  if (!dryRun && !registerPidFile(() => runtimeHandle?.stop())) return;
  const runtimeOptions = {
    envelope: { deviceId, agentVersion: appVersion(), agentRuntime: 'headless-agent' },
    usageOptions,
    limitsOptions,
    transformUsage: summaryWithSessionUsageArchive,
    deliver,
    dryRun,
    onRuntime: (runtime) => { runtimeHandle = runtime; },
    onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`)
  };
  if (once) {
    await runAgentOnce(runtimeOptions);
    return;
  }
  runtimeHandle = runAgent(runtimeOptions);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
