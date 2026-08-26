'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { throwIfAborted } = require('./abortSignal');
const { emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
const { REASONIX_CLIENT } = require('./reasonixPaths');
const { buildPromaPeriods, collectPromaRows } = require('./promaUsage');
const { buildDshPeriods, collectDshRows, parseDshUsageText } = require('./dshUsage');
const { collectAntigravityCliModels, enrichAntigravityJson } = require('./antigravityCliUsage');

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

// Relative (Linux-style) paths under a WSL home. If any exists, a tracked client
// stores data there and the home is worth a tokscale scan. These mirror the roots
// tokscale actually reads (incl. alternate roots: Claude transcripts, Kimi
// Code, legacy OpenClaw bot dirs) so a home holding only an alternate-root client
// is still discovered. The `.vscode-server` entries cover Cline / Kilo Code
// running through the VS Code WSL remote.
const WSL_DATA_MARKERS = [
  '.claude/projects',
  '.claude/transcripts',
  '.codex/sessions',
  '.local/share/opencode',
  '.openclaw/agents',
  '.clawdbot/agents',
  '.moltbot/agents',
  '.moldbot/agents',
  '.hermes',
  '.kimi/sessions',
  '.kimi-code/sessions',
  '.qwen/projects',
  '.grok/sessions',
  '.copilot/otel',
  '.gemini/antigravity-cli/conversations',
  '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
  '.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
  '.pi/agent/sessions',
  '.omp/agent/sessions',
  '.local/share/zed/threads/threads.db',
  '.config/Code/User/globalStorage/kilocode.kilo-code/tasks',
  '.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
  '.commandcode/projects',
  '.dsh/sessions',
  '.local/share/mimocode/mimocode.db',
  '.zcode/projects',
  '.zcode/cli/db',
  '.kiro/sessions',
  '.local/share/kiro-cli/data.sqlite3',
  '.config/Kiro/User/globalStorage/kiro.kiroagent',
  '.config/kiro/User/globalStorage/kiro.kiroagent',
  '.codebuddy/projects',
  '.workbuddy',
  '.proma/agent-sessions'
];

// Maps every WSL_DATA_MARKERS entry to the tracked-client id that owns it, so a
// matched marker can be attributed back to a client (alt roots collapse to one
// id, e.g. .kimi/.kimi-code -> kimi; the OpenClaw bot dirs -> openclaw; the two
// Cline globalStorage paths -> cline). Ids must match DEFAULT_CLIENTS.
const MARKER_CLIENTS = {
  '.claude/projects': 'claude',
  '.claude/transcripts': 'claude',
  '.codex/sessions': 'codex',
  '.local/share/opencode': 'opencode',
  '.openclaw/agents': 'openclaw',
  '.clawdbot/agents': 'openclaw',
  '.moltbot/agents': 'openclaw',
  '.moldbot/agents': 'openclaw',
  '.hermes': 'hermes',
  '.kimi/sessions': 'kimi',
  '.kimi-code/sessions': 'kimi',
  '.qwen/projects': 'qwen',
  '.grok/sessions': 'grok',
  '.copilot/otel': 'copilot',
  // Antigravity CLI's own parse-local root, mapped to the umbrella `antigravity`
  // id we track; tokscaleClientFilter widens the scan to the antigravity-cli id.
  '.gemini/antigravity-cli/conversations': 'antigravity',
  '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks': 'cline',
  '.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks': 'cline',
  '.pi/agent/sessions': 'pi',
  '.omp/agent/sessions': 'pi',
  '.local/share/zed/threads/threads.db': 'zed',
  '.config/Code/User/globalStorage/kilocode.kilo-code/tasks': 'kilocode',
  '.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks': 'kilocode',
  '.commandcode/projects': 'commandcode',
  '.dsh/sessions': 'dsh',
  '.local/share/mimocode/mimocode.db': 'micode',
  '.zcode/projects': 'zcode',
  '.zcode/cli/db': 'zcode',
  '.kiro/sessions': 'kiro',
  '.local/share/kiro-cli/data.sqlite3': 'kiro',
  '.config/Kiro/User/globalStorage/kiro.kiroagent': 'kiro',
  '.config/kiro/User/globalStorage/kiro.kiroagent': 'kiro',
  '.codebuddy/projects': 'codebuddy',
  '.workbuddy': 'workbuddy',
  '.proma/agent-sessions': 'proma'
};

// Default command runner. reg output is ANSI/utf8; wsl.exe output is UTF-16LE.
// stdin is NUL ('ignore') so a non-WSL wsl.exe stub cannot block on "press any
// key to install"; a timeout backstops any hang.
function defaultExec(cmd, args) {
  const isWsl = /wsl(\.exe)?$/i.test(cmd);
  const out = execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    encoding: 'buffer'
  });
  return Buffer.from(out).toString(isWsl ? 'utf16le' : 'utf8');
}

