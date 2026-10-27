import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SHIPPED_HASHES_FILE, sha256, syncWorkspaceTemplate } from '../src/template-sync.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-sync-'))
  const tpl = path.join(root, 'template')
  const dest = path.join(root, 'dest')
  const write = (base: string, rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true })
    fs.writeFileSync(path.join(base, rel), content)
  }
  return { root, tpl, dest, write }
}

test('upgrades skill files the user never edited, keeps edited ones and new user skills', () => {
  const { tpl, dest, write } = setup()
  const oldShipped = 'old skill v1'
  write(tpl, 'prompts/a.md', 'prompt v2')
  write(tpl, 'skills/x/SKILL.md', 'skill x v2')
  write(tpl, 'skills/y/SKILL.md', 'skill y v2')
  write(tpl, SHIPPED_HASHES_FILE, JSON.stringify({
    'skills/x/SKILL.md': [sha256(oldShipped), sha256('skill x v2')],
    'skills/y/SKILL.md': [sha256(oldShipped), sha256('skill y v2')],
  }))
  write(dest, '.template-version', '4')
  write(dest, 'prompts/a.md', 'prompt v1 edited')
  write(dest, 'skills/x/SKILL.md', oldShipped) // 未改动的旧发布版 → 升级
  write(dest, 'skills/y/SKILL.md', 'user edited y') // 用户改过 → 保留
  write(dest, 'skills/mine/SKILL.md', 'user skill') // 用户新建 → 保留

  const upgraded = syncWorkspaceTemplate(tpl, dest, '5')

  assert.deepEqual(upgraded, ['skills/x/SKILL.md'])
  assert.equal(fs.readFileSync(path.join(dest, 'skills/x/SKILL.md'), 'utf8'), 'skill x v2')
  assert.equal(fs.readFileSync(path.join(dest, 'skills/y/SKILL.md'), 'utf8'), 'user edited y')
  assert.equal(fs.readFileSync(path.join(dest, 'skills/mine/SKILL.md'), 'utf8'), 'user skill')
  assert.equal(fs.readFileSync(path.join(dest, 'prompts/a.md'), 'utf8'), 'prompt v2')
  assert.equal(fs.existsSync(path.join(dest, SHIPPED_HASHES_FILE)), false)
  assert.equal(fs.readFileSync(path.join(dest, '.template-version'), 'utf8'), '5')
})

test('same version marker skips sync entirely', () => {
  const { tpl, dest, write } = setup()
  write(tpl, 'prompts/a.md', 'prompt v2')
  write(tpl, 'skills/x/SKILL.md', 'skill x v2')
  write(dest, '.template-version', '5')
  write(dest, 'prompts/a.md', 'prompt edited')

  assert.deepEqual(syncWorkspaceTemplate(tpl, dest, '5'), [])
  assert.equal(fs.readFileSync(path.join(dest, 'prompts/a.md'), 'utf8'), 'prompt edited')
  assert.equal(fs.existsSync(path.join(dest, 'skills/x/SKILL.md')), false)
})

test('first start copies everything without the hashes file', () => {
  const { tpl, dest, write } = setup()
  write(tpl, 'prompts/a.md', 'prompt v2')
  write(tpl, 'skills/x/SKILL.md', 'skill x v2')
  write(tpl, SHIPPED_HASHES_FILE, '{}')

  syncWorkspaceTemplate(tpl, dest, '5')
  assert.equal(fs.readFileSync(path.join(dest, 'skills/x/SKILL.md'), 'utf8'), 'skill x v2')
  assert.equal(fs.existsSync(path.join(dest, SHIPPED_HASHES_FILE)), false)
})
