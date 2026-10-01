'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SOURCE_ENV_KEYS, installSourceEnvGuard } = require('./sourceEnv');

// These suites exercise host collection. Source overrides, persisted anchors,
// and Windows app-data roots must not escape their temporary homes.
function installCollectorFixture(test) {
  installSourceEnvGuard(test, [
    ...SOURCE_ENV_KEYS,
    'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'TOKSCALE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'TOKEN_MONITOR_SHARED_DIR'
  ]);
  let home;
  let originalHomedir;
  test.beforeEach(() => {
    home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-collector-fixture-'));
    originalHomedir = os.homedir;
    os.homedir = () => home;
    process.env.TOKEN_MONITOR_SHARED_DIR = home;
  });
  test.afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

function freshCollector() {
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const collector = require(collectorPath);
  // A running developer WSL distro otherwise adds three scans to host-only
  // assertions. WSL tests opt in explicitly and inject their own scan/probe.
  return {
    ...collector,
    collectUsageOnce: (options) => collector.collectUsageOnce({ wslScanEnabled: false, ...options }),
    startCollector: (options) => collector.startCollector({ wslScanEnabled: false, ...options })
  };
}

module.exports = { installCollectorFixture, freshCollector };
