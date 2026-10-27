import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// 隔离数据库，不读写用户数据
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-workflow-'))
process.env.SQLITE_PATH = path.join(root, 'workflow.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const refs = await import('../src/services/storyboard-refs.ts')
const snapshots = await import('../src/services/storyboard-snapshots.ts')
const agentTasks = await import('../src/services/agent-tasks.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const { GENERATED_DEFAULT_PROMPTS } = await import('../src/agents/default-prompts.generated.ts')
const { parsePromptFile } = await import('../src/agents/prompts.ts')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: 'd', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'e', scriptContent: '剧本', createdAt: ts, updatedAt: ts }).returning().get()
const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '咖啡厅', time: '黄昏', prompt: 'p', imageUrl: 'static/scene.png', createdAt: ts, updatedAt: ts }).returning().get()
const ming = db.insert(schema.characters).values({ dramaId: drama.id, name: '小明', imageUrl: 'static/ming.png', createdAt: ts, updatedAt: ts }).returning().get()
const hong = db.insert(schema.characters).values({ dramaId: drama.id, name: 'Lin Xiaoyu', createdAt: ts, updatedAt: ts }).returning().get()
const ctx = { requestContext: buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id }) } as any

test('default prompts are generated from the prompt files', () => {
  for (const type of ['script_rewriter', 'extractor', 'storyboard_breaker', 'prompt_generator']) {
    const file = parsePromptFile(readFileSync(new URL(`../workspace/prompts/${type}.md`, import.meta.url), 'utf8'))
    assert.equal(GENERATED_DEFAULT_PROMPTS[type].instructions, file.instructions, `${type} 与 prompt 文件不一致，请运行 npm run sync-prompts`)
    assert.equal(GENERATED_DEFAULT_PROMPTS[type].name, file.name)
  }
})

test('@ references: longest-name match, names with spaces, invalid refs reported', () => {
  const names = ['咖啡厅', '小明', '小明哥', 'Lin Xiaoyu']
  assert.deepEqual(refs.findInvalidRefs('@小明哥走进@咖啡厅，@Lin Xiaoyu 抬头', names), [])
  assert.deepEqual(refs.findInvalidRefs('@小红，推门；@小红。@咖啡厅', names), ['小红'])
  // 未知名字后无分隔符时无法确定名字边界：报出整段片段（警告里会附可引用名单）
  assert.deepEqual(refs.findInvalidRefs('@小红推门', names), ['小红推门'])
  const assets = [
    { kind: 'scene', id: 1, name: '咖啡厅', imageUrl: 'a' },
    { kind: 'character', id: 2, name: '小明', imageUrl: 'b' },
    { kind: 'character', id: 3, name: 'Lin Xiaoyu', imageUrl: 'c' },
  ] as const
  assert.equal(
    refs.resolvePromptRefs('@咖啡厅，@小明说话，@Lin Xiaoyu 回头，@小红没有图', [...assets]),
    '@图片1咖啡厅，@图片2小明说话，@图片3Lin Xiaoyu 回头，@小红没有图',
  )
})

test('dialogue floor and duration warnings', () => {
  // 45 字台词 ≈ 10 秒 + 2 秒余量 > 10 秒
  const line = '我'.repeat(45)
  const warnings = refs.checkStoryboardDraft({
    shotNumber: 3, duration: 10, description: `【镜头1】小明说：「${line}」`, videoPrompt: '@小明', refNames: ['小明'],
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /约需 12 秒/)
  assert.deepEqual(refs.checkStoryboardDraft({
    shotNumber: 1, duration: 12, description: '【镜头1】小明说：「你好」', videoPrompt: '@小明', refNames: ['小明'],
  }), [])
  const many = refs.checkStoryboardDraft({ shotNumber: 2, duration: 20, description: '', videoPrompt: '', refNames: [] })
  assert.equal(many.length, 2) // 时长越界 + 缺 video_prompt
})

test('save_storyboards snapshots old storyboards on replace and returns warnings', async () => {
  const first = await storyboardTools.saveStoryboards.execute!({
    replace_existing: true,
    storyboards: [
      { shot_number: 1, duration: 10, description: '【镜头1】小明坐着', video_prompt: '@咖啡厅 @小明 坐着', scene_id: scene.id, character_ids: [ming.id] },
      { shot_number: 2, duration: 10, description: '【镜头1】小红推门', video_prompt: '@小红 推门', scene_id: scene.id, character_ids: [ming.id] },
    ],
  }, ctx) as any
  assert.equal(first.count, 2)
  assert.equal(first.warnings.length, 1)
  assert.match(first.warnings[0], /@小红/)
  db.update(schema.storyboards).set({ videoUrl: 'static/v1.mp4' }).where(eq(schema.storyboards.storyboardNumber, 1)).run()
  const oldIds = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all().map(r => r.id)

  // 重新拆分：旧分镜进快照
  await storyboardTools.saveStoryboards.execute!({
    replace_existing: true,
    storyboards: [{ shot_number: 1, duration: 9, description: '【镜头1】新', video_prompt: '@咖啡厅', scene_id: scene.id, character_ids: [] }],
  }, ctx)
  const list = snapshots.listStoryboardSnapshots(episode.id)
  assert.equal(list.length, 1)
  assert.equal(list[0].storyboardCount, 2)
  assert.equal(list[0].videoCount, 1)

  // 恢复：按原 ID 回填，当前分镜先留存
  assert.equal(snapshots.restoreStoryboardSnapshot(episode.id, list[0].id), 2)
  const restored = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all()
  assert.deepEqual(restored.map(r => r.id).sort(), oldIds.sort())
  assert.equal(restored.find(r => r.storyboardNumber === 1)?.videoUrl, 'static/v1.mp4')
  const links = db.select().from(schema.storyboardCharacters).all().filter(l => oldIds.includes(l.storyboardId))
  assert.equal(links.length, 2)
  assert.equal(snapshots.listStoryboardSnapshots(episode.id)[0].reason, 'before-restore')
})

test('read_storyboard_detail is lean and save_video_prompt validates refs', async () => {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.storyboardNumber, 2)).all()
  const detail = await storyboardTools.readStoryboardDetail.execute!({ storyboard_id: sb.id }, ctx) as any
  assert.equal(detail.storyboard.id, sb.id)
  assert.deepEqual(detail.allowed_ref_names, ['咖啡厅', '小明'])
  assert.equal(detail.previous.shot_number, 1)
  assert.equal(detail.next, null)
  assert.equal('script' in detail, false)

  const bad = await storyboardTools.saveVideoPrompt.execute!({ storyboard_id: sb.id, video_prompt: '@Lin Xiaoyu 推门' }, ctx) as any
  assert.equal(bad.saved, true)
  assert.match(bad.warnings[0], /@Lin 不在本分镜绑定的素材中.*可引用：咖啡厅、小明/)
  const ok = await storyboardTools.saveVideoPrompt.execute!({ storyboard_id: sb.id, video_prompt: '@咖啡厅，@小明 推门' }, ctx) as any
  assert.deepEqual(ok, { saved: true })
  const empty = await storyboardTools.saveVideoPrompt.execute!({ storyboard_id: sb.id, video_prompt: ' ' }, ctx) as any
  assert.ok(empty.error)

  // 参考图顺序：场景 → 角色；无图角色（hong）不占序号
  db.insert(schema.storyboardCharacters).values({ storyboardId: sb.id, characterId: hong.id }).run()
  const b = (await refs.loadStoryboardBindings(sb.id))!
  const assets = refs.orderedReferenceAssets(b, 9)
  assert.deepEqual(assets.map(a => a.imageUrl), ['static/scene.png', 'static/ming.png'])
  assert.equal(refs.resolvePromptRefs(b.storyboard.videoPrompt!, assets), '@图片1咖啡厅，@图片2小明 推门')
})

