import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'

// 隔离数据库 + 本地模拟 Seedream 接口：验证故事板出图请求与回写，不调用真实服务
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-board-img-'))
process.env.SQLITE_PATH = path.join(root, 'board-img.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#336699' } }).png().toBuffer()
await fs.mkdir(path.join(root, 'static'), { recursive: true })
await fs.writeFile(path.join(root, 'static', 'scene.png'), png)
await fs.writeFile(path.join(root, 'static', 'chen.png'), png)

const requests: any[] = []
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.endsWith('/images/generations')) {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      requests.push(JSON.parse(raw))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ url: `${base}/out.png` }] }))
    })
    return
  }
  if (req.url === '/out.png') { res.setHeader('Content-Type', 'image/png'); res.end(png); return }
  res.writeHead(404).end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`

const { db, schema } = await import('../src/db/index.ts')
const { generateBoardImage, listBoardVersions, reviewBoard, videoReferenceBoardImage } = await import('../src/services/board-image.ts')

const ts = new Date().toISOString()
db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'volcengine', name: 'mock', baseUrl: base, apiKey: 'k', model: '["doubao-seedream-test"]', isActive: true, priority: 1, createdAt: ts, updatedAt: ts }).run()
const drama = db.insert(schema.dramas).values({ title: 'd', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'e', scriptContent: '## S02 | 内景 · 指挥所 | 深夜', createdAt: ts, updatedAt: ts }).returning().get()
db.insert(schema.episodeScriptScenes).values({ episodeId: episode.id, sceneNo: 'S02', heading: '内景 · 指挥所 | 深夜', sortOrder: 2, createdAt: ts, updatedAt: ts }).run()
const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '指挥所', time: '深夜', prompt: 'p', imageUrl: 'static/scene.png', createdAt: ts, updatedAt: ts }).returning().get()
const chen = db.insert(schema.characters).values({ dramaId: drama.id, name: '陈将军', imageUrl: 'static/chen.png', createdAt: ts, updatedAt: ts }).returning().get()
const board = {
  start_state: '开始', end_state: '结束',
  shots: [
    { no: 1, start: 0, end: 5, size: '中景', beats: [{ code: '1A', action: '陈将军俯身' }] },
    { no: 2, start: 5, end: 11, size: '特写', beats: [{ code: '2A', action: '手指划过' }, { code: '2B', action: '抬眼' }] },
  ],
}
const sb = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, scriptScene: 'S02', sceneId: scene.id, duration: 11, board: JSON.stringify(board), boardStatus: 'draft', createdAt: ts, updatedAt: ts }).returning().get()
db.insert(schema.storyboardCharacters).values({ storyboardId: sb.id, characterId: chen.id }).run()

test('board image: Seedream request carries size and reference images; result becomes current version pending review', async () => {
  const { versionId, taskId } = await generateBoardImage(sb.id)
  const deadline = Date.now() + 15000
  let task
  while (Date.now() < deadline) {
    task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
    if (task?.status !== 'processing') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(task?.status, 'completed', task?.errorMsg || '')
  assert.equal(requests.length, 1)
  const body = requests[0]
  assert.equal(body.size, '3024x1296') // 3 格 → 21:9
  assert.ok(Array.isArray(body.image) && body.image.length === 2, 'scene + character references')
  assert.match(body.image[0], /^data:image\//)
  assert.equal('watermark' in body, false) // 保留 Ark 默认的「AI生成」角标（合规）
  assert.match(body.prompt, /「内景 指挥所 - 深夜｜11秒」/)
  assert.match(body.prompt, /图1是场景「指挥所」；图2是人物「陈将军」/)

  const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).get()!
  assert.equal(fresh.boardVersionId, versionId)
  assert.equal(fresh.boardStatus, 'pending')
  assert.match(fresh.boardImageUrl!, /^static\/images\//)
  assert.equal(fresh.composedImage, null) // 故事板图不覆盖分镜合成图
  const versions = await listBoardVersions(sb.id)
  assert.deepEqual(versions.map(v => [v.version, v.status]), [[1, 'completed']])
})

test('approving a board generates a clean keyframe image used as the video reference', async () => {
  const [sb0] = db.select().from(schema.storyboards).all()
  assert.equal(await videoReferenceBoardImage(sb0.id), null) // 净版未生成前不挂故事板参考
  await reviewBoard(sb0.id, 'approved')
  const version = db.select().from(schema.storyboardBoardVersions).where(eq(schema.storyboardBoardVersions.storyboardId, sb0.id)).get()!
  assert.ok(version.cleanTaskId)
  const deadline = Date.now() + 15000
  let task
  while (Date.now() < deadline) {
    task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, version.cleanTaskId!)).get()
    if (task?.status !== 'processing') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(task?.status, 'completed', task?.errorMsg || '')
  const body = requests[1]
  assert.equal(body.size, '4096x768') // 3 格 16:9 横向拼接，总宽封顶 4096
  assert.equal(typeof body.image, 'string') // 只参考故事板图本身
  assert.match(body.prompt, /彻底去掉所有文字/)
  const fresh = db.select().from(schema.storyboardBoardVersions).where(eq(schema.storyboardBoardVersions.id, version.id)).get()!
  assert.match(fresh.cleanImageUrl!, /^static\/images\//)
  assert.equal(await videoReferenceBoardImage(sb0.id), fresh.cleanImageUrl)
  // 净版不改变当前故事板图与审核状态
  const sbAfter = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb0.id)).get()!
  assert.equal(sbAfter.boardImageUrl, version.imageUrl)
  assert.equal(sbAfter.boardStatus, 'approved')
  server.close()
})
