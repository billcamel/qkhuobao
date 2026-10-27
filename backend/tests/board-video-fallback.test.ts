import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'

// 隔离数据库 + 模拟 Seedance：带故事板关键帧的提交被真人隐私审核拒绝 → 自动去掉故事板参考重提
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-board-fallback-'))
process.env.SQLITE_PATH = path.join(root, 'fallback.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.FFMPEG_BIN = '/usr/bin/false'
process.env.FFPROBE_BIN = '/usr/bin/false'

const png = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#555' } }).png().toBuffer()
await fs.mkdir(path.join(root, 'static'), { recursive: true })
for (const f of ['clean.png', 'scene.png', 'chen.png']) await fs.writeFile(path.join(root, 'static', f), png)
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])

const submissions: any[] = []
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.endsWith('/contents/generations/tasks')) {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw)
      submissions.push(body)
      res.setHeader('Content-Type', 'application/json')
      const text = body.content.find((c: any) => c.type === 'text')?.text || ''
      if (text.includes('关键画面')) {
        res.writeHead(400).end(JSON.stringify({ error: { code: 'InputImageSensitiveContentDetected.PrivacyInformation', message: 'The request failed because the input image may contain real person.' } }))
        return
      }
      res.end(JSON.stringify({ video_url: `${base}/v.mp4` }))
    })
    return
  }
  if (req.url === '/v.mp4') { res.setHeader('Content-Type', 'video/mp4'); res.end(video); return }
  res.writeHead(404).end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`

const { db, schema } = await import('../src/db/index.ts')
const tasksRoute = (await import('../src/routes/tasks.ts')).default

const ts = new Date().toISOString()
db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'volcengine', name: 'mock', baseUrl: base, apiKey: 'k', model: '["doubao-seedance-2-0-mini-test"]', isActive: true, priority: 1, createdAt: ts, updatedAt: ts }).run()
const drama = db.insert(schema.dramas).values({ title: 'd', style: 'live-war', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'e', createdAt: ts, updatedAt: ts }).returning().get()
const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '指挥所', time: '夜', prompt: 'p', imageUrl: 'static/scene.png', createdAt: ts, updatedAt: ts }).returning().get()
const chen = db.insert(schema.characters).values({ dramaId: drama.id, name: '陈将军', imageUrl: 'static/chen.png', createdAt: ts, updatedAt: ts }).returning().get()
const board = { start_state: '开始', end_state: '结束', shots: [{ no: 1, start: 0, end: 6, size: '近景', beats: [{ code: '1A', action: '陈将军俯身' }] }] }
const sb = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, sceneId: scene.id, duration: 6, board: JSON.stringify(board), boardStatus: 'approved', videoPrompt: '出场人物：@陈将军；场景：@指挥所。\n0-6秒：近景。@陈将军俯身。', createdAt: ts, updatedAt: ts }).returning().get()
db.insert(schema.storyboardCharacters).values({ storyboardId: sb.id, characterId: chen.id }).run()
const v = db.insert(schema.storyboardBoardVersions).values({ storyboardId: sb.id, version: 1, prompt: 'p', imageUrl: 'static/board.png', cleanImageUrl: 'static/clean.png', createdAt: ts }).returning().get()
db.update(schema.storyboards).set({ boardVersionId: v.id }).where(eq(schema.storyboards.id, sb.id)).run()

test('live-action presets are seeded', () => {
  const values = db.select().from(schema.stylePresets).all().map(p => p.value)
  for (const v of ['live-tv', 'live-costume', 'live-cinema', 'live-film', 'live-doc', 'live-war']) assert.ok(values.includes(v), v)
  const war = db.select().from(schema.stylePresets).all().find(p => p.value === 'live-war')!
  assert.match(war.prompt, /do not resemble any real person/)
})

test('privacy rejection with storyboard reference falls back to reference images only', async () => {
  const res = await tasksRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'video', storyboard_id: sb.id, drama_id: drama.id, auto_references: true, duration: 6, aspect_ratio: '16:9' }),
  })
  assert.equal(res.status, 201)
  const first = (await res.json()).data
  const deadline = Date.now() + 15000
  let retry
  while (Date.now() < deadline) {
    retry = db.select().from(schema.sysTask).all().find(t => t.id !== first.id && t.storyboardId === sb.id)
    if (retry?.status === 'completed') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(submissions.length, 2)
  // 第 1 次：净版关键帧 + 场景 + 角色共 3 张，提示词带格序说明 → 被拒
  assert.equal(submissions[0].content.filter((c: any) => c.type === 'image_url').length, 3)
  // 第 2 次：去掉净版，只剩设定图，@图片 编号顺移，不再出现关键画面说明
  const second = submissions[1]
  assert.equal(second.content.filter((c: any) => c.type === 'image_url').length, 2)
  const text = second.content.find((c: any) => c.type === 'text').text
  assert.doesNotMatch(text, /关键画面/)
  assert.match(text, /@图片2陈将军/)
  assert.match(text, /@图片1指挥所/)
  assert.match(text, /period war film/) // 风格词仍在最前
  assert.equal(second.duration, 6)

  const original = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, first.id)).get()!
  assert.equal(original.status, 'failed')
  assert.equal(original.errorCode, 'board_reference_fallback')
  assert.match(original.errorMsg!, /已自动改用设定图参考重新生成（任务 #\d+）/)
  assert.equal(retry?.status, 'completed')
  assert.equal(JSON.parse(retry!.params!).boardFallbackFrom, first.id)
  server.close()
})