// Some Windows processes cannot open the WSL 9P share (`\\wsl$`) even though
// the distro is running. Keep a narrow command bridge for the two compatibility
// adapters that need the raw Linux stores. It returns only paths, model ids,
// and parsed usage rows; prompts and message text are never persisted or logged.
const WSL_BRIDGE_MARKERS = [
  ['/.dsh/sessions', 'dsh'],
  ['/.gemini/antigravity-cli/conversations', 'antigravity']
];

function runWslBridgeCommand(distro, args, deps = {}) {
  const exec = deps.exec || defaultExec;
  return String(exec('wsl.exe', ['--distribution', distro, '--', ...args]));
}

function wslBridgeHomes(deps = {}) {
  const homes = new Map();
  for (const distro of listWslDistros(deps)) {
    let output;
    try {
      output = runWslBridgeCommand(distro, [
        'find', '/home', '/root', '-type', 'd', '(',
        '-path', '*/.dsh/sessions', '-o',
        '-path', '*/.gemini/antigravity-cli/conversations',
        ')', '-print'
      ], deps);
    } catch (_) {
      continue;
    }
    for (const rawPath of output.split(/\0|\r?\n/)) {
      const linuxPath = rawPath.trim();
      if (!linuxPath) continue;
      const marker = WSL_BRIDGE_MARKERS.find(([suffix]) => linuxPath.endsWith(suffix));
      if (!marker) continue;
      const homeDir = linuxPath.slice(0, -marker[0].length) || '/';
      const key = `${distro}\u0000${homeDir}`;
      const existing = homes.get(key) || { distro, homeDir, clients: new Set() };
      existing.clients.add(marker[1]);
      homes.set(key, existing);
    }
  }
  return [...homes.values()];
}

function collectDshRowsFromWsl(home, deps = {}) {
  const root = `${home.homeDir.replace(/\/$/, '')}/.dsh/sessions`;
  const output = runWslBridgeCommand(home.distro, [
    'find', root, '-type', 'f', '(', '-name', 'session.jsonl', '-o', '-name', 'session.jsonl.zstd', ')', '-print0'
  ], deps);
  const rows = [];
  for (const filePath of output.split('\0').map((value) => value.trim()).filter(Boolean)) {
    const command = filePath.endsWith('.zstd')
      ? ['zstd', '-q', '-dc', '--', filePath]
      : ['cat', '--', filePath];
    try {
      rows.push(...parseDshUsageText(runWslBridgeCommand(home.distro, command, deps), filePath));
    } catch (_) {
      // A live session can be replaced or have a torn final frame between
      // find and read. Keep the other sessions and retry on the next tick.
    }
  }
  return rows;
}

