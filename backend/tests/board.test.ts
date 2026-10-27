import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// 隔离数据库，不读写用户数据
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-board-'))
process.env.SQLITE_PATH = path.join(root, 'board.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const board = await import('../src/services/board.ts')
const store = await import('../src/services/board-store.ts')
const boardImage = await import('../src/services/board-image.ts')
const snapshots = await import('../src/services/storyboard-snapshots.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: 'd', createdAt: ts, updatedAt: ts }).returning().get()
const script = '## S01 | 外景 · 湘江岸边 | 黄昏\n\n雾。\n\n## S02 | 内景 · 指挥所 | 深夜\n\n陈将军：（低声）那就等。'
const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'e', scriptContent: script, createdAt: ts, updatedAt: ts }).returning().get()
const post = db.insert(schema.scenes).values({ dramaId: drama.id, location: '指挥所', time: '深夜', prompt: 'p', imageUrl: 'static/post.png', createdAt: ts, updatedAt: ts }).returning().get()
const chen = db.insert(schema.characters).values({ dramaId: drama.id, name: '陈将军', imageUrl: 'static/chen.png', createdAt: ts, updatedAt: ts }).returning().get()
const ctx = { requestContext: buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' }) } as any

const sample: import('../src/services/board.ts').Board = {
  start_state: '深夜指挥所，油灯照亮地图，陈将军俯身桌前',
  end_state: '陈将军抬眼凝视，久久不语',
  shots: [
    { no: 1, start: 0, end: 5, size: '中景', angle: '斜对地图桌，齐胸高', movement: '固定', purpose: '建立空间',
      beats: [{ code: '1A', frame: '陈将军俯身地图桌', action: '油灯火苗微跳，陈将军俯身于地图前', sound: '极静', narration: '第四道封锁线。' }] },
    { no: 2, start: 5, end: 11, size: '特写', angle: '俯向桌面', movement: '缓慢推近',
      beats: [
        { code: '2A', action: '手指划过湘江一线', subject_arrow: '划过' },
        { code: '2B', action: '陈将军抬眼', camera: '镜头继续推近', dialogue: [{ speaker: '陈将军', line: '那就等。' }], camera_arrow: '缓慢推近' },
      ] },
  ],
}

test('checkBoard: contiguous timeline, beat codes, panel limit, duration range', () => {
  assert.deepEqual(board.checkBoard(sample, 11, 1), [])
  const broken = structuredClone(sample)
  broken.shots[1].start = 6
  broken.shots[1].beats[1].code = '2C'
  const w = board.checkBoard(broken, 20, 2)
  assert.ok(w.some(x => /4-15/.test(x)))
  assert.ok(w.some(x => /应从 5 秒开始/.test(x)))
  assert.ok(w.some(x => /拍号应为 2B/.test(x)))
  assert.ok(w.some(x => /与段时长 20 秒不一致/.test(x)))
  const five = structuredClone(sample)
  five.shots[0].beats.push({ code: '1B', action: 'a' }, { code: '1C', action: 'b' })
  five.shots[1].beats.push({ code: '2C', action: 'c' })
  assert.ok(board.checkBoard(five, 11, 3).some(x => /超过 4 格/.test(x)))
})

test('board derives description and shot-timed video prompt with @ references', () => {
  const desc = board.boardToDescription(sample, 'zh')
  assert.match(desc, /^【镜头1】（中景·斜对地图桌，齐胸高·固定）1A 油灯火苗微跳/)
  assert.match(desc, /【镜头2】.*陈将军说：「那就等。」/)
  const vp = board.boardToVideoPrompt(sample, { scene: '指挥所', characters: ['陈将军'], props: [] }, '油灯昏黄', 'zh')
  const lines = vp.split('\n')
  assert.equal(lines[0], '出场人物：@陈将军；场景：@指挥所。')
  assert.match(lines[1], /^0-5秒：中景，斜对地图桌，齐胸高，固定。油灯火苗微跳，@陈将军俯身于地图前/)
  assert.match(lines[2], /^5-11秒：切到特写，俯向桌面，缓慢推近。/)
  assert.equal(lines[3], '氛围：油灯昏黄。')
  assert.equal(board.tagRefNames('@陈将军与陈将军', ['陈将军']), '@陈将军与@陈将军')
})

test('script scene parsing and heading formatting', () => {
  assert.deepEqual(store.parseScriptScenes(script).map(s => [s.no, s.heading]), [['S01', '外景 · 湘江岸边 | 黄昏'], ['S02', '内景 · 指挥所 | 深夜']])
  assert.equal(store.normalizeSceneNo('s2'), 'S02')
  assert.equal(boardImage.boardHeading('内景 · 指挥所 | 深夜', 'x'), '内景 指挥所 - 深夜')
  assert.equal(boardImage.boardImageSize(1), '2304x1728')
  assert.equal(boardImage.boardImageSize(3), '3024x1296')
  assert.equal(boardImage.boardImageSize(1, '9:16'), '1728x2304') // 竖屏短剧：整页收窄一档
  assert.equal(boardImage.boardImageSize(3, '9:16'), '2560x1440')
  // 净版：按项目画幅横向拼接，总宽不超过 4096
  assert.equal(boardImage.cleanBoardSize(1, '9:16'), '1080x1920')
  assert.equal(boardImage.cleanBoardSize(2, '9:16'), '2160x1920')
  assert.equal(boardImage.cleanBoardSize(4, '9:16'), '4096x1824')
  assert.equal(boardImage.cleanBoardSize(2, '16:9'), '3840x1080')
  assert.equal(boardImage.cleanBoardSize(3), '4096x768')
  assert.match(boardImage.buildCleanBoardPrompt(2, '9:16'), /每格画面比例为 9:16（竖幅）/)
})

test('save_boards stores boards per script scene, derives fields, snapshots on replace', async () => {
  const seg = { shot_number: 1, part: 1, title: '地图前', duration: 11, scene_id: post.id, character_ids: [chen.id], atmosphere: '油灯昏黄', board: sample }
  const res = await storyboardTools.saveBoards.execute!({ replace_existing: true, script_scene: { no: 'S02', summary: '决断' }, segments: [seg] }, ctx) as any
  assert.equal(res.warnings, undefined)
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all()
  assert.equal(sb.scriptScene, 'S02')
  assert.equal(sb.boardStatus, 'draft')
  assert.match(sb.videoPrompt!, /@陈将军/)
  assert.match(sb.description!, /【镜头2】/)
  const scenes = await store.listScriptScenes(episode.id)
  assert.deepEqual(scenes.map(s => [s.sceneNo, s.heading, s.summary]), [['S02', '内景 · 指挥所 | 深夜', '决断']])

  // 未知场景号与超时长给出 warnings
  const bad = await storyboardTools.saveBoards.execute!({ script_scene: { no: 'S09', summary: 'x' }, segments: [{ ...seg, shot_number: 2, duration: 20 }] }, ctx) as any
  assert.ok(bad.warnings.some((w: string) => /没有场景 S09/.test(w)))
  assert.ok(bad.warnings.some((w: string) => /4-15/.test(w)))

  // 重新生成：旧分镜与剧本场景分组进入快照，恢复后都回来
  await storyboardTools.saveBoards.execute!({ replace_existing: true, script_scene: { no: 'S01', summary: '空镜' }, segments: [{ ...seg, shot_number: 1, scene_id: null, character_ids: [] }] }, ctx)
  assert.deepEqual((await store.listScriptScenes(episode.id)).map(s => s.sceneNo), ['S01'])
  const [snap] = snapshots.listStoryboardSnapshots(episode.id)
  assert.equal(snap.storyboardCount, 2)
  snapshots.restoreStoryboardSnapshot(episode.id, snap.id)
  assert.deepEqual((await store.listScriptScenes(episode.id)).map(s => s.sceneNo).sort(), ['S02', 'S09'])
})

test('editing a board re-derives fields and resets review status', async () => {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.storyboardNumber, 1)).all()
  db.update(schema.storyboards).set({ boardStatus: 'approved' }).where(eq(schema.storyboards.id, sb.id)).run()
  const edited = structuredClone(sample)
  edited.shots[0].beats[0].action = '陈将军按住地图一角'
  const warnings = await store.updateStoryboardBoard(sb.id, edited)
  assert.deepEqual(warnings, [])
  const [fresh] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).all()
  assert.equal(fresh.boardStatus, 'draft')
  assert.match(fresh.videoPrompt!, /@陈将军按住地图一角/)
})

