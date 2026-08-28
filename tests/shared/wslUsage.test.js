'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isWslInstalled,
  distroNamesFromEnvironment,
  distroNamesFromRegistry,
  listRunningWslDistros,
  listWslDistros,
  emptyWslBundle,
  wslUsageHomes,
  homeHasData,
  collectWslUsage
} = require('../../src/shared/wslUsage');

test('homeHasData returns the client ids whose markers are present', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const present = new Set([
    `${home}\\.codex\\sessions`,
    `${home}\\.hermes`,
    `${home}\\.local\\share\\opencode`,
    `${home}\\.zcode\\cli\\db`
  ]);
  const existsSync = (p) => present.has(p);
  const ids = homeHasData(home, existsSync);
  assert.deepEqual([...ids].sort(), ['codex', 'hermes', 'opencode', 'zcode']);
});

test('homeHasData maps an alternate-root marker to its client id', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const present = new Set([`${home}\\.kimi-code\\sessions`]);
  const ids = homeHasData(home, (p) => present.has(p));
  assert.deepEqual([...ids], ['kimi']);
});

test('homeHasData maps Proma agent sessions to proma', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const present = new Set([`${home}\\.proma\\agent-sessions`]);
  const ids = homeHasData(home, (p) => present.has(p));
  assert.deepEqual(ids, ['proma']);
});

test('homeHasData maps VS Code Copilot workspace storage to copilot', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const workspaceRoot = `${home}\\.config\\Code\\User\\workspaceStorage`;
  const present = new Set([`${workspaceRoot}\\abc\\chatSessions`]);
  assert.deepEqual(homeHasData(home, (p) => present.has(p), (p) => p === workspaceRoot ? ['abc'] : []), ['copilot']);
});

test('homeHasData returns empty array when no markers present', () => {
  const ids = homeHasData('\\\\wsl$\\Ubuntu\\home\\u', () => false);
  assert.deepEqual(ids, []);
});

test('WSL marker discovery deliberately excludes Reasonix', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const reasonixStats = `${home}\\.reasonix\\stats`;
  assert.deepEqual(homeHasData(home, (p) => p === reasonixStats), []);
});

test('isWslInstalled is false on non-win32 without calling exec', () => {
  let called = false;
  const ok = isWslInstalled({ platform: 'darwin', exec: () => { called = true; return ''; } });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('isWslInstalled false when reg query throws (key missing)', () => {
  const ok = isWslInstalled({ platform: 'win32', exec: () => { throw new Error('key not found'); } });
  assert.equal(ok, false);
});

test('isWslInstalled true when reg query succeeds', () => {
  const ok = isWslInstalled({ platform: 'win32', exec: () => 'HKEY_CURRENT_USER\\...\\Lxss\\{guid}' });
  assert.equal(ok, true);
});

test('listRunningWslDistros never calls wsl.exe when WSL not installed', () => {
  const calls = [];
  const out = listRunningWslDistros({
    platform: 'win32',
    exec: (cmd) => { calls.push(cmd); if (cmd === 'reg') throw new Error('missing'); return ''; }
  });
  assert.deepEqual(out, []);
  assert.deepEqual(calls, ['reg']); // reg only, wsl.exe never reached
});

test('listRunningWslDistros parses running names when installed', () => {
  const out = listRunningWslDistros({
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\nDebian\n')
  });
  assert.deepEqual(out, ['Ubuntu', 'Debian']);
});

test('listRunningWslDistros returns [] when wsl.exe throws', () => {
  const out = listRunningWslDistros({
    platform: 'win32',
    exec: (cmd) => { if (cmd === 'reg') return 'Lxss'; throw new Error('boom'); }
  });
  assert.deepEqual(out, []);
});

test('distroNamesFromRegistry parses registered WSL distro names', () => {
  const out = distroNamesFromRegistry([
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{one}',
    '    DistributionName    REG_SZ    Ubuntu-24.04',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{two}',
    '    DistributionName    REG_EXPAND_SZ    docker-desktop',
    '    DistributionName    REG_SZ    Ubuntu-24.04'
  ].join('\n'));
  assert.deepEqual(out, ['Ubuntu-24.04', 'docker-desktop']);
});

test('distroNamesFromEnvironment finds distro names in WSL UNC paths', () => {
  assert.deepEqual(
    distroNamesFromEnvironment({
      REASONIX_HOME: '\\\\wsl$\\Ubuntu-24.04\\home\\u\\.reasonix',
      OTHER: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\.dsh',
      LEGACY_OTHER: '\\\\wsl$\\Debian\\home\\u\\.codex',
      LOCAL: 'C:\\Users\\u'
    }),
    ['Ubuntu-24.04', 'Debian']
  );
});

test('listWslDistros falls back to registered distros when wsl list is denied', () => {
  const calls = [];
  const out = listWslDistros({
    platform: 'win32',
    env: { REASONIX_HOME: '\\\\wsl$\\Ubuntu-24.04\\home\\u\\.reasonix' },
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'reg' && args.length === 2) return 'Lxss';
      if (cmd === 'wsl.exe') throw new Error('拒绝访问');
      return 'HKEY...\n  DistributionName REG_SZ Ubuntu-24.04';
    }
  });
  assert.deepEqual(out, ['Ubuntu-24.04']);
  assert.ok(calls.some(([cmd]) => cmd === 'wsl.exe'));
  assert.ok(calls.some(([cmd, args]) => cmd === 'reg' && args.includes('/s')));
});

