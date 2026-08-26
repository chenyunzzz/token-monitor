'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODEL_ID_RE = /(?<![A-Za-z0-9])gemini-[0-9][A-Za-z0-9._-]*/gi;
const MODEL_LABEL_RE = /Gemini\s+[0-9][A-Za-z0-9 .()_-]{2,80}/g;
const MODEL_ENUM_RE = /MODEL_GOOGLE_GEMINI_([0-9_]+)_(FLASH|PRO)(?:_([A-Z]+))?/g;
const IGNORE_MODELS = new Set([
  'gemini_model',
  'gemini_coder',
  'gemini_local',
  'gemini'
]);

function modelFromEnum(match) {
  const version = match[1].replace(/_/g, '.');
  const family = match[2].toLowerCase();
  const suffix = match[3] ? `-${match[3].toLowerCase()}` : '';
  return `gemini-${version}-${family}${suffix}`;
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
  for (const match of text.matchAll(MODEL_ENUM_RE)) candidates.push(modelFromEnum(match));
  if (candidates.length === 0) {
    for (const match of text.matchAll(MODEL_LABEL_RE)) {
      const model = match[0].replace(/\s+/g, ' ').trim();
      if (!/^Gemini\s+status$/i.test(model)) candidates.push(model);
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
      if (model.startsWith('gemini-')) return model;
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

module.exports = {
  collectAntigravityCliModels,
  enrichAntigravityJson,
  modelCandidates
};
