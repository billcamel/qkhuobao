import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-voice-bind-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'huobao.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
fs.mkdirSync(path.join(root, 'static', 'uploads'), { recursive: true })
fs.writeFileSync(path.join(root, 'static', 'uploads', 'ref.mp3'), Buffer.from('ID3'))

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const {
  clearCharacterVoice,
  generateCharacterVoiceFromPortrait,
  listLocalReferenceAudios,
  previewCharacterVoice,
  setCharacterVoice,
} = await import('../src/services/voice/service.ts')

test('a character voice is the local audio file, and portrait generation does not call a provider without config', async () => {
  const ts = new Date().toISOString()
  const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '试播', createdAt: ts, updatedAt: ts }))
  const id = getInsertId(await db.insert(schema.characters).values({
    dramaId,
    name: '林小雨',
    role: '女主',
    createdAt: ts,
    updatedAt: ts,
  }))

  await assert.rejects(() => setCharacterVoice(id, { provider: 'minimax', voice_id: 'female-shaonv' }), /不再绑定远程音色/)
  await assert.rejects(() => previewCharacterVoice(id, { voice_id: 'alloy' }), /请先生成角色形象/)
  await assert.rejects(() => generateCharacterVoiceFromPortrait(id, {}), /请先生成角色形象/)

  const bound = await setCharacterVoice(id, {
    audio_url: 'static/uploads/ref.mp3',
    name: '林小雨参考.mp3',
    source: 'library',
  })
  assert.equal(bound.voice.provider, 'local')
  assert.equal(bound.voice.voice_id, 'local:ref.mp3')
  assert.equal(bound.voice.audio_url, 'static/uploads/ref.mp3')
  assert.equal(bound.voice.source, 'library')
  assert.equal(bound.voice.name, '林小雨参考.mp3')
  assert.equal(JSON.stringify(bound).includes('female-shaonv'), false)

  const library = await listLocalReferenceAudios()
  assert.ok(library.items.some(item => item.audio_url === 'static/uploads/ref.mp3' && item.name === '林小雨参考.mp3'))

  await db.update(schema.characters).set({ imageUrl: 'static/images/face.png' }).where(eq(schema.characters.id, id))
  await assert.rejects(() => previewCharacterVoice(id, { voice_id: 'alloy' }), /未配置视频模型/)
  await assert.rejects(() => generateCharacterVoiceFromPortrait(id, {}), /未配置语音合成/)
  const [still] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(still.voicePreviewUrl, 'static/uploads/ref.mp3')

  const cleared = await clearCharacterVoice(id)
  assert.equal(cleared.voice, null)
  assert.equal(cleared.voice_preview_url, null)
})