test('emptyWslBundle has three empty periods', () => {
  const b = emptyWslBundle();
  assert.equal(b.today.totalTokens, 0);
  assert.equal(b.month.totalTokens, 0);
  assert.equal(b.allTime.totalTokens, 0);
});

test('wslUsageHomes keeps homes with a data marker, drops empty ones', () => {
  const homes = wslUsageHomes({
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: (dir) => {
      if (dir === '\\\\wsl$\\Ubuntu\\home') return ['alice', 'bob'];
      throw new Error('unreadable');
    },
    existsSync: (p) => p === '\\\\wsl$\\Ubuntu\\home\\alice\\.claude\\projects'
  });
  assert.deepEqual(homes, ['\\\\wsl$\\Ubuntu\\home\\alice']);
});

test('wslUsageHomes tries wsl.localhost when the legacy UNC root is unreadable', () => {
  const home = '\\\\wsl.localhost\\Ubuntu\\home\\alice';
  const homes = wslUsageHomes({
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: (dir) => {
      if (dir === '\\\\wsl$\\Ubuntu\\home') throw new Error('legacy provider unavailable');
      if (dir === '\\\\wsl.localhost\\Ubuntu\\home') return ['alice'];
      return [];
    },
    existsSync: (p) => p === `${home}\\.dsh\\sessions`
  });
  assert.deepEqual(homes, [home]);
});

test('wslUsageHomes checks the root home too', () => {
  const homes = wslUsageHomes({
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Debian\n'),
    readdirSync: () => [],
    existsSync: (p) => p === '\\\\wsl$\\Debian\\root\\.codex\\sessions'
  });
  assert.deepEqual(homes, ['\\\\wsl$\\Debian\\root']);
});

test('wslUsageHomes returns [] when no distro is running', () => {
  const homes = wslUsageHomes({
    platform: 'win32',
    env: {},
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : ''),
    readdirSync: () => [],
    existsSync: () => true
  });
  assert.deepEqual(homes, []);
});

