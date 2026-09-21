'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gatewayFromProcRoute, hubUrlCandidates, isHubNetworkError } = require('../../src/shared/hubEndpoint');

test('reads the WSL default gateway from the little-endian route table', () => {
  assert.equal(gatewayFromProcRoute('Iface\tDestination\tGateway\tFlags\neth0\t00000000\t01E0A8C0\t0003\n'), '192.168.224.1');
});

test('adds the current Linux gateway after a stale configured IPv4 hub', () => {
  assert.deepEqual(
    hubUrlCandidates('http://172.21.48.1:17321', { platform: 'linux', gateway: '192.168.224.1' }),
    ['http://172.21.48.1:17321', 'http://192.168.224.1:17321']
  );
});

test('does not rewrite hostnames or Windows endpoints', () => {
  assert.deepEqual(hubUrlCandidates('http://token-monitor.local:17321', { platform: 'linux', gateway: '192.168.224.1' }), ['http://token-monitor.local:17321']);
  assert.deepEqual(hubUrlCandidates('http://172.21.48.1:17321', { platform: 'win32', gateway: '192.168.224.1' }), ['http://172.21.48.1:17321']);
});

test('only network failures are eligible for endpoint fallback', () => {
  assert.equal(isHubNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } })), true);
  assert.equal(isHubNetworkError(new Error('Hub responded 401: unauthorized')), false);
});
