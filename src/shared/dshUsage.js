'use strict';

// dsh is not understood by every Tokscale build shipped with Token Monitor.
// Read its durable transcript directly and emit the same entry shape that
// extractUsageFromTokscale already understands. This keeps the adapter local:
// only counters and routing metadata leave the collector, never prompt text.

const fs = require('node:fs');
const path = require('node:path');
const {
  decodeSessionText,
  dshSessionFiles,
  readDshSessionHeader,
  resolveDshSessionsRoot
} = require('./dshSessionFiles');

const DSH_TAIL_CHUNK_BYTES = 1024 * 1024;

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function firstNumber(value, keys) {
  if (!value || typeof value !== 'object') return 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const parsed = numberValue(value[key]);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function firstString(value, keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    const text = String(value[key] || '').trim();
    if (text) return text;
  }
  return '';
}

function timestampMs(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    let result = Number(value);
    if (!Number.isFinite(result) || result <= 0) return 0;
    // dsh writes milliseconds, but accepting seconds makes old exports safe.
    if (result < 1e12) result *= 1000;
    return result;
  }
  const result = Date.parse(value || '');
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function sourceValue(record) {
  const data = record?.data || {};
  const message = data.message || record?.message || {};
  const source = message.source || data.source || record?.source || {};
  const model = typeof source === 'object'
    ? firstString(source, ['model', 'modelId', 'modelID', 'model_id', 'name'])
    : String(source || '').trim();
  const provider = typeof source === 'object'
    ? firstString(source, ['provider', 'providerId', 'providerID', 'provider_id', 'name'])
    : '';
  return {
    model: model || firstString(record, ['model', 'modelId', 'modelID', 'model_id', 'modelName', 'model_name'])
      || firstString(data, ['model', 'modelId', 'modelID', 'model_id', 'modelName', 'model_name']),
    provider: provider || firstString(record, ['provider', 'providerId', 'providerID', 'provider_id'])
      || firstString(data, ['provider', 'providerId', 'providerID', 'provider_id']),
    message
  };
}

function fillSessionModelGaps(rows) {
  const bySession = new Map();
  for (const row of rows) {
    const key = row.sessionId || '';
    if (!key) continue;
    const info = bySession.get(key) || { models: new Set(), providers: new Set() };
    if (row.model && row.model !== 'unknown') info.models.add(row.model);
    if (row.provider) info.providers.add(row.provider);
    bySession.set(key, info);
  }
  return rows.map((row) => {
    if (row.model !== 'unknown') return row;
    const info = bySession.get(row.sessionId || '');
    if (!info || info.models.size !== 1) return row;
    const model = [...info.models][0];
    const provider = !row.provider && info.providers.size === 1 ? [...info.providers][0] : row.provider;
    return { ...row, model, ...(provider ? { provider } : {}) };
  });
}

function usageFromRecord(record) {
  const usage = record?.data?.usage || record?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = firstNumber(usage, ['inputTokens', 'input_tokens', 'input', 'promptTokens', 'prompt_tokens']);
  const rawOutput = firstNumber(usage, ['outputTokens', 'output_tokens', 'output', 'completionTokens', 'completion_tokens']);
  const cacheRead = firstNumber(usage, ['cacheReadTokens', 'cache_read_tokens', 'cacheRead', 'cache_read']);
  const cacheWrite = firstNumber(usage, ['cacheWriteTokens', 'cache_write_tokens', 'cacheWrite', 'cache_write']);
  const reasoning = firstNumber(usage, ['reasoningTokens', 'reasoning_tokens', 'reasoning', 'reasoning_output_tokens']);
  const explicitTotal = firstNumber(usage, ['totalTokens', 'total_tokens', 'total']);
  const totalTokens = explicitTotal > 0
    ? explicitTotal
    : input + rawOutput + cacheRead + cacheWrite;
  if (totalTokens <= 0) return null;
  // dsh's outputTokens includes reasoningTokens. The shared usage format keeps
  // reasoning as a disjoint bucket for dsh, so subtract it here and lets the
  // normalizer add it back exactly once.
  return {
    input,
    output: Math.max(0, rawOutput - reasoning),
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens,
    rawOutput
  };
}

function sessionIdFromFile(filePath) {
  return path.basename(path.dirname(filePath)) || 'unknown';
}

function parseDshUsageText(text, filePath = '', options = {}) {
  const sinceMs = Math.max(0, Number(options.sinceMs || 0));
  const rows = [];
  const seen = new Set();
  let sessionId = sessionIdFromFile(filePath);
  let sessionStartedAt = 0;
  let seedLength = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    if (record?.type === 'session') {
      if (typeof record.id === 'string' && record.id.trim()) sessionId = record.id.trim();
      sessionStartedAt = timestampMs(record.createdAt);
      const parsedSeed = Number(record.seedLength);
      seedLength = Number.isFinite(parsedSeed) ? parsedSeed : null;
      continue;
    }
    const sequence = Number.isFinite(record?.seq) ? record.seq : null;
    if (seedLength !== null && sequence !== null && sequence < seedLength) continue;
    if (record?.type !== 'assistant/message' && record?.type !== 'compaction/summary') continue;
    const usage = usageFromRecord(record);
    const time = timestampMs(record?.time);
    if (!usage || !time || (sinceMs && time < sinceMs)) continue;
    const { model, provider, message } = sourceValue(record);
    const messageId = String(message?.id || '').trim();
    const identity = messageId ? `msg:${messageId}` : (sequence === null ? `time:${time}` : `seq:${sequence}`);
    const key = [record.type, identity, time, provider, model, usage.input, usage.rawOutput, usage.cacheRead, usage.cacheWrite, usage.reasoning].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      client: 'dsh',
      sessionId,
      model: model || 'unknown',
      ...(provider ? { provider } : {}),
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      reasoning: usage.reasoning,
      totalTokens: usage.totalTokens,
      messageCount: 1,
      startedAt: new Date(sessionStartedAt || time).toISOString(),
      lastUsedAt: new Date(time).toISOString()
    });
  }
  return fillSessionModelGaps(rows);
}

