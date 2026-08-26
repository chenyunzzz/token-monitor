'use strict';

(function exposeDeviceBreakdown(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDeviceBreakdown = api;
})(typeof window !== 'undefined' ? window : null, function createDeviceBreakdownApi() {
  const UNATTRIBUTED_KEY = '__unattributed';

  function positiveEntries(value) {
    return Object.entries(value || {})
      .map(([key, amount]) => [key, Math.max(0, Number(amount || 0))])
      .filter(([, amount]) => amount > 0);
  }

  function providerLabel(provider) {
    const labels = {
      'cli-proxy-api': 'CLIProxyAPI',
      cliproxyapi: 'CLIProxyAPI',
      'openai-compatible': 'OpenAI Compatible',
      'opencode-go': 'OpenCode Go',
      openrouter: 'OpenRouter',
      ollama: 'Ollama',
      sub2api: 'Sub2API'
    };
    return labels[provider] || provider;
  }

  function providerModelLabel(provider, model) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedModel = String(model || '').trim().toLowerCase();
    return normalizedProvider === 'antigravity' && normalizedModel === 'unknown'
      ? 'auto-detected'
      : model;
  }

  function modelsForClient(period, client, clientValue, unclassifiedLabel) {
    const legacyModels = positiveEntries(period.clientModels?.[client]);
    const legacyTotals = new Map(legacyModels);
    const providerRows = [];
    const accountedByModel = new Map();
    const providers = period.clientProviderModels?.[client] || {};
    for (const [provider, models] of Object.entries(providers)) {
      for (const [model, rawValue] of positiveEntries(models)) {
        const budget = legacyTotals.has(model)
          ? Math.max(0, (legacyTotals.get(model) || 0) - (accountedByModel.get(model) || 0))
          : Math.max(0, clientValue - providerRows.reduce((sum, row) => sum + row.value, 0));
        const value = Math.min(rawValue, budget);
        if (value <= 0) continue;
        accountedByModel.set(model, (accountedByModel.get(model) || 0) + value);
        providerRows.push({
          key: `provider:${provider}/${model}`,
          name: `${providerLabel(provider)} / ${providerModelLabel(provider, model)}`,
          value
        });
      }
    }
    const rows = [...providerRows];
    for (const [model, value] of legacyModels) {
      const residual = Math.max(0, value - (accountedByModel.get(model) || 0));
      if (residual > 0) rows.push({ key: model, name: model, value: residual });
    }
    const accounted = rows.reduce((sum, row) => sum + row.value, 0);
    const unclassified = Math.max(0, clientValue - accounted);
    if (unclassified > 0) rows.push({ key: `${UNATTRIBUTED_KEY}:${client}`, name: unclassifiedLabel || 'Unclassified', value: unclassified });
    return rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  }

  function deviceBreakdownForPeriod(device, periodName, options = {}) {
    const period = device?.periods?.[periodName] || {};
    const totalTokens = Math.max(0, Number(period.totalTokens || 0));
    const clientEntries = positiveEntries(period.clients);
    const attributedTokens = clientEntries.reduce((sum, [, value]) => sum + value, 0);
    const unattributedTokens = Math.max(0, totalTokens - attributedTokens);
    if (unattributedTokens > 0) clientEntries.push([UNATTRIBUTED_KEY, unattributedTokens]);
    const tools = clientEntries.map(([client, value]) => {
      const models = client === UNATTRIBUTED_KEY
        ? []
        : modelsForClient(period, client, value, options.unattributedLabel);

      return {
        key: client,
        client,
        name: client === UNATTRIBUTED_KEY
          ? options.unattributedLabel || 'Unclassified'
          : options.clientLabels?.[client] || client,
        value,
        percent: totalTokens > 0 ? value / totalTokens * 100 : 0,
        color: options.clientColors?.[client] || options.fallbackColor || '#73bdf5',
        models
      };
    }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

    return {
      totalTokens,
      tools
    };
  }

  function devicePlatformLabel(value, osName, osVersion) {
    const platform = String(value || '').toLowerCase().split('-')[0];
    let label = String(value || '');
    if (platform === 'darwin') label = 'macOS';
    else if (platform === 'win32') label = 'Windows';
    else if (platform === 'linux') label = 'Linux';
    const name = String(osName || '').trim() || label;
    const version = String(osVersion || '').trim();
    return [name, version].filter(Boolean).join(' ');
  }

  return { deviceBreakdownForPeriod, devicePlatformLabel };
});
