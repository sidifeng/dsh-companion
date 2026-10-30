import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fetchMedia, isPublicAddress, mediaKind } from '../src/media.js';
import { planMessages, requestedParts } from '../src/replies.js';

test('两句连写也能根据明确条数分成两个气泡，仍受回复预算限制', () => {
  const text = '你好呀，小张张。今天想聊点什么？';
  assert.deepEqual(planMessages(text, 3, 1800, requestedParts('你好，请分两条短句回复')), ['你好呀，小张张。', '今天想聊点什么？']);
  assert.deepEqual(planMessages(text, 1, 1800, 2), [text]);
  assert.deepEqual(planMessages('只有一句。', 3, 1800, 2), ['只有一句。']);
  assert.equal(requestedParts('普通聊天'), undefined);
});

test('媒体类型兼容 QQ 裸值，下载地址拒绝私有/映射/保留 IP', () => {
  for (const type of ['image', 'image/jpeg']) assert.equal(mediaKind(type), 'image');
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '198.18.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

const resolver = async () => [{ address: '1.1.1.1', family: 4 }];
function mockRequest({ status = 200, chunks = ['image'], length } = {}) {
  return (_url, options, callback) => {
    options.lookup('fixture.example', {}, (err, ip, family) => { assert.ifError(err); assert.equal(ip, '1.1.1.1'); assert.equal(family, 4); });
    const req = new EventEmitter();
    queueMicrotask(() => {
      const response = Readable.from(chunks.map(s => Buffer.from(s)));
      response.statusCode = status; response.headers = length ? { 'content-length': String(length) } : {};
      callback(response);
    });
    return req;
  };
}

test('下载使用经过校验的系统 DNS 结果，不依赖 resolve4', async () => {
  const data = await fetchMedia('https://fixture.example/a', { maxBytes: 20, resolveHost: resolver, request: mockRequest() });
  assert.equal(data.toString(), 'image');
  await assert.rejects(fetchMedia('https://fixture.example/a', { maxBytes: 20, resolveHost: async () => [{ address: '127.0.0.1', family: 4 }] }), /ADDRESS_BLOCKED/u);
});

test('媒体下载拒绝重定向、超限声明和超限流，HTTP URL 不能绕过检查', async () => {
  const opts = { maxBytes: 3, resolveHost: resolver };
  await assert.rejects(fetchMedia('https://fixture.example/a', { ...opts, request: mockRequest({ status: 302 }) }), /HTTP_302/u);
  await assert.rejects(fetchMedia('https://fixture.example/a', { ...opts, request: mockRequest({ length: 100 }) }), /TOO_LARGE/u);
  await assert.rejects(fetchMedia('https://fixture.example/a', { ...opts, request: mockRequest({ chunks: ['ab', 'cdef'] }) }), /TOO_LARGE/u);
  await assert.rejects(fetchMedia('http://127.0.0.1/a', opts), /URL_BLOCKED/u);
});