function recordTimeMs(line) {
  try {
    const record = JSON.parse(line);
    return timestampMs(record?.time);
  } catch (_) {
    return 0;
  }
}

// DSH transcripts are append-only. During a today-only refresh, read backwards
// in bounded chunks until the first record before the requested boundary. This
// keeps a long-lived plain JSONL session from becoming a full-size temporary
// string on every watch event while retaining all records that can affect today.
function readJsonlSince(filePath, sinceMs) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    const parts = [];
    let offset = size;
    let carry = '';
    let reachedBoundary = false;
    while (offset > 0 && !reachedBoundary) {
      const start = Math.max(0, offset - DSH_TAIL_CHUNK_BYTES);
      const buffer = Buffer.alloc(offset - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = `${buffer.toString('utf8')}${carry}`.split(/\r?\n/);
      carry = start > 0 ? lines.shift() || '' : '';
      const selected = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        selected.push(line);
        const time = recordTimeMs(line);
        if (time && time < sinceMs) reachedBoundary = true;
      }
      if (selected.length > 0) parts.unshift(selected.join('\n'));
      offset = start;
    }
    return parts.join('\n');
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function parseDshUsageFile(filePath, options = {}) {
  try {
    const sinceMs = Math.max(0, Number(options.sinceMs || 0));
    if (sinceMs && filePath.endsWith('.jsonl')) {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < sinceMs) return [];
      const header = readDshSessionHeader(filePath);
      const tail = readJsonlSince(filePath, sinceMs);
      return parseDshUsageText(
        `${header ? `${JSON.stringify(header)}\n` : ''}${tail}`,
        filePath,
        options
      );
    }
    return parseDshUsageText(decodeSessionText(filePath, fs.readFileSync(filePath)), filePath, options);
  } catch (_) {
    return [];
  }
}

function collectDshRows(options = {}) {
  const roots = Array.isArray(options.roots)
    ? options.roots
    : [options.sessionsRoot || resolveDshSessionsRoot({
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform
    })];
  const rows = [];
  for (const root of roots.filter(Boolean)) {
      for (const filePath of dshSessionFiles(root)) rows.push(...parseDshUsageFile(filePath, options));
  }
  return rows;
}

function pricingForRow(row, pricingByModel) {
  const provider = String(row.provider || '').trim().toLowerCase();
  const model = String(row.model || '').trim().toLowerCase();
  return pricingByModel?.[provider && model ? `${provider}/${model}` : '']
    || pricingByModel?.[model]
    || null;
}

function rowCost(row, pricingByModel) {
  const pricing = pricingForRow(row, pricingByModel);
  if (!pricing) return 0;
  return row.input * numberValue(pricing.inputCostPerToken)
    + row.output * numberValue(pricing.outputCostPerToken)
    + row.reasoning * numberValue(pricing.outputCostPerToken)
    + row.cacheRead * numberValue(pricing.cacheReadInputTokenCost)
    + row.cacheWrite * numberValue(pricing.cacheCreationInputTokenCost);
}

function periodStart(now, period) {
  const date = new Date(now || Date.now());
  if (period === 'today') return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (period === 'month') return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  return 0;
}

function buildDshJson(rows, period, options = {}) {
  const start = periodStart(options.now, period);
  const allTimeSince = timestampMs(options.allTimeSince);
  const since = period === 'allTime' ? allTimeSince : start;
  const entries = rows
    .filter((row) => !since || timestampMs(row.lastUsedAt) >= since)
    .map((row) => ({ ...row, cost: rowCost(row, options.pricingByModel) }));
  return { groupBy: 'client,session,model', entries };
}

function buildDshPeriods(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : collectDshRows(options);
  return {
    today: buildDshJson(rows, 'today', options),
    month: buildDshJson(rows, 'month', options),
    allTime: buildDshJson(rows, 'allTime', options)
  };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildDshHistoryGraph(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : collectDshRows(options);
  const byDate = new Map();
  for (const row of rows) {
    const date = localDateKey(row.lastUsedAt);
    if (!date) continue;
    const modelId = row.provider ? `${row.provider}/${row.model}` : row.model;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: 'dsh',
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.tokens.reasoning += row.reasoning;
    client.cost += rowCost(row, options.pricingByModel);
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  buildDshHistoryGraph,
  buildDshPeriods,
  collectDshRows,
  parseDshUsageFile,
  parseDshUsageText
};