// A WSL home that only holds a new A-class client's data (pi, Oh My Pi, zed,
// kilocode, Command Code, DSH, micode, zcode, kiro) must still be discovered — mirroring the sync
// point each new tracked client adds (see AGENTS.md "Tracked-client list must
// stay in sync"). Zed's marker is the threads.db file, not the directory
// (tokscale checks is_file()).
test('wslUsageHomes keeps a home whose only tracked-client data is pi, zed, kilocode, Command Code, DSH, micode, zcode, or kiro', () => {
  function homesFor(markerRel) {
    return wslUsageHomes({
      platform: 'win32',
      exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
      readdirSync: () => ['alice'],
      existsSync: (p) => p === `\\\\wsl$\\Ubuntu\\home\\alice\\${markerRel.replace(/\//g, '\\')}`
    });
  }
  assert.deepEqual(homesFor('.pi/agent/sessions'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.omp/agent/sessions'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.local/share/zed/threads/threads.db'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.config/Code/User/globalStorage/kilocode.kilo-code/tasks'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.commandcode/projects'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.dsh/sessions'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.local/share/mimocode/mimocode.db'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.zcode/projects'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.zcode/cli/db'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.kiro/sessions'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.local/share/kiro-cli/data.sqlite3'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.config/Kiro/User/globalStorage/kiro.kiroagent'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  // WSL is case-sensitive, so the lowercase Kiro IDE root must be matched too.
  assert.deepEqual(homesFor('.config/kiro/User/globalStorage/kiro.kiroagent'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.codebuddy/projects'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
  assert.deepEqual(homesFor('.workbuddy'), ['\\\\wsl$\\Ubuntu\\home\\alice']);
});

test('wslUsageHomes keeps a home whose only data is VS Code Copilot Chat', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\alice';
  const workspaceRoot = `${home}\\.config\\Code\\User\\workspaceStorage`;
  const homes = wslUsageHomes({
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: (dir) => {
      if (dir === '\\\\wsl$\\Ubuntu\\home') return ['alice'];
      if (dir === workspaceRoot) return ['abc'];
      throw new Error('unreadable');
    },
    existsSync: (p) => p === `${workspaceRoot}\\abc\\chatSessions`
  });
  assert.deepEqual(homes, [home]);
});

// Antigravity CLI (`agy`) stores conversations as SQLite under
// ~/.gemini/antigravity-cli/conversations. A WSL home holding only that must
// still be kept and attributed to the umbrella `antigravity` client, otherwise a
// CLI-only WSL user is dropped before the scan can request the antigravity-cli id.
test('homeHasData attributes a CLI-only Antigravity home to antigravity', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\alice';
  const existsSync = (p) => p === `${home}\\.gemini\\antigravity-cli\\conversations`;
  assert.deepEqual(homeHasData(home, existsSync), ['antigravity']);
});

// A home holding only an alternate-root client (Claude transcripts, Kimi Code,
// legacy OpenClaw bot dirs) tokscale 3.1.3 still supports must be discovered too.
test('wslUsageHomes keeps a home whose only data is an alternate root', () => {
  function homesFor(markerRel) {
    return wslUsageHomes({
      platform: 'win32',
      exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
      readdirSync: () => ['alice'],
      existsSync: (p) => p === `\\\\wsl$\\Ubuntu\\home\\alice\\${markerRel.replace(/\//g, '\\')}`
    });
  }
  for (const rel of ['.claude/transcripts', '.kimi-code/sessions', '.clawdbot/agents', '.moltbot/agents', '.moldbot/agents']) {
    assert.deepEqual(homesFor(rel), ['\\\\wsl$\\Ubuntu\\home\\alice'], `alt root not discovered: ${rel}`);
  }
});

function entriesJson(tokens) {
  return { entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-4-8', input: tokens, output: 0, cost: 0 }] };
}

function tokscaleStub(map) {
  return async ({ flags }) => {
    const home = flags[flags.indexOf('--home') + 1];
    const period = flags.includes('--today') ? 'today' : flags.includes('--month') ? 'month' : 'allTime';
    return entriesJson(map[home][period]);
  };
}

test('collectWslUsage passes every requested client to each discovered home', async () => {
  const seenClientsPerHome = {};
  const runTokscale = async ({ clients, flags }) => {
    const home = flags[flags.indexOf('--home') + 1];
    (seenClientsPerHome[home] ??= []).push(clients);
    return { entries: [] };
  };
  const deps = {
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: () => ['alice', 'carol'],
    existsSync: (p) =>
      p.endsWith('\\alice\\.claude\\projects') ||
      p === '\\\\wsl$\\Ubuntu\\home\\carol\\.local\\share\\zed\\threads\\threads.db'
  };
  await collectWslUsage(
    { clients: ' claude, zed ', allTimeSince: '2025-01-01', commandTimeoutMs: 1000, runTokscale },
    deps
  );
  for (const home of ['\\\\wsl$\\Ubuntu\\home\\alice', '\\\\wsl$\\Ubuntu\\home\\carol']) {
    assert.deepEqual(seenClientsPerHome[home], ['claude,zed', 'claude,zed', 'claude,zed']);
  }
});

test('collectWslUsage scans Codex profiles and labels their provider', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const profileRoot = `${home}\\.codex\\profiles`;
  const calls = [];
  const runTokscale = async ({ clients, flags, env }) => {
    calls.push({ clients, flags, env });
    const isProfile = String(env?.CODEX_HOME || '').endsWith('\\.codex\\profiles\\google');
    return { entries: [{ client: 'codex', model: 'gemini-3.7-flash', input: isProfile ? 10 : 5, output: 0 }] };
  };
  const { bundle } = await collectWslUsage(
    { clients: 'codex', trackedClients: 'codex', allTimeSince: '2025-01-01', commandTimeoutMs: 1000, runTokscale },
    {
      platform: 'win32',
      exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
      readdirSync: (dir) => {
        if (dir === '\\\\wsl$\\Ubuntu\\home') return ['u'];
        if (dir === profileRoot) return [{ name: 'google', isDirectory: () => true }];
        return [];
      },
      existsSync: (value) => value === `${home}\\.codex\\sessions`
    }
  );
  assert.equal(bundle.today.totalTokens, 15);
  assert.equal(bundle.today.clientProviderModels.codex.google['gemini-3.7-flash'], 10);
  assert.equal(calls.filter((call) => call.env?.CODEX_HOME).length, 3);
  assert.ok(calls.filter((call) => call.env?.CODEX_HOME).every((call) => !call.flags.includes('--home')));
});

test('collectWslUsage sums two homes per period', async () => {
  const deps = {
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: () => ['alice', 'bob'],
    existsSync: (p) => p.endsWith('\\.claude\\projects')
  };
  const map = {
    '\\\\wsl$\\Ubuntu\\home\\alice': { today: 10, month: 100, allTime: 1000 },
    '\\\\wsl$\\Ubuntu\\home\\bob': { today: 5, month: 50, allTime: 500 }
  };
  const { bundle } = await collectWslUsage(
    { clients: 'claude', allTimeSince: '2025-01-01', commandTimeoutMs: 1000, runTokscale: tokscaleStub(map) },
    deps
  );
  assert.equal(bundle.today.totalTokens, 15);
  assert.equal(bundle.month.totalTokens, 150);
  assert.equal(bundle.allTime.totalTokens, 1500);
  assert.deepEqual(bundle.today.clients, { claude: 15 });
});

test('collectWslUsage decorates each home before merging periods', async () => {
  const homes = ['\\\\wsl$\\Ubuntu\\home\\alice'];
  const decorated = [];
  const { bundle } = await collectWslUsage({
    clients: 'claude', allTimeSince: '2026-01-01', runTokscale: async () => ({ rows: [{ client: 'claude', session: 's1', totalTokens: 1 }] }),
    decoratePeriods(periods, home) {
      decorated.push(home);
      for (const period of Object.values(periods)) {
        period.sessions['claude:s1'].projectId = 'sha256:wsl';
        period.sessions['claude:s1'].projectLabel = 'repo';
      }
    }
  }, {
    platform: 'win32', exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: () => ['alice'], existsSync: (value) => value.startsWith(homes[0]) && value.endsWith('\\.claude\\projects')
  });
  assert.deepEqual(decorated, homes);
  assert.equal(bundle.today.sessions['claude:s1'].projectId, 'sha256:wsl');
});

test('collectWslUsage reports detected clients separate from those with data', async () => {
  // One running distro, one home with BOTH .codex and .hermes markers, but
  // tokscale only returns tokens for codex (hermes SQLite reads empty over 9P).
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const deps = {
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: () => ['u'],
    existsSync: (p) => p.startsWith(`${home}\\.codex`) || p.startsWith(`${home}\\.hermes`)
  };
  const runTokscale = async () => ({ entries: [{ client: 'codex', sessionId: 's', model: 'm', input: 5, output: 0, cost: 0 }] });
  const { bundle, detected } = await collectWslUsage(
    { clients: 'codex,hermes', allTimeSince: '2024-01-01', commandTimeoutMs: 1000, runTokscale },
    deps
  );
  assert.deepEqual([...detected].sort(), ['codex', 'hermes']); // both markers found
  assert.deepEqual(Object.keys(bundle.allTime.clients), ['codex']); // only codex returned tokens
});

test('collectWslUsage does not report detected clients the user is not tracking', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const deps = {
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: () => ['u'],
    // Home holds BOTH codex and openclaw markers, but only codex is tracked.
    existsSync: (p) => p.startsWith(`${home}\\.codex`) || p.startsWith(`${home}\\.openclaw`)
  };
  const runTokscale = async () => ({ entries: [] });
  const { detected } = await collectWslUsage(
    { clients: 'codex', allTimeSince: '2024-01-01', commandTimeoutMs: 1000, runTokscale },
    deps
  );
  assert.deepEqual(detected, ['codex']); // openclaw marker present but untracked -> excluded
});

test('collectWslUsage parses Proma-only WSL homes without calling tokscale', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const now = new Date('2026-07-10T08:00:00.000Z');
  let promaOptions = null;
  const { bundle, detected } = await collectWslUsage(
    {
      clients: '',
      trackedClients: 'proma',
      allTimeSince: '2025-01-01',
      commandTimeoutMs: 1000,
      now,
      buildPromaPeriods: (options) => {
        promaOptions = options;
        return {
          today: { entries: [{ client: 'proma', model: 'm', input: 9, output: 1 }] },
          month: { entries: [{ client: 'proma', model: 'm', input: 20 }] },
          allTime: { entries: [{ client: 'proma', model: 'm', input: 30 }] }
        };
      }
    },
    {
      platform: 'win32',
      exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
      readdirSync: () => ['u'],
      existsSync: (p) => p === `${home}\\.proma\\agent-sessions`
    }
  );
  assert.deepEqual(detected, ['proma']);
  assert.deepEqual(promaOptions, {
    now,
    allTimeSince: '2025-01-01',
    roots: [`${home}\\.proma\\agent-sessions`]
  });
  assert.equal(bundle.today.clients.proma, 10);
  assert.equal(bundle.month.clients.proma, 20);
  assert.equal(bundle.allTime.clients.proma, 30);
});

