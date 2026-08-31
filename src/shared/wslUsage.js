'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { throwIfAborted } = require('./abortSignal');
const { emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
const { REASONIX_CLIENT } = require('./reasonixPaths');
const { buildPromaPeriods, collectPromaRows } = require('./promaUsage');
const { buildDshPeriods, collectDshRows, parseDshUsageText } = require('./dshUsage');
const {
  buildAntigravityPeriods,
  collectAntigravityCliModels,
  enrichAntigravityJson,
  parseAntigravityUsageText
} = require('./antigravityCliUsage');

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
  '.codex/profiles',
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
  '.gemini/antigravity/conversations',
  '.gemini/antigravity-ide/conversations',
  '.gemini/antigravity-backup/conversations',
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
  '.proma/agent-sessions',
  '.lmstudio/server-logs'
];

// Maps every WSL_DATA_MARKERS entry to the tracked-client id that owns it, so a
// matched marker can be attributed back to a client (alt roots collapse to one
// id, e.g. .kimi/.kimi-code -> kimi; the OpenClaw bot dirs -> openclaw; the two
// Cline globalStorage paths -> cline). Ids must match DEFAULT_CLIENTS.
const MARKER_CLIENTS = {
  '.claude/projects': 'claude',
  '.claude/transcripts': 'claude',
  '.codex/sessions': 'codex',
  '.codex/profiles': 'codex',
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
  '.gemini/antigravity/conversations': 'antigravity',
  '.gemini/antigravity-ide/conversations': 'antigravity',
  '.gemini/antigravity-backup/conversations': 'antigravity',
  '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks': 'cline',
  '.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks': 'cline',
  '.pi/agent/sessions': 'pi',
  '.omp/agent/sessions': 'omp',
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
  '.proma/agent-sessions': 'proma',
  '.lmstudio/server-logs': 'lmstudio'
};

// Default command runner. The distro list uses UTF-16LE on Windows, while
// commands executed inside a distro generally return UTF-8.
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
  if (!isWsl) return Buffer.from(out).toString('utf8');
  const buffer = Buffer.from(out);
  let nulBytes = 0;
  for (const byte of buffer) if (byte === 0) nulBytes += 1;
  return buffer.toString(nulBytes > buffer.length / 8 ? 'utf16le' : 'utf8');
}

// Some Windows processes cannot open the WSL 9P share (`\\wsl$`) even though
// the distro is running. Keep a narrow command bridge for the two compatibility
// adapters that need the raw Linux stores. It returns only paths, model ids,
// and parsed usage rows; prompts and message text are never persisted or logged.
const WSL_BRIDGE_MARKERS = [
  ['/.dsh/sessions', 'dsh'],
  ['/.gemini/antigravity-cli/conversations', 'antigravity'],
  ['/.gemini/antigravity/conversations', 'antigravity'],
  ['/.gemini/antigravity-ide/conversations', 'antigravity'],
  ['/.gemini/antigravity-backup/conversations', 'antigravity']
];

function runWslBridgeCommand(distro, args, deps = {}) {
  const exec = deps.exec || defaultExec;
  return String(exec('wsl.exe', ['--distribution', distro, '--', ...args]));
}

function wslRemoteHomeFromUnc(home) {
  const match = String(home || '').match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)(\\.*)?$/i);
  if (!match) return null;
  const homeDir = (match[2] || '\\').replace(/\\/g, '/').replace(/\/+/g, '/');
  return { distro: match[1], homeDir: homeDir || '/' };
}

function wslRemoteHomeKey(home) {
  return home ? `${home.distro}\u0000${home.homeDir}` : '';
}

