'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODEL_ID_RE = /(?<![A-Za-z0-9])(?:gemini|claude|gpt|deepseek|qwen|mistral|llama)-[A-Za-z0-9][A-Za-z0-9._-]*/gi;
const MODEL_LABEL_RE = /(?:Gemini|Claude|GPT|DeepSeek|Qwen|Mistral|Llama)\s+[0-9][A-Za-z0-9 .()_-]{2,80}/g;
const MODEL_ENUM_RE = /MODEL_(GOOGLE_GEMINI|ANTHROPIC_CLAUDE|OPENAI_GPT|DEEPSEEK|QWEN|MISTRAL|META_LLAMA)_([A-Z0-9_]+)/gi;
const IGNORE_MODELS = new Set([
  'gemini_model',
  'gemini_coder',
  'gemini_local',
  'gemini'
]);

function modelFromEnum(match) {
  const prefix = {
    GOOGLE_GEMINI: 'gemini',
    ANTHROPIC_CLAUDE: 'claude',
    OPENAI_GPT: 'gpt',
    DEEPSEEK: 'deepseek',
    QWEN: 'qwen',
    MISTRAL: 'mistral',
    META_LLAMA: 'llama'
  }[match[1].toUpperCase()];
  if (!prefix) return '';
  const parts = match[2].toLowerCase().split('_');
  const version = [];
  while (/^\d+$/.test(parts[0] || '') && version.length < 2) version.push(parts.shift());
  const body = [...(version.length > 0 ? [version.join('.')] : []), ...parts].join('-');
  return body ? `${prefix}-${body}` : '';
}

function modelCandidates(value) {
  const text = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value).toString('utf8')
    : String(value || '');
  const candidates = [];
  for (const match of text.matchAll(MODEL_ID_RE)) {
    const model = match[0].toLowerCase();
    if (!IGNORE_MODELS.has(model)) candidates.push(model);
  }
  for (const match of text.matchAll(MODEL_ENUM_RE)) {
    const model = modelFromEnum(match);
    if (model) candidates.push(model);
  }
  if (candidates.length === 0) {
    for (const match of text.matchAll(MODEL_LABEL_RE)) {
      const model = match[0].replace(/\s+/g, ' ').trim();
      if (!/^(?:Gemini|Claude|GPT|DeepSeek|Qwen|Mistral|Llama)\s+status$/i.test(model)) candidates.push(model);
    }
  }
  return candidates;
}

function databaseModel(db) {
  const rows = [];
  for (const table of ['gen_metadata', 'executor_metadata', 'steps']) {
    try { rows.push(...db.prepare(`SELECT data FROM ${table} ORDER BY idx`).all()); } catch (_) {}
  }
  let label = '';
  for (const row of rows) {
    for (const model of modelCandidates(row?.data)) {
      // Canonical ids are more useful for pricing and remain stable if the UI
      // label contains a gateway/account suffix.
      if (/^(?:gemini|claude|gpt|deepseek|qwen|mistral|llama)-/.test(model)) return model;
      label = model;
    }
  }
  return label;
}

function collectAntigravityCliModels(options = {}) {
  const sqlite = options.sqlite !== undefined ? options.sqlite : (() => {
    try { return require('node:sqlite'); } catch (_) { return null; }
  })();
  if (!sqlite) return new Map();
  const roots = Array.isArray(options.roots) ? options.roots : [options.root].filter(Boolean);
  const readdirSync = options.readdirSync || fs.readdirSync;
  const join = options.join || path.join;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const models = new Map();
  for (const root of roots) {
    let files;
    try { files = readdirSync(root); } catch (_) { continue; }
    for (const name of files) {
      const fileName = typeof name === 'string' ? name : name?.name;
      if (!fileName || !/\.db$/i.test(fileName)) continue;
      const filePath = join(root, fileName);
      let db;
      try {
        db = new sqlite.DatabaseSync(filePath, { readOnly: true });
        const model = databaseModel(db);
        if (model) models.set(fileName.replace(/\.db$/i, ''), model);
      } catch (_) {
        // A live SQLite database may be mid-checkpoint; Tokscale's counters are
        // still valid, so model enrichment must remain best effort.
      } finally {
        try { db?.close(); } catch (_) {}
      }
    }
  }
  // Keep readFileSync in the dependency seam so callers can verify file access
  // without opening a live database; it also makes the intent explicit that
  // only the database files, never prompt text, are inspected here.
  void readFileSync;
  return models;
}

function enrichAntigravityJson(json, modelsBySession) {
  if (!json || !Array.isArray(json.entries) || !(modelsBySession instanceof Map) || modelsBySession.size === 0) return json;
  // WSL Tokscale rows may not carry the CLI conversation id because the
  // Windows-side binary cannot always read the Linux SQLite metadata through
  // 9P. Only use a database-wide fallback when the scan proves that every
  // discovered conversation uses the same model; with multiple models,
  // keeping `unknown` is safer than assigning usage to the wrong bucket.
  const uniqueModels = new Set([...modelsBySession.values()].filter(Boolean));
  const soleModel = uniqueModels.size === 1 ? [...uniqueModels][0] : '';
  let changed = false;
  const entries = json.entries.map((entry) => {
    const client = String(entry?.client || '').toLowerCase();
    const model = String(entry?.model || '').trim().toLowerCase();
    if (!client.includes('antigravity') || (model && model !== 'unknown')) return entry;
    const sessionId = String(entry?.sessionId || entry?.session_id || '').trim();
    const actual = modelsBySession.get(sessionId) || soleModel;
    if (!actual) return entry;
    changed = true;
    return { ...entry, model: actual };
  });
  return changed ? { ...json, entries } : json;
}

function timestampMs(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed < 1e12 ? parsed * 1000 : parsed;
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseAntigravityUsageText(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sessionId, model, lastUsedAt, input, output, cacheRead, cacheWrite] = line.split('\t');
    if (!sessionId || !lastUsedAt) continue;
    const time = timestampMs(lastUsedAt);
    if (!time) continue;
    const numbers = [input, output, cacheRead, cacheWrite].map((value) => Math.max(0, Math.round(Number(value || 0))));
    if (numbers.every((value) => value === 0)) continue;
    rows.push({
      client: 'antigravity-cli',
      provider: 'antigravity',
      sessionId,
      model: model || 'unknown',
      input: numbers[0],
      output: numbers[1],
      cacheRead: numbers[2],
      cacheWrite: numbers[3],
      messageCount: 1,
      startedAt: new Date(time).toISOString(),
      lastUsedAt: new Date(time).toISOString()
    });
  }
  return rows;
}

function periodStart(now, period) {
  const date = new Date(now || Date.now());
  if (period === 'today') return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (period === 'month') return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  return 0;
}

function buildAntigravityJson(rows, period, options = {}) {
  const start = periodStart(options.now, period);
  const allTimeSince = timestampMs(options.allTimeSince);
  const since = period === 'allTime' ? allTimeSince : start;
  return {
    groupBy: 'client,session,model',
    entries: rows.filter((row) => !since || timestampMs(row.lastUsedAt) >= since)
  };
}

function buildAntigravityPeriods(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : [];
  return {
    today: buildAntigravityJson(rows, 'today', options),
    month: buildAntigravityJson(rows, 'month', options),
    allTime: buildAntigravityJson(rows, 'allTime', options)
  };
}

module.exports = {
  buildAntigravityPeriods,
  collectAntigravityCliModels,
  enrichAntigravityJson,
  modelCandidates,
  parseAntigravityUsageText
};
