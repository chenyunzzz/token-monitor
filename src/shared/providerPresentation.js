'use strict';

(function exposeProviderPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorProviderPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createProviderPresentationApi() {
  const labels = {
    ollama: 'Ollama',
    'opencode-go': 'OpenCode Go',
    opencode: 'OpenCode',
    'openai-compatible': 'OpenAI Compatible',
    'cli-proxy-api': 'CLIProxyAPI',
    cliproxyapi: 'CLIProxyAPI',
    openrouter: 'OpenRouter',
    sub2api: 'Sub2API',
    google: 'Google',
    openai: 'OpenAI',
    cc_switch: 'CC Switch'
  };

  // DSH route ids identify the backend, while Vision Toolkit adds a wrapper
  // prefix for image-capable variants of the same route.
  const aliases = {
    'deepseek-official': 'ollama',
    'ollama-local': 'ollama',
    'local-ollama': 'ollama',
    ollama_local: 'ollama'
  };

  function normalizedProviderId(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  }

  function canonicalProviderId(value) {
    const normalized = normalizedProviderId(value);
    if (!normalized) return '';
    const upstream = normalized.startsWith('vision-toolkit-')
      ? normalized.slice('vision-toolkit-'.length)
      : normalized;
    return aliases[upstream] || upstream;
  }

  function providerDisplayName(value) {
    const canonical = canonicalProviderId(value);
    return labels[canonical] || String(value || '').trim() || canonical;
  }

  return { canonicalProviderId, normalizedProviderId, providerDisplayName };
});