test('collectWslUsage parses DSH-only WSL homes without calling tokscale', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  let tokScaleCalled = false;
  const { bundle, detected, successfulHomes } = await collectWslUsage(
    {
      clients: '',
      trackedClients: 'dsh',
      allTimeSince: '2025-01-01',
      now: new Date('2026-07-10T08:00:00.000Z'),
      runTokscale: async () => { tokScaleCalled = true; return { entries: [] }; },
      collectDshRows: (options) => {
        assert.deepEqual(options.roots, [`${home}\\.dsh\\sessions`]);
        return [{ client: 'dsh', sessionId: 's1', model: 'deepseek-v4-flash', provider: 'opencode-go', input: 9, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10, lastUsedAt: '2026-07-10T07:00:00.000Z' }];
      },
      buildDshPeriods: () => ({
        today: { entries: [{ client: 'dsh', sessionId: 's1', model: 'deepseek-v4-flash', provider: 'opencode-go', input: 9, output: 1, totalTokens: 10 }] },
        month: { entries: [{ client: 'dsh', sessionId: 's1', model: 'deepseek-v4-flash', provider: 'opencode-go', input: 9, output: 1, totalTokens: 10 }] },
        allTime: { entries: [{ client: 'dsh', sessionId: 's1', model: 'deepseek-v4-flash', provider: 'opencode-go', input: 9, output: 1, totalTokens: 10 }] }
      })
    },
    {
      platform: 'win32',
      exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
      readdirSync: () => ['u'],
      existsSync: (value) => value === `${home}\\.dsh\\sessions`
    }
  );
  assert.equal(tokScaleCalled, false);
  assert.deepEqual(detected, ['dsh']);
  assert.equal(successfulHomes, 1);
  assert.equal(bundle.allTime.clients.dsh, 10);
  assert.equal(bundle.allTime.clientProviderModels.dsh['opencode-go']['deepseek-v4-flash'], 10);
});

