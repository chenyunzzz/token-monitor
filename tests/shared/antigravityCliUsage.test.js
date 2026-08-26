'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectAntigravityCliModels,
  enrichAntigravityJson,
  modelCandidates
} = require('../../src/shared/antigravityCliUsage');

test('modelCandidates prefers canonical Gemini ids found in agy protobuf blobs', () => {
  assert.deepEqual(
    modelCandidates(Buffer.from('Gemini 3.7 Flash (High) ... gemini-3.7-flash-high ... MODEL_GOOGLE_GEMINI_2_5_FLASH')),
    ['gemini-3.7-flash-high', 'gemini-2.5-flash']
  );
});

test('modelCandidates recognizes canonical Claude ids and provider enums', () => {
  assert.deepEqual(
    modelCandidates('claude-opus-4-6-thinking MODEL_ANTHROPIC_CLAUDE_3_7_SONNET'),
    ['claude-opus-4-6-thinking', 'claude-3.7-sonnet']
  );
});

test('collectAntigravityCliModels indexes models by conversation database id', () => {
  const blobs = {
    gen_metadata: [{ data: Buffer.from('Gemini 3.7 Flash (High)') }],
    executor_metadata: [{ data: Buffer.from('gemini-3.7-flash-high') }]
  };
  const sqlite = {
    DatabaseSync: class {
      constructor() {}
      prepare(sql) { return { all: () => blobs[sql.match(/FROM (\w+)/i)[1]] || [] }; }
      close() {}
    }
  };
  assert.deepEqual(
    [...collectAntigravityCliModels({ roots: ['C:/agy/conversations'], sqlite, readdirSync: () => ['abc.db', 'abc.db-wal', 'not-a-db'] })],
    [['abc', 'gemini-3.7-flash-high']]
  );
});

test('enrichAntigravityJson replaces only unknown antigravity rows', () => {
  const models = new Map([['abc', 'gemini-3.7-flash-high']]);
  const result = enrichAntigravityJson({ entries: [
    { client: 'antigravity-cli', sessionId: 'abc', model: 'unknown', input: 1 },
    { client: 'antigravity-cli', sessionId: 'abc', model: 'existing', input: 2 },
    { client: 'codex', sessionId: 'abc', model: 'unknown', input: 3 }
  ] }, models);
  assert.equal(result.entries[0].model, 'gemini-3.7-flash-high');
  assert.equal(result.entries[1].model, 'existing');
  assert.equal(result.entries[2].model, 'unknown');
});

test('enrichAntigravityJson uses the sole discovered model when a row has no session id', () => {
  const result = enrichAntigravityJson({ entries: [
    { client: 'antigravity-cli', model: 'unknown', input: 1 }
  ] }, new Map([['abc', 'gemini-3.7-flash-high']]));
  assert.equal(result.entries[0].model, 'gemini-3.7-flash-high');
});

test('enrichAntigravityJson keeps unknown when discovered sessions use different models', () => {
  const result = enrichAntigravityJson({ entries: [
    { client: 'antigravity-cli', model: 'unknown', input: 1 }
  ] }, new Map([
    ['abc', 'gemini-3.7-flash-high'],
    ['def', 'gemini-3.7-flash']
  ]));
  assert.equal(result.entries[0].model, 'unknown');
});
