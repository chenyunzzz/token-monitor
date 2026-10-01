'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHubEndpointSender, gatewayFromProcRoute, hubUrlCandidates, isHubNetworkError } = require('../../src/shared/hubEndpoint');

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

test('reuses a successful fallback only while the freshly discovered gateways match', async () => {
  const configured = 'http://192.168.224.1:17321';
  let gatewayHex = '01F015AC'; // 172.21.240.1
  const attempts = [];
  const fallbacks = [];
  const send = createHubEndpointSender(configured, {
    platform: 'linux',
    readFileSync: () => `Iface Destination Gateway Flags\neth0 00000000 ${gatewayHex} 0003\n`,
    onFallback: (endpoint, nextEndpoint) => fallbacks.push([endpoint, nextEndpoint])
  });
  const post = async (endpoint) => {
    attempts.push(endpoint);
    if (endpoint === configured) throw Object.assign(new Error('unreachable'), { code: 'ETIMEDOUT' });
    return 'accepted';
  };
  assert.equal(await send(post), 'accepted');
  assert.deepEqual(attempts.splice(0), [configured, 'http://172.21.240.1:17321']);
  assert.equal(await send(post), 'accepted');
  assert.deepEqual(attempts.splice(0), ['http://172.21.240.1:17321']);

  gatewayHex = '010014AC'; // 172.20.0.1
  await send(post);
  assert.deepEqual(attempts.splice(0), [configured, 'http://172.20.0.1:17321']);
  await send(post);
  assert.deepEqual(attempts.splice(0), ['http://172.20.0.1:17321']);

  gatewayHex = 'not-a-route'; // no usable gateway in these candidates
  await assert.rejects(send(post), /unreachable/);
  assert.deepEqual(attempts.splice(0), [configured]);
  assert.equal(fallbacks.length, 2);
});

test('a failed preferred endpoint can fall back and promote the configured endpoint', async () => {
  const configured = 'http://192.168.224.1:17321';
  const gateway = 'http://172.21.240.1:17321';
  const send = createHubEndpointSender(configured, { platform: 'linux', gateway: '172.21.240.1' });
  await send(async (endpoint) => {
    if (endpoint === configured) throw new TypeError('fetch failed');
  });
  const attempts = [];
  await send(async (endpoint) => {
    attempts.push(endpoint);
    if (endpoint === gateway) throw new TypeError('fetch failed');
  });
  assert.deepEqual(attempts, [gateway, configured]);
  await send(async (endpoint) => assert.equal(endpoint, configured));
});

test('application, authentication and response parsing failures never try another endpoint', async () => {
  for (const error of [new Error('Hub responded 401: unauthorized'), new Error('Hub responded 500: failed'), new SyntaxError('Invalid JSON')]) {
    const configured = 'http://192.168.224.1:17321';
    const send = createHubEndpointSender(configured, { platform: 'linux', gateway: '172.21.240.1' });
    let attempts = 0;
    await assert.rejects(send(async (endpoint) => {
      assert.equal(endpoint, configured);
      attempts += 1;
      throw error;
    }), (actual) => actual === error);
    assert.equal(attempts, 1);

    await send(async (endpoint) => {
      if (endpoint === configured) throw new TypeError('fetch failed');
    });
    attempts = 0;
    await assert.rejects(send(async (endpoint) => {
      assert.equal(endpoint, 'http://172.21.240.1:17321');
      attempts += 1;
      throw error;
    }), (actual) => actual === error);
    assert.equal(attempts, 1);
  }
});