test('agent tasks: one running per episode/kind/target, failures recorded, interrupted on restart', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const a = await agentTasks.startAgentTask({ kind: 'extract', agentType: 'extractor', target: 'props', dramaId: drama.id, episodeId: episode.id },
    async (progress) => { await progress.setTotal(2); await progress.step(true); await gate; return { ok: 1 } })
  const dup = await agentTasks.startAgentTask({ kind: 'extract', agentType: 'extractor', target: 'props', dramaId: drama.id, episodeId: episode.id },
    async () => ({}))
  assert.equal(a.started, true)
  assert.equal(dup.started, false)
  assert.equal(dup.task.id, a.task.id)
  const other = await agentTasks.startAgentTask({ kind: 'extract', agentType: 'extractor', target: 'scenes', dramaId: drama.id, episodeId: episode.id },
    async () => { throw new Error('boom') })
  assert.equal(other.started, true)

  release()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [x, y] = [await agentTasks.getAgentTask(a.task.id), await agentTasks.getAgentTask(other.task.id)]
    if (x?.status !== 'running' && y?.status !== 'running') break
    await new Promise(r => setTimeout(r, 10))
  }
  const done = agentTasks.serializeAgentTask(await agentTasks.getAgentTask(a.task.id))!
  assert.equal(done.status, 'done')
  assert.equal(done.completed, 1)
  assert.deepEqual(done.result, { ok: 1 })
  const failed = await agentTasks.getAgentTask(other.task.id)
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.error, 'boom')

  // 模拟进程重启：遗留 running 记录被标记为 interrupted
  db.insert(schema.agentTasks).values({ kind: 'breakdown', agentType: 'storyboard_breaker', dramaId: drama.id, episodeId: episode.id, status: 'running', createdAt: ts, updatedAt: ts }).run()
  await agentTasks.markInterruptedAgentTasks()
  assert.equal((await agentTasks.latestAgentTask(episode.id, 'breakdown'))?.status, 'interrupted')
  assert.equal((await agentTasks.runningAgentTasks(episode.id)).length, 0)
})

test('calledTools normalizes Mastra tool keys to tool ids', async () => {
  const { calledTools, toToolId } = await import('../src/services/agent-runner.ts')
  assert.equal(toToolId('saveScript'), 'save_script')
  assert.equal(toToolId('saveDedupCharacters'), 'save_dedup_characters')
  assert.equal(toToolId('save_storyboards'), 'save_storyboards')
  const result = { steps: [{ toolCalls: [{ payload: { toolName: 'readEpisodeScript' } }] }, { toolCalls: [{ toolName: 'saveScript' }] }] }
  assert.deepEqual(calledTools(result).sort(), ['read_episode_script', 'save_script'])
})

test('API keys with non-ASCII or whitespace are rejected with a readable message', async () => {
  const { apiKeyProblem, assertUsableApiKey } = await import('../src/services/ai.ts')
  assert.equal(apiKeyProblem('sk-abc_123.XYZ'), null)
  assert.equal(apiKeyProblem(''), null)
  assert.match(apiKeyProblem('ab湘江战役')!, /非法字符/)
  assert.match(apiKeyProblem('sk abc')!, /非法字符/)
  assert.ok(apiKeyProblem('ab湘江战役')!.length <= 40) // 前端只原样透传 40 字以内的中文提示
  assert.throws(() => assertUsableApiKey({ apiKey: '中文' }), /重新填写/)
})