const AGY_MODEL_SCRIPT = [
  'import glob,os,re,sqlite3,sys',
  'rx=re.compile(r"(?<![A-Za-z0-9])gemini-[0-9][A-Za-z0-9._-]*",re.I)',
  'enum=re.compile(r"MODEL_GOOGLE_GEMINI_([0-9_]+)_(FLASH|PRO)(?:_([A-Z]+))?",re.I)',
  'for p in glob.glob(os.path.join(sys.argv[1],"*.db")):',
  '  try:',
  '    db=sqlite3.connect("file:"+p+"?mode=ro",uri=True); vals=[]',
  '    for t in ("gen_metadata","executor_metadata","steps"):',
  '      try: rows=db.execute("select data from "+t).fetchall()',
  '      except Exception: rows=[]',
  '      for (v,) in rows:',
  '        s=v.decode("utf-8","ignore") if isinstance(v,bytes) else str(v)',
  '        m=rx.search(s)',
  '        if m: vals.append(m.group(0).lower())',
  '        else:',
  '          m=enum.search(s)',
  '          if m: vals.append("gemini-"+m.group(1).replace("_",".")+"-"+m.group(2).lower()+("-"+m.group(3).lower() if m.group(3) else ""))',
  '    db.close()',
  '    if vals: print(os.path.basename(p)[:-3]+"\\t"+vals[0])',
  '  except Exception: pass'
].join('\n');

function collectAntigravityModelsFromWsl(home, deps = {}) {
  const root = `${home.homeDir.replace(/\/$/, '')}/.gemini/antigravity-cli/conversations`;
  const output = runWslBridgeCommand(home.distro, ['python3', '-c', AGY_MODEL_SCRIPT, root], deps);
  const models = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [sessionId, model] = line.trim().split('\t');
    if (sessionId && model) models.set(sessionId, model);
  }
  return models;
}