test('board image prompt lays out the sheet and references bound assets', () => {
  const prompt = boardImage.buildBoardImagePrompt({
    board: sample, heading: '内景 指挥所 - 深夜', duration: 11,
    refs: [{ name: '指挥所', kind: 'scene' }, { name: '陈将军', kind: 'character' }], stylePrompt: 'cinematic', lang: 'zh', aspect: '9:16',
  })
  assert.match(prompt, /共 3 格画面横向等宽并排，每格画面比例为 9:16（竖幅）/)
  assert.match(prompt, /「内景 指挥所 - 深夜｜11秒」/)
  assert.match(prompt, /Shot 1：0-5秒　Shot 2：5-11秒/)
  assert.match(prompt, /第2格：标题栏写「2A｜特写｜5-11秒」，标题栏左上角有红底白字「CUT」/)
  assert.match(prompt, /第3格：标题栏写「2B｜同镜持续」/)
  assert.match(prompt, /红色箭头.*「划过」/)
  assert.match(prompt, /蓝色箭头.*「缓慢推近」/)
  assert.match(prompt, /本段开始：深夜指挥所/)
  assert.match(prompt, /图1是场景「指挥所」；图2是人物「陈将军」/)
  assert.match(prompt, /画面风格：cinematic/)
  // 每格写明出场人物：1A 有陈将军，2A（手指划过）没有设定人物
  assert.match(prompt, /第1格：[^\n]*这一格出场的设定人物：陈将军，每人只画一次/)
  assert.match(prompt, /第2格：[^\n]*这一格没有设定人物出场/) // 「手指划过」写到了手
  const empty = boardImage.buildBoardImagePrompt({
    board: { start_state: 's', end_state: 'e', shots: [{ no: 1, start: 0, end: 4, size: '特写', angle: '侧对雨幕', beats: [{ code: '1A', frame: '雨丝斜斜地穿过画面，雨点打在泥水上', action: '雨打在泥地上' }] }] },
    heading: 'h', duration: 4, refs: [{ name: '泥泞山路', kind: 'scene' }], lang: 'zh',
  })
  assert.match(empty, /第1格：[^\n]*这一格是空镜：画面中没有任何人物/)
  assert.match(empty, /画面（空镜特写，无人物，镜头对准的是景物本身）：雨丝斜斜地穿过画面/)
  assert.doesNotMatch(empty, /侧对雨幕）/) // 空镜不写容易被读成人物朝向的机位角度
  assert.match(prompt, /同一个人物在同一格中只能出现一次/)
})

test('board versions, selection and review', async () => {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.storyboardNumber, 1)).all()
  const v1 = db.insert(schema.storyboardBoardVersions).values({ storyboardId: sb.id, version: 1, prompt: 'p', imageUrl: 'static/b1.png', createdAt: ts }).returning().get()
  db.insert(schema.storyboardBoardVersions).values({ storyboardId: sb.id, version: 2, prompt: 'p', createdAt: ts }).run()
  const versions = await boardImage.listBoardVersions(sb.id)
  assert.deepEqual(versions.map(v => [v.version, v.status]), [[2, 'processing'], [1, 'completed']])
  await boardImage.selectBoardVersion(sb.id, v1.id)
  await boardImage.reviewBoard(sb.id, 'approved')
  const [fresh] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).all()
  assert.equal(fresh.boardImageUrl, 'static/b1.png')
  assert.equal(fresh.boardStatus, 'approved')
  await assert.rejects(boardImage.selectBoardVersion(sb.id, versions[0].id), /还没有出图/)
})
