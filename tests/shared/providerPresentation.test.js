'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canonicalProviderId,
  providerDisplayName
} = require('../../src/shared/providerPresentation');

test('canonicalizes DSH route ids without changing unrelated provider ids', () => {
  assert.equal(canonicalProviderId('deepseek-official'), 'ollama');
  assert.equal(canonicalProviderId('vision-toolkit-deepseek-official'), 'ollama');
  assert.equal(canonicalProviderId('opencode-go'), 'opencode-go');
  assert.equal(canonicalProviderId('vision-toolkit-opencode-go'), 'opencode-go');
  assert.equal(canonicalProviderId('ollama-local'), 'ollama');
  assert.equal(canonicalProviderId('sub2api'), 'sub2api');
});

test('uses human provider labels for canonicalized DSH routes', () => {
  assert.equal(providerDisplayName('deepseek-official'), 'Ollama');
  assert.equal(providerDisplayName('vision-toolkit-opencode-go'), 'OpenCode Go');
});
