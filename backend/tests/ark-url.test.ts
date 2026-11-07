import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinArkUrl } from '../src/services/adapters/url.ts'

test('Ark 标准地址补 /api/v3', () => {
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com', '/images/generations'), 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/', ''), 'https://ark.cn-beijing.volces.com/api/v3')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/v3', '/contents/generations/tasks'), 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
})

test('Ark 订阅包前缀（Agent Plan / Coding Plan）原样保留', () => {
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/plan/v3', '/contents/generations/tasks'), 'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/plan/v3/', '/images/generations/abc'), 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations/abc')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/plan/v3', ''), 'https://ark.cn-beijing.volces.com/api/plan/v3')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/coding/v3', '/chat/completions'), 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions')
})

test('中转站带前缀路径时仍补 /api/v3', () => {
  assert.equal(joinArkUrl('https://relay.example.com/volcengine', '/images/generations'), 'https://relay.example.com/volcengine/api/v3/images/generations')
})

test('Base URL 误填完整接口地址时自动剥掉接口路径', () => {
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations', '/images/generations'), 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations', '/images/generations/t1'), 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations/t1')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/', '/contents/generations/tasks'), 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
  assert.equal(joinArkUrl('https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions', ''), 'https://ark.cn-beijing.volces.com/api/plan/v3')
})