function emptyWslBundle() {
  return { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
}

// Install-proof gate: reg.exe is read-only and cannot trigger a WSL install. If
// the Lxss key is absent, reg exits non-zero and execFileSync throws -> false.
function isWslInstalled(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return false;
  const exec = deps.exec || defaultExec;
  try {
    exec('reg', ['query', LXSS_KEY]);
    return true;
  } catch (_) {
    return false;
  }
}

function listRunningWslDistros(deps = {}) {
  if (!isWslInstalled(deps)) return [];
  const exec = deps.exec || defaultExec;
  let out;
  try {
    out = exec('wsl.exe', ['--list', '--quiet', '--running']);
  } catch (_) {
    return [];
  }
  return String(out)
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter(Boolean);
}

// `wsl.exe --list` can return E_ACCESSDENIED when it is launched from a
// background process even though the WSL fileshare is available. The distro
// registration key is read-only and includes the stable display name, so use it
// as a discovery fallback instead of treating that failure as "no WSL".
function distroNamesFromRegistry(text) {
  const names = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*DistributionName\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i);
    const name = match?.[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function distroNamesFromEnvironment(env = process.env) {
  const names = [];
  for (const value of Object.values(env || {})) {
    const match = String(value || '').match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\/i);
    const name = match?.[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function listInstalledWslDistros(deps = {}) {
  if (!isWslInstalled(deps)) return [];
  const exec = deps.exec || defaultExec;
  let registered = [];
  try {
    registered = distroNamesFromRegistry(exec('reg', ['query', LXSS_KEY, '/s']));
  } catch (_) { /* registry fallback is best effort */ }
  for (const name of distroNamesFromEnvironment(deps.env || process.env)) {
    if (!registered.includes(name)) registered.push(name);
  }
  return registered;
}

function listWslDistros(deps = {}) {
  const running = listRunningWslDistros(deps);
  if (running.length > 0) return running;
  return listInstalledWslDistros(deps);
}

// Returns the tracked-client ids whose marker is present in this home (deduped).
// Empty array = no tracked client stores data here.
function wslHomePath(home, relativePath) {
  return `${home}\\${relativePath.replace(/\//g, '\\')}`;
}

function homeHasData(home, existsSync, readdirSync = fs.readdirSync) {
  const ids = new Set();
  for (const rel of WSL_DATA_MARKERS) {
    if (existsSync(wslHomePath(home, rel))) {
      const client = MARKER_CLIENTS[rel];
      if (client) ids.add(client);
    }
  }
  // workspaceStorage is not Copilot-specific, so require the nested source
  // Tokscale 4.5.2 actually parses instead of marking every VS Code WSL home.
  const workspaceRoot = wslHomePath(home, '.config/Code/User/workspaceStorage');
  try {
    for (const workspace of readdirSync(workspaceRoot)) {
      if (existsSync(`${workspaceRoot}\\${workspace}\\chatSessions`)) {
        ids.add('copilot');
        break;
      }
    }
  } catch (_) { /* workspaceStorage missing or unreadable */ }
  return [...ids];
}

function wslUsageHomes(deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const homes = [];
  for (const distro of listWslDistros(deps)) {
    const candidates = [];
    // `\\wsl.localhost` is the current documented UNC form. Keep the legacy
    // `\\wsl$` form first because it is still more compatible with older WSL
    // versions and existing settings such as REASONIX_HOME.
    const homeRoots = [`\\\\wsl$\\${distro}\\home`, `\\\\wsl.localhost\\${distro}\\home`];
    let readableHomeRoot = null;
    for (const homeRoot of homeRoots) {
      try {
        const users = readdirSync(homeRoot);
        readableHomeRoot = homeRoot;
        for (const user of users) candidates.push(`${homeRoot}\\${user}`);
        break;
      } catch (_) { /* try the alternate UNC provider */ }
    }
    const roots = readableHomeRoot
      ? [readableHomeRoot.replace(/\\home$/, '\\root')]
      : [`\\\\wsl$\\${distro}\\root`, `\\\\wsl.localhost\\${distro}\\root`];
    candidates.push(...roots);
    for (const home of candidates) {
      if (homeHasData(home, existsSync, readdirSync).length > 0) homes.push(home);
    }
  }
  return homes;
}

// Cheap WSL readiness probe (no tokscale). Returns 'not-installed' (no Lxss),
// 'not-running' (installed but no running distro), or 'ok'.
function probeWslState(deps = {}) {
  if (!isWslInstalled(deps)) return 'not-installed';
  // Use the same fallback as the scanner. A background Electron process may be
  // denied `wsl.exe --list` while the registered distro's UNC provider is still
  // readable; reporting "not-running" in that case hides the real scan state.
  if (listWslDistros(deps).length === 0) return 'not-running';
  return 'ok';
}

async function collectWslUsage(options = {}, deps = {}) {
  const { clients, trackedClients = clients, allTimeSince, commandTimeoutMs, now, runTokscale, logger, decoratePeriods, providerHints } = options;
  const buildProma = options.buildPromaPeriods || buildPromaPeriods;
  const collectProma = options.collectPromaRows || collectPromaRows;
  const buildDsh = options.buildDshPeriods || buildDshPeriods;
  const collectDsh = options.collectDshRows || collectDshRows;
  const collectAntigravity = options.collectAntigravityCliModels || collectAntigravityCliModels;
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const bundle = emptyWslBundle();
  const detected = new Set();
  let attemptedHomes = 0;
  let successfulHomes = 0;
  let failedHomes = 0;
  let lastError = '';
  throwIfAborted(options.signal, 'WSL usage scan aborted');
  if (!trackedClients) return { bundle, detected: [] };
  // Only attribute markers for clients the user is actually tracking — a marker
  // for an untracked client must not surface in the panel.
  // Reasonix aggregate usage is supported on the host, but remains excluded
  // from WSL scans: Tokscale's Windows PathRoot::ReasonixHome conflicts with
  // the Linux-default `.reasonix/stats` path inside WSL. Native session files
  // are local-only as well.
  const tracked = new Set(String(trackedClients).split(',').map((c) => c.trim()).filter(Boolean));
  const clientsCsv = String(clients || '').split(',').map((c) => c.trim()).filter(Boolean)
    // Both clients have local compatibility adapters below; passing either to
    // Tokscale makes the whole scoped WSL scan fail on releases that do not
    // expose that client id (notably dsh on Tokscale 4.13).
    .filter((client) => client !== REASONIX_CLIENT && client !== 'dsh')
    .join(',');
  const localHomes = wslUsageHomes(deps);
  const localHomeData = new Map(localHomes.map((home) => [home, homeHasData(home, existsSync, readdirSync)]));
  const hasLocalDsh = [...localHomeData.values()].some((clientsInHome) => clientsInHome.includes('dsh'));
  const hasLocalAntigravity = [...localHomeData.values()].some((clientsInHome) => clientsInHome.includes('antigravity'));
  const bridgeHomes = (
    (tracked.has('dsh') && !hasLocalDsh) || (tracked.has('antigravity') && !hasLocalAntigravity)
  ) ? wslBridgeHomes(deps) : [];
  let bridgeAntigravityModels = null;
  // If the Windows process cannot read the WSL 9P share, use wsl.exe for the
  // raw adapters. This path is intentionally a fallback: when UNC is readable,
  // Tokscale remains the authoritative reader for all of its supported clients.
  for (const remoteHome of bridgeHomes) {
    const remoteClients = remoteHome.clients;
    let remoteSucceeded = false;
    attemptedHomes += 1;
    if (tracked.has('dsh') && remoteClients.has('dsh')) {
      detected.add('dsh');
      try {
        const dsh = buildDsh({
          rows: collectDshRowsFromWsl(remoteHome, deps),
          now,
          allTimeSince
        });
        bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(dsh.today, { providerHints }));
        bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(dsh.month, { providerHints }));
        bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(dsh.allTime, { providerHints }));
        remoteSucceeded = true;
      } catch (error) {
        if (typeof logger === 'function') logger(`wsl dsh bridge failed for ${remoteHome.distro}:${remoteHome.homeDir}: ${error.message}`);
      }
    }
    if (tracked.has('antigravity') && remoteClients.has('antigravity')) {
      detected.add('antigravity');
      try {
        const models = collectAntigravityModelsFromWsl(remoteHome, deps);
        if (models.size > 0) {
          bridgeAntigravityModels = bridgeAntigravityModels || new Map();
          for (const [sessionId, model] of models) bridgeAntigravityModels.set(sessionId, model);
        }
        remoteSucceeded = true;
      } catch (error) {
        if (typeof logger === 'function') logger(`wsl antigravity bridge failed for ${remoteHome.distro}:${remoteHome.homeDir}: ${error.message}`);
      }
    }
    if (remoteSucceeded) successfulHomes += 1;
    else failedHomes += 1;
  }
  for (const home of localHomes) {
    throwIfAborted(options.signal, 'WSL usage scan aborted');
    attemptedHomes += 1;
    let homeSucceeded = false;
    let homeFailed = false;
    let antigravityModels = bridgeAntigravityModels;
    // Attribution is marker-based, independent of whether a parser returns data.
    const homeDataClients = localHomeData.get(home) || homeHasData(home, existsSync, readdirSync);
    for (const id of homeDataClients) {
      if (tracked.has(id)) detected.add(id);
    }
    // Proma is locally parsed rather than tokscale-backed. Scan its WSL JSONL
    // root directly so a Proma-only home contributes actual usage, not merely
    // marker detection. The root is isolated per home to avoid double-counting
    // another distro or the host's local Proma sessions.
    if (tracked.has('proma') && homeDataClients.includes('proma')) {
      try {
        const promaOptions = {
          now,
          allTimeSince,
          roots: [wslHomePath(home, '.proma/agent-sessions')]
        };
        if (typeof options.resolvePromaPricing === 'function') {
          const rows = collectProma(promaOptions);
          promaOptions.rows = rows;
          promaOptions.pricingByModel = await options.resolvePromaPricing(rows);
        } else if (options.promaPricingByModel) {
          promaOptions.pricingByModel = options.promaPricingByModel;
        }
        const proma = buildProma(promaOptions);
        bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(proma.today, { providerHints }));
        bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(proma.month, { providerHints }));
        bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(proma.allTime, { providerHints }));
        homeSucceeded = true;
      } catch (error) {
        homeFailed = true;
        if (typeof logger === 'function') logger(`wsl Proma usage parse failed for ${home}: ${error.message}`);
      }
    }
    // dsh usage is parsed directly because Tokscale 4.13.0 does not expose a
    // `--client dsh` target. The root is isolated to this WSL home so a host
    // dsh directory or another distro cannot be counted twice.
    if (tracked.has('dsh') && homeDataClients.includes('dsh')) {
      try {
        const dsh = buildDsh({
          rows: collectDsh({ roots: [wslHomePath(home, '.dsh/sessions')] }),
          now,
          allTimeSince
        });
        bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(dsh.today, { providerHints }));
        bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(dsh.month, { providerHints }));
        bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(dsh.allTime, { providerHints }));
        homeSucceeded = true;
      } catch (error) {
        homeFailed = true;
        if (typeof logger === 'function') logger(`wsl dsh usage parse failed for ${home}: ${error.message}`);
      }
    }
    if (tracked.has('antigravity') && homeDataClients.includes('antigravity')) {
      try {
        antigravityModels = collectAntigravity({
          roots: [wslHomePath(home, '.gemini/antigravity-cli/conversations')]
        });
      } catch (error) {
        if (typeof logger === 'function') logger(`wsl antigravity model enrichment failed for ${home}: ${error.message}`);
      }
    }
    // Tokscale 4.6+ keeps explicit --home scans isolated from host-native roots,
    // so every requested client can be passed through for each discovered home.
    // Keep the empty guard because an empty --client expands to all clients.
    if (clientsCsv.length > 0 && typeof runTokscale === 'function') try {
      // Serial on purpose (issue #15): never run these concurrently.
      const todayJson = await runTokscale({ clients: clientsCsv, flags: ['--today', '--home', home], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      const monthJson = await runTokscale({ clients: clientsCsv, flags: ['--month', '--home', home], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      const allTimeJson = await runTokscale({ clients: clientsCsv, flags: ['--since', allTimeSince, '--home', home], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      const periods = {
        today: extractUsageFromTokscale(enrichAntigravityJson(todayJson, antigravityModels), { providerHints }),
        month: extractUsageFromTokscale(enrichAntigravityJson(monthJson, antigravityModels), { providerHints }),
        allTime: extractUsageFromTokscale(enrichAntigravityJson(allTimeJson, antigravityModels), { providerHints })
      };
      if (typeof decoratePeriods === 'function') decoratePeriods(periods, home);
      bundle.today = mergePeriods(bundle.today, periods.today);
      bundle.month = mergePeriods(bundle.month, periods.month);
      bundle.allTime = mergePeriods(bundle.allTime, periods.allTime);
      homeSucceeded = true;
    } catch (error) {
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      homeFailed = true;
      lastError = String(error?.message || error || 'unknown WSL scan error').slice(0, 300);
      if (typeof logger === 'function') logger(`wsl usage scan failed for ${home}: ${error.message}`);
    }
    if (homeSucceeded) successfulHomes += 1;
    else if (homeFailed) failedHomes += 1;
  }
  return {
    bundle,
    detected: [...detected],
    attemptedHomes,
    successfulHomes,
    failedHomes,
    ...(lastError ? { lastError } : {})
  };
}

module.exports = {
  WSL_DATA_MARKERS,
  MARKER_CLIENTS,
  collectWslUsage,
  emptyWslBundle,
  homeHasData,
  isWslInstalled,
  distroNamesFromEnvironment,
  distroNamesFromRegistry,
  listInstalledWslDistros,
  listRunningWslDistros,
  listWslDistros,
  probeWslState,
  wslUsageHomes
};