test('collectWslUsage reads Antigravity usage from an UNC home through WSL', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const { bundle } = await collectWslUsage(
    {
      clients: 'antigravity',
      trackedClients: 'antigravity',
      allTimeSince: '2025-01-01',
      now: new Date('2026-07-10T08:00:00.000Z'),
      runTokscale: async () => ({ entries: [] })
    },
    {
      platform: 'win32',
      exec: (cmd, args) => {
        if (cmd === 'reg') return 'Lxss';
        if (args.includes('python3')) return 'conversation-1\tgemini-3.7-flash-high\t2026-07-10T07:00:00Z\t30\t0\t0\t0\n';
        return 'Ubuntu\n';
      },
      readdirSync: () => ['u'],
      existsSync: (value) => value === `${home}\\.gemini\\antigravity-cli\\conversations`
    }
  );
  assert.equal(bundle.allTime.models['gemini-3.7-flash-high'], 30);
  assert.equal(bundle.allTime.models.unknown, undefined);
});

test('collectWslUsage applies the cached Proma price to WSL rows', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  let pricingRows = null;
  let buildOptions = null;
  await collectWslUsage(
    {
      clients: '', trackedClients: 'proma', allTimeSince: '2025-01-01', now: new Date('2026-07-10T08:00:00.000Z'),
      collectPromaRows: () => [{ model: 'gpt-5', input: 10 }],
      resolvePromaPricing: async (rows) => {
        pricingRows = rows;
        return { 'gpt-5': { inputCostPerToken: 0.000001 } };
      },
      buildPromaPeriods: (options) => {
        buildOptions = options;
        return { today: { entries: [] }, month: { entries: [] }, allTime: { entries: [] } };
      }
    },
    {
      platform: 'win32', exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'), readdirSync: () => ['u'],
      existsSync: (p) => p === `${home}\\.proma\\agent-sessions`
    }
  );
  assert.deepEqual(pricingRows, [{ model: 'gpt-5', input: 10 }]);
  assert.deepEqual(buildOptions.rows, pricingRows);
  assert.deepEqual(buildOptions.pricingByModel, { 'gpt-5': { inputCostPerToken: 0.000001 } });
});

