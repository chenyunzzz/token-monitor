'use strict';

const fs = require('node:fs');

function gatewayFromProcRoute(text) {
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[1] !== '00000000') continue;
    const hex = fields[2];
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue;
    const bytes = hex.match(/[0-9a-fA-F]{2}/g).map((value) => Number.parseInt(value, 16));
    return bytes.reverse().join('.');
  }
  return '';
}

function wslDefaultGateway({ readFileSync = fs.readFileSync, routeFile = '/proc/net/route' } = {}) {
  try {
    return gatewayFromProcRoute(readFileSync(routeFile, 'utf8'));
  } catch (_) {
    return '';
  }
}

function replaceHostname(value, hostname) {
  try {
    const url = new URL(value);
    url.hostname = hostname;
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

/**
 * Return the configured hub first, then the current WSL NAT gateway when the
 * configured endpoint is an IPv4 address. WSL recreates its virtual network
 * after restart, so a previously copied host address is not durable.
 */
function hubUrlCandidates(configuredUrl, options = {}) {
  const normalized = String(configuredUrl || '').replace(/\/$/, '');
  if (!normalized) return [];
  const candidates = [normalized];
  if ((options.platform || process.platform) !== 'linux') return candidates;

  let hostname;
  try { hostname = new URL(normalized).hostname; } catch (_) { return candidates; }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return candidates;
  const gateway = options.gateway || wslDefaultGateway(options);
  if (gateway && gateway !== hostname) {
    const fallback = replaceHostname(normalized, gateway);
    if (fallback && !candidates.includes(fallback)) candidates.push(fallback);
  }
  return candidates;
}

function isHubNetworkError(error) {
  const networkCodes = new Set([
    'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
    'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'
  ]);
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (networkCodes.has(current.code)) return true;
    current = current.cause;
  }
  return error?.name === 'AbortError' || (error instanceof TypeError && /fetch failed|network/i.test(error.message || ''));
}

function createHubEndpointSender(configuredUrl, options = {}) {
  let successfulEndpoint = null;
  let candidateKey = '';

  return async function send(sendEndpoint) {
    // Rediscover on every post: a WSL restart can replace the NAT gateway.
    const candidates = hubUrlCandidates(configuredUrl, options);
    const nextKey = candidates.join('\n');
    if (nextKey !== candidateKey) {
      candidateKey = nextKey;
      successfulEndpoint = null;
    }
    const ordered = successfulEndpoint && candidates.includes(successfulEndpoint)
      ? [successfulEndpoint, ...candidates.filter((endpoint) => endpoint !== successfulEndpoint)]
      : candidates;
    let lastError = null;
    for (let index = 0; index < ordered.length; index += 1) {
      const endpoint = ordered[index];
      try {
        const result = await sendEndpoint(endpoint);
        successfulEndpoint = endpoint;
        return result;
      } catch (error) {
        lastError = error;
        if (!isHubNetworkError(error)) throw error;
        if (index + 1 < ordered.length) options.onFallback?.(endpoint, ordered[index + 1]);
      }
    }
    throw lastError;
  };
}

module.exports = {
  createHubEndpointSender,
  gatewayFromProcRoute,
  hubUrlCandidates,
  isHubNetworkError,
  wslDefaultGateway
};
