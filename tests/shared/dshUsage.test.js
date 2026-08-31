'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildDshHistoryGraph, buildDshPeriods, collectDshPeriods, collectDshRows, parseDshUsageFile } = require('../../src/shared/dshUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

const NOW = new Date('2026-08-26T12:00:00.000Z');

function record({ seq, time, provider, model, input, output, reasoning = 0, type = 'assistant/message', id }) {
  return {
    type,
    seq,
    time: Date.parse(time),
    data: {
      message: {
        id,
        source: { kind: 'model', provider, model }
      },
      usage: { inputTokens: input, outputTokens: output, reasoningTokens: reasoning }
    }
  };
}

function writeSession(root, id, records) {
  const dir = path.join(root, 'project', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${records.map((value) => JSON.stringify(value)).join('\n')}\n`);
  return file;
}

test('dsh usage parser preserves provider/model and counts reasoning once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  try {
    const file = writeSession(root, 'session-1', [
      { type: 'session', id: 'session-1', createdAt: Date.parse('2026-08-25T10:00:00Z') },
      record({ seq: 1, time: '2026-08-26T10:00:00Z', provider: 'ollama', model: 'deepseek-v4-flash', input: 10, output: 100, reasoning: 60, id: 'm1' }),
      record({ seq: 2, time: '2026-08-26T10:01:00Z', provider: 'opencode-go', model: 'deepseek-v4-flash', input: 20, output: 5, id: 'm2' }),
      record({ seq: 3, time: '2026-08-25T10:01:00Z', provider: 'deepseek-official', model: 'deepseek-v4-flash', input: 100, output: 0, id: 'old' })
    ]);
    const rows = parseDshUsageFile(file);
    const period = extractUsageFromTokscale(buildDshPeriods({ rows, now: NOW, allTimeSince: '2026-01-01' }).today);
    assert.equal(period.totalTokens, 135);
    assert.deepEqual(period.providerModels, {
      ollama: { 'deepseek-v4-flash': 110 },
      'opencode-go': { 'deepseek-v4-flash': 25 }
    });
    assert.equal(period.clientProviderModels.dsh.ollama['deepseek-v4-flash'], 110);
    assert.equal(period.outputTokens, 105);
    assert.equal(period.sessions['dsh:session-1'].reasoningTokens, 60);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dsh today refresh keeps current rows without loading old rows into the result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  try {
    const file = writeSession(root, 'today-only', [
      { type: 'session', id: 'today-only', createdAt: Date.parse('2026-08-25T10:00:00Z') },
      record({ seq: 1, time: '2026-08-25T10:00:00Z', provider: 'ollama', model: 'old-model', input: 1000, output: 1000, id: 'old' }),
      record({ seq: 2, time: '2026-08-26T10:00:00Z', provider: 'ollama', model: 'today-model', input: 10, output: 5, id: 'today' })
    ]);
    const rows = parseDshUsageFile(file, { sinceMs: Date.parse('2026-08-26T00:00:00Z') });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'today-model');
    assert.equal(rows[0].totalTokens, 15);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dsh parser removes replayed rows, fork seed, and includes history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  try {
    const header = { type: 'session', id: 'fork', seedLength: 3 };
    const inherited = record({ seq: 1, time: '2026-08-26T08:00:00Z', provider: 'ollama', model: 'm', input: 100, output: 100, id: 'old' });
    const own = record({ seq: 3, time: '2026-08-26T09:00:00Z', provider: 'opencode-go', model: 'm', input: 4, output: 6, id: 'new' });
    const file = writeSession(root, 'fork', [header, inherited, own, own]);
    const rows = collectDshRows({ roots: [path.dirname(path.dirname(file))] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalTokens, 10);
    const graph = buildDshHistoryGraph({ rows });
    assert.deepEqual(graph.contributions[0].clients[0].tokens, {
      input: 4,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dsh parser fills unknown rows when a session has one known model', () => {
  const text = [
    JSON.stringify({ type: 'session', id: 'single-model' }),
    JSON.stringify(record({ seq: 1, time: '2026-08-26T08:00:00Z', provider: 'opencode-go', model: 'deepseek-v4-flash', input: 10, output: 1, id: 'known' })),
    JSON.stringify(record({ seq: 2, time: '2026-08-26T08:01:00Z', provider: 'opencode-go', model: '', input: 20, output: 2, id: 'unknown' }))
  ].join('\n');
  const rows = require('../../src/shared/dshUsage').parseDshUsageText(text, 'single-model/session.jsonl');
  assert.equal(rows[1].model, 'deepseek-v4-flash');
  assert.equal(rows[1].provider, 'opencode-go');
});

test('headless dsh collection keeps only provider/model aggregates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  try {
    const file = writeSession(root, 'compact', [
      { type: 'session', id: 'compact' },
      record({ seq: 1, time: '2026-08-26T08:00:00Z', provider: 'ollama', model: 'm', input: 10, output: 1, id: 'one' }),
      record({ seq: 2, time: '2026-08-26T08:01:00Z', provider: 'ollama', model: 'm', input: 20, output: 2, id: 'two' })
    ]);
    const periods = collectDshPeriods({
      roots: [path.dirname(path.dirname(file))],
      now: NOW,
      allTimeSince: '2026-01-01'
    });
    assert.equal(periods.today.entries.length, 1);
    assert.deepEqual(periods.today.entries[0], {
      client: 'dsh', model: 'm', provider: 'ollama', input: 30, output: 3,
      cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 33,
      messageCount: 2, startedAt: '2026-08-26T08:00:00.000Z',
      lastUsedAt: '2026-08-26T08:01:00.000Z', cost: 0
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dsh parser keeps unknown rows when a session has multiple models', () => {
  const text = [
    JSON.stringify({ type: 'session', id: 'multi-model' }),
    JSON.stringify(record({ seq: 1, time: '2026-08-26T08:00:00Z', provider: 'ollama', model: 'deepseek-v4-flash', input: 10, output: 1, id: 'first' })),
    JSON.stringify(record({ seq: 2, time: '2026-08-26T08:01:00Z', provider: 'opencode-go', model: 'deepseek-v4', input: 20, output: 2, id: 'second' })),
    JSON.stringify(record({ seq: 3, time: '2026-08-26T08:02:00Z', provider: 'opencode-go', model: '', input: 30, output: 3, id: 'unknown' }))
  ].join('\n');
  const rows = require('../../src/shared/dshUsage').parseDshUsageText(text, 'multi-model/session.jsonl');
  assert.equal(rows[2].model, 'unknown');
});