test('collectWslUsage returns empty bundle when no homes', async () => {
  const { bundle } = await collectWslUsage(
    { clients: 'claude', allTimeSince: '2025-01-01', commandTimeoutMs: 1000, runTokscale: async () => ({}) },
    { platform: 'darwin' }
  );
  assert.equal(bundle.today.totalTokens, 0);
});

test('collectWslUsage falls back to wsl.exe when the WSL share is unreadable', async () => {
  const sessionText = [
    JSON.stringify({ type: 'session', id: 'remote-s1', createdAt: '2026-08-26T08:00:00Z' }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: '2026-08-26T09:00:00Z', source: { provider: 'opencode-go', model: 'deepseek-v4-flash' }, data: { usage: { inputTokens: 8, outputTokens: 2 } } })
  ].join('\n');
  const calls = [];
  const deps = {
    platform: 'win32',
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'reg' && args.length === 2) return 'Lxss';
      if (cmd === 'wsl.exe' && args[0] === '--list') return 'Ubuntu\n';
      if (cmd === 'wsl.exe' && args.includes('find') && args.includes('/home')) return '/home/u/.dsh/sessions\n';
      if (cmd === 'wsl.exe' && args.includes('find') && args.includes('/home/u/.dsh/sessions')) return '/home/u/.dsh/sessions/project/remote-s1/session.jsonl\0';
      if (cmd === 'wsl.exe' && args.includes('cat')) return sessionText;
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    },
    readdirSync: () => { throw new Error('UNC access denied'); },
    existsSync: () => false
  };
  const result = await collectWslUsage({ clients: '', trackedClients: 'dsh', now: new Date('2026-08-26T12:00:00Z') }, deps);
  assert.equal(result.bundle.allTime.clients.dsh, 10);
  assert.deepEqual(result.detected, ['dsh']);
  assert.ok(calls.some(([cmd, args]) => cmd === 'wsl.exe' && args.includes('cat')));
});

test('collectWslUsage reads Antigravity CLI usage through the WSL bridge', async () => {
  const calls = [];
  const deps = {
    platform: 'win32',
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'reg') return 'Lxss';
      if (cmd === 'wsl.exe' && args[0] === '--list') return 'Ubuntu\\n';
      if (cmd === 'wsl.exe' && args.includes('find')) return '/home/u/.gemini/antigravity-cli/conversations\n';
      if (cmd === 'wsl.exe' && args.includes('python3')) {
        return 'conversation-1\tgemini-3.7-flash-high\t2026-08-27T10:00:00Z\t100\t20\t300\t4\n';
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    },
    readdirSync: () => { throw new Error('UNC access denied'); },
    existsSync: () => false
  };
  const result = await collectWslUsage({
    clients: '',
    trackedClients: 'antigravity',
    allTimeSince: '2026-08-01',
    now: new Date('2026-08-27T12:00:00Z')
  }, deps);
  assert.equal(result.bundle.today.totalTokens, 424);
  assert.equal(result.bundle.allTime.clients.antigravity, 424);
  assert.equal(result.bundle.allTime.models['gemini-3.7-flash-high'], 424);
  assert.deepEqual(result.detected, ['antigravity']);
  assert.ok(calls.some(([cmd, args]) => cmd === 'wsl.exe' && args.includes('python3')));
});

test('collectWslUsage logs and skips a home that throws, keeps others', async () => {
  const logs = [];
  const deps = {
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\nDebian\n'),
    readdirSync: () => [],
    existsSync: (p) => p.endsWith('\\root\\.claude\\projects')
  };
  const runTokscale = async ({ flags }) => {
    const home = flags[flags.indexOf('--home') + 1];
    if (home.includes('Debian')) throw new Error('9p down');
    return entriesJson(7);
  };
  const { bundle } = await collectWslUsage(
    { clients: 'claude', allTimeSince: '2025-01-01', commandTimeoutMs: 1000, runTokscale, logger: (m) => logs.push(m) },
    deps
  );
  assert.equal(bundle.today.totalTokens, 7); // Ubuntu counted, Debian skipped
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Debian/);
});