function wslBridgeHomes(deps = {}) {
  const homes = new Map();
  for (const distro of listWslDistros(deps)) {
    let output;
    try {
      output = runWslBridgeCommand(distro, [
        'find', '/home', '-type', 'd', '\\(',
        '-path', '*/.dsh/update-backups', '-prune', '-o', '\\(',
        '-path', '*/.dsh/sessions', '-o',
        '-path', '*/.gemini/antigravity-cli/conversations', '-o',
        '-path', '*/.gemini/antigravity/conversations', '-o',
        '-path', '*/.gemini/antigravity-ide/conversations', '-o',
        '-path', '*/.gemini/antigravity-backup/conversations',
        '\\)', '-print', '\\)'
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

function collectDshRowsFromWsl(home, deps = {}, options = {}) {
  const root = `${home.homeDir.replace(/\/$/, '')}/.dsh/sessions`;
  const output = runWslBridgeCommand(home.distro, [
    'find', root, '-type', 'f', '\\(', '-name', 'session.jsonl', '-o', '-name', 'session.jsonl.zstd', '\\)', '-print0'
  ], deps);
  const rows = [];
  for (const filePath of output.split('\0').map((value) => value.trim()).filter(Boolean)) {
    const command = filePath.endsWith('.zstd')
      ? ['zstd', '-q', '-dc', '--', filePath]
      : ['cat', '--', filePath];
    try {
      rows.push(...parseDshUsageText(runWslBridgeCommand(home.distro, command, deps), filePath, options));
    } catch (_) {
      // A live session can be replaced or have a torn final frame between
      // find and read. Keep the other sessions and retry on the next tick.
    }
  }
  return rows;
}

// Antigravity CLI persists one ModelUsageStats protobuf in steps.metadata per
// model call. Reading it inside WSL avoids the Windows 9P/SQLite boundary and
// avoids depending on Tokscale support for this private database format.
const AGY_USAGE_SCRIPT = [
  'import glob,os,re,sqlite3,sys,datetime',
  'rx=re.compile(rb"(?<![A-Za-z0-9])(?:gemini|claude|gpt|deepseek|qwen|mistral|llama)-[A-Za-z0-9][A-Za-z0-9._-]*",re.I)',
  'label_rx=re.compile(rb"(?:Gemini|Claude|GPT|DeepSeek|Qwen|Mistral|Llama)\\s+[0-9][A-Za-z0-9 .()_-]{2,80}")',
  'def varint(b,i):',
  ' v=0;s=0',
  ' while i<len(b):',
  '  x=b[i];i+=1;v|=(x&127)<<s',
  '  if x<128:return v,i',
  '  s+=7',
  ' return 0,i',
  'def fields(b):',
  ' i=0;out=[]',
  ' try:',
  '  while i<len(b):',
  '   key,i=varint(b,i); no=key>>3; wt=key&7',
  '   if no<1 or no>1000:return []',
  '   if wt==0:',
  '    v,i=varint(b,i);out.append((no,wt,v))',
  '   elif wt==1:',
  '    if i+8>len(b):return []',
  '    i+=8',
  '   elif wt==2:',
  '    n,i=varint(b,i);v=b[i:i+n];i+=n;out.append((no,wt,v))',
  '   elif wt==5:',
  '    if i+4>len(b):return []',
  '    i+=4',
  '   else:return []',
  ' except Exception:return []',
  ' return out',
  'def model_for(db):',
  ' vals=[]',
  ' for table in ("executor_metadata","gen_metadata","steps"):',
  '  try: rows=db.execute("select data from "+table).fetchall() if table!="steps" else db.execute("select metadata from steps").fetchall()',
  '  except Exception: rows=[]',
  '  for (v,) in rows:',
  '   if not v:continue',
  '   raw=v if isinstance(v,bytes) else str(v).encode()',
  '   vals += [x.decode("ascii","ignore").lower() for x in rx.findall(raw)]',
  '   if not vals:',
  '    vals += [re.sub(r"\\s+"," ",x.decode("utf-8","ignore")).strip().lower() for x in label_rx.findall(raw)]',
  ' if vals:',
  '  m=vals[0].replace("("," ").replace(")"," ")',
  '  return re.sub(r"[^a-z0-9.]+","-",m).strip("-")',
  ' return "unknown"',
  'def timestamp(blob):',
  ' fs=fields(blob)',
  ' for no,wt,v in fs:',
  '  if no==1 and wt==2:',
  '   inner=fields(v); sec=next((x[2] for x in inner if x[0]==1 and x[1]==0),0); ns=next((x[2] for x in inner if x[0]==2 and x[1]==0),0)',
  '   if sec:return datetime.datetime.fromtimestamp(sec+ns/1e9,datetime.timezone.utc).isoformat().replace("+00:00","Z")',
  ' return ""',
  'def usage(blob):',
  ' fs=fields(blob)',
  ' for no,wt,v in fs:',
  '  if no!=9 or wt!=2:continue',
  '  vals={x[0]:x[2] for x in fields(v) if x[1]==0}',
  '  if 2 not in vals or 3 not in vals:continue',
  '  return (vals.get(2,0),vals.get(3,0),vals.get(5,0),vals.get(4,0))',
  ' return None',
  'for root in sys.argv[1:]:',
  ' for p in glob.glob(os.path.join(root,"*.db")):',
  '  try:',
  '   db=sqlite3.connect("file:"+p+"?mode=ro",uri=True,timeout=0.2); model=model_for(db); sid=os.path.basename(p)[:-3]',
  '   for _,metadata in db.execute("select idx,metadata from steps order by idx"):',
  '    if not metadata:continue',
  '    when=timestamp(metadata); u=usage(metadata)',
  '    if when and u and sum(u)>0:print("\\t".join([sid,model,when]+[str(max(0,int(x))) for x in u]))',
  '   db.close()',
  '  except Exception:pass'
].join('\n');

function collectAntigravityUsageRowsFromWsl(home, deps = {}) {
  const homeDir = home.homeDir.replace(/\/$/, '');
  const roots = ['antigravity-cli', 'antigravity', 'antigravity-ide', 'antigravity-backup']
    .map((name) => homeDir + '/.gemini/' + name + '/conversations');
  return parseAntigravityUsageText(runWslBridgeCommand(home.distro, ['python3', '-c', AGY_USAGE_SCRIPT, ...roots], deps));
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
    const match = String(value || '').match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)\\/i);
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

function wslCodexProfileHomes(home, readdirSync = fs.readdirSync) {
  const profilesRoot = wslHomePath(home, '.codex/profiles');
  try {
    return readdirSync(profilesRoot, { withFileTypes: true })
      .flatMap((entry) => {
        if (typeof entry === 'string') return [wslHomePath(profilesRoot, entry)];
        return entry?.isDirectory?.() ? [wslHomePath(profilesRoot, entry.name)] : [];
      });
  } catch (_) {
    return [];
  }
}

async function runWslTokscaleWithCodexProfiles({
  runTokscale,
  baseInput,
  profiles,
  commandTimeoutMs,
  signal,
  logger,
  groupBy
}) {
  const base = await runTokscale({ ...baseInput, groupBy });
  if (!profiles || profiles.length === 0) return base;
  const entries = Array.isArray(base?.entries) ? [...base.entries] : [];
  for (const profile of profiles) {
    try {
      const profileJson = await runTokscale({
        clients: 'codex',
        flags: baseInput.flags.filter((value) => value !== '--home' && value !== baseInput.home),
        commandTimeoutMs,
        signal,
        env: { ...(baseInput.env || process.env), CODEX_HOME: profile },
        groupBy
      });
      if (Array.isArray(profileJson?.entries)) {
        entries.push(...profileJson.entries.map((entry) => (
          entry && typeof entry === 'object'
            ? { ...entry, provider: profile.split(/[\\/]/).pop() }
            : entry
        )));
      }
    } catch (error) {
      if (typeof logger === 'function') logger(`wsl codex profile scan failed for ${profile}: ${error.message}`);
    }
  }
  return entries.length > 0 ? { ...base, entries } : base;
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
  const {
    clients,
    trackedClients = clients,
    allTimeSince,
    commandTimeoutMs,
    now,
    runTokscale,
    logger,
    decoratePeriods,
    providerHints,
    sessionDetailsEnabled = true
  } = options;
  const todayOnly = options.todayOnly === true;
  const nowDate = new Date(now || Date.now());
  const todayStart = todayOnly
    ? new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()
    : 0;
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
  const bridgeHomes = (
    (tracked.has('dsh') && !hasLocalDsh) || tracked.has('antigravity')
  ) ? wslBridgeHomes(deps) : [];
  const bridgedAntigravitySuccess = new Set();
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
          rows: collectDshRowsFromWsl(remoteHome, deps, { sinceMs: todayStart }),
          now,
          allTimeSince
        });
        bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(dsh.today, { providerHints }));
        if (!todayOnly) {
          bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(dsh.month, { providerHints }));
          bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(dsh.allTime, { providerHints }));
        }
        remoteSucceeded = true;
      } catch (error) {
        if (typeof logger === 'function') logger(`wsl dsh bridge failed for ${remoteHome.distro}:${remoteHome.homeDir}: ${error.message}`);
      }
    }
    if (tracked.has('antigravity') && remoteClients.has('antigravity')) {
      detected.add('antigravity');
      try {
        const rows = collectAntigravityUsageRowsFromWsl(remoteHome, deps)
          .filter((row) => !todayOnly || Date.parse(row.lastUsedAt || '') >= todayStart);
        const periods = buildAntigravityPeriods({ rows, now, allTimeSince });
        bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(periods.today, { providerHints }));
        if (!todayOnly) {
          bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(periods.month, { providerHints }));
          bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(periods.allTime, { providerHints }));
        }
        bridgedAntigravitySuccess.add(wslRemoteHomeKey(remoteHome));
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
    let antigravityModels = null;
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
           roots: [wslHomePath(home, '.proma/agent-sessions')],
           ...(todayOnly ? { sinceMs: todayStart } : {})
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
        if (!todayOnly) {
          bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(proma.month, { providerHints }));
          bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(proma.allTime, { providerHints }));
        }
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
          rows: collectDsh({
            roots: [wslHomePath(home, '.dsh/sessions')],
            ...(todayOnly ? { sinceMs: todayStart } : {})
          }),
          now,
          allTimeSince
        });
        bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(dsh.today, { providerHints }));
        if (!todayOnly) {
          bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(dsh.month, { providerHints }));
          bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(dsh.allTime, { providerHints }));
        }
        homeSucceeded = true;
      } catch (error) {
        homeFailed = true;
        if (typeof logger === 'function') logger(`wsl dsh usage parse failed for ${home}: ${error.message}`);
      }
    }
    if (tracked.has('antigravity') && homeDataClients.includes('antigravity')) {
      const remoteHome = wslRemoteHomeFromUnc(home);
      const remoteKey = wslRemoteHomeKey(remoteHome);
      if (remoteHome && !bridgedAntigravitySuccess.has(remoteKey)) {
        try {
          const rows = collectAntigravityUsageRowsFromWsl(remoteHome, deps)
            .filter((row) => !todayOnly || Date.parse(row.lastUsedAt || '') >= todayStart);
          const periods = buildAntigravityPeriods({ rows, now, allTimeSince });
          bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(periods.today, { providerHints }));
          if (!todayOnly) {
            bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(periods.month, { providerHints }));
            bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(periods.allTime, { providerHints }));
          }
          homeSucceeded = true;
        } catch (error) {
          homeFailed = true;
          if (typeof logger === 'function') logger(`wsl antigravity UNC bridge failed for ${home}: ${error.message}`);
        }
      } else {
        try {
          antigravityModels = collectAntigravity({
            roots: ['antigravity-cli', 'antigravity', 'antigravity-ide', 'antigravity-backup']
              .map((name) => wslHomePath(home, '.gemini/' + name + '/conversations'))
          });
        } catch (error) {
          if (typeof logger === 'function') logger(`wsl antigravity model enrichment failed for ${home}: ${error.message}`);
        }
      }
    }
    // Tokscale 4.6+ keeps explicit --home scans isolated from host-native roots,
    // so every requested client can be passed through for each discovered home.
    // Keep the empty guard because an empty --client expands to all clients.
    const uncRemoteHome = wslRemoteHomeFromUnc(home);
    const isUncAntigravityHome = uncRemoteHome && homeDataClients.includes('antigravity');
    const homeClientsCsv = clientsCsv.split(',')
      .filter((client) => !(client === 'antigravity' && isUncAntigravityHome))
      .join(',');
    if (homeClientsCsv.length > 0 && typeof runTokscale === 'function') try {
      // Serial on purpose (issue #15): never run these concurrently.
      const codexProfiles = homeClientsCsv.split(',').includes('codex')
        ? wslCodexProfileHomes(home, readdirSync)
        : [];
      const scan = (periodFlags) => runWslTokscaleWithCodexProfiles({
        runTokscale,
        baseInput: {
          clients: homeClientsCsv,
          flags: periodFlags,
          home,
          commandTimeoutMs,
          signal: options.signal
        },
        profiles: codexProfiles,
        commandTimeoutMs,
        signal: options.signal,
        logger,
        groupBy: sessionDetailsEnabled === false ? 'client,provider,model' : 'client,session,model'
      });
       let todayJson = await scan(['--today', '--home', home]);
       throwIfAborted(options.signal, 'WSL usage scan aborted');
       const periods = { today: extractUsageFromTokscale(enrichAntigravityJson(todayJson, antigravityModels), { providerHints }) };
       todayJson = null;
       if (!todayOnly) {
         let monthJson = await scan(['--month', '--home', home]);
         throwIfAborted(options.signal, 'WSL usage scan aborted');
         periods.month = extractUsageFromTokscale(enrichAntigravityJson(monthJson, antigravityModels), { providerHints });
         monthJson = null;
         let allTimeJson = await scan(['--since', allTimeSince, '--home', home]);
         throwIfAborted(options.signal, 'WSL usage scan aborted');
         periods.allTime = extractUsageFromTokscale(enrichAntigravityJson(allTimeJson, antigravityModels), { providerHints });
         allTimeJson = null;
       }
       if (typeof decoratePeriods === 'function') decoratePeriods(periods, home);
       bundle.today = mergePeriods(bundle.today, periods.today);
       if (!todayOnly) {
         bundle.month = mergePeriods(bundle.month, periods.month);
         bundle.allTime = mergePeriods(bundle.allTime, periods.allTime);
       }
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
  wslCodexProfileHomes,
  wslUsageHomes
};
