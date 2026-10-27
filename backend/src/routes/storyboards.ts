import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { generateStoryboardVideoPrompt } from '../services/video-prompts.js'
import { boardSchema } from '../services/board.js'
import { updateStoryboardBoard } from '../services/board-store.js'
import { BOARD_REVIEW_STATUSES, generateBoardImage, listBoardVersions, reviewBoard, selectBoardVersion } from '../services/board-image.js'

const app = new Hono()

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  await db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))


  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    await db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    })
  }
}

async function getStoryboardCharacterIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  return links.map(link => link.characterId)
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  await db.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))

  const uniqueIds = [...new Set((propIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const propId of uniqueIds) {
    await db.insert(schema.storyboardProps).values({
      storyboardId,
      propId,
    })
  }
}

async function getStoryboardPropIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  return links.map(link => link.propId)
}

async function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined) {
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = new Set(sceneLinks.map(link => link.sceneId))
  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharacterIds = new Set(characterLinks.map(link => link.characterId))
  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = new Set(propLinks.map(link => link.propId))

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error('scene_id 必须来自当前集已关联场景')
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error('character_ids 必须来自当前集已关联角色')
  }

  const invalidPropIds = (propIds || []).filter(id => !episodePropIds.has(id))
  if (invalidPropIds.length) {
    throw new Error('prop_ids 必须来自当前集已关联道具')
  }
}

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: body.storyboard_number || 1,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  await validateStoryboardBindings(body.episode_id, body.scene_id, body.character_ids, body.prop_ids)
  const res = await db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber: body.storyboard_number || 1,
    title: body.title,
    description: body.description,
    sceneId: body.scene_id,
    duration: body.duration || 10,
    createdAt: ts,
    updatedAt: ts,
  })
  await syncStoryboardCharacters(getInsertId(res), body.character_ids || [])
  await syncStoryboardProps(getInsertId(res), body.prop_ids || [])
  const [result] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, getInsertId(res)))
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: await getStoryboardCharacterIds(result.id),
    prop_ids: await getStoryboardPropIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', duration: 'duration',
    video_prompt: 'videoPrompt',
    image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
    video_url: 'videoUrl',
  }

  const updates: Record<string, any> = { updatedAt: now() }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = body[snakeKey]
  }

  await validateStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : await getStoryboardCharacterIds(id),
    'prop_ids' in body ? body.prop_ids : await getStoryboardPropIds(id),
  )

  await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id))
  if ('character_ids' in body) await syncStoryboardCharacters(id, body.character_ids || [])
  if ('prop_ids' in body) await syncStoryboardProps(id, body.prop_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
    propIds: body.prop_ids,
  })
  return success(c)
})

// POST /storyboards/:id/generate-video-prompt — 为单个分镜生成并保存 video_prompt（同步返回）
app.post('/:id/generate-video-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb) return badRequest(c, '分镜不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) return badRequest(c, '剧集不存在')
  try {
    logTaskStart('VideoPrompt', 'single', { storyboardId: id, episodeId: ep.id })
    const videoPrompt = await generateStoryboardVideoPrompt(sb, ep.dramaId, {
      model: body.model || undefined,
      configId: body.config_id ?? undefined,
      videoLabel: typeof body.video_model_label === 'string' && body.video_model_label.trim() ? body.video_model_label.trim() : undefined,
    })
    logTaskSuccess('VideoPrompt', 'single', { storyboardId: id })
    return success(c, { video_prompt: videoPrompt })
  } catch (err: any) {
    logTaskError('VideoPrompt', 'single', { storyboardId: id, error: err?.message })
    return badRequest(c, err?.message || '视频提示词生成失败')
  }
})

// PUT /storyboards/:id/board — 编辑故事板：校验结构、重新推导 description / video_prompt，审核状态回到 draft
app.put('/:id/board', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const parsed = boardSchema.safeParse(body.board)
  if (!parsed.success) return badRequest(c, `故事板格式不正确：${parsed.error.issues[0]?.message || ''}`)
  try {
    const warnings = await updateStoryboardBoard(id, parsed.data, {
      duration: typeof body.duration === 'number' ? body.duration : undefined,
      atmosphere: typeof body.atmosphere === 'string' ? body.atmosphere : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    })
    return success(c, { warnings })
  } catch (err: any) {
    return badRequest(c, err?.message || '保存失败')
  }
})

// POST /storyboards/:id/board-image — 生成新一版故事板图（异步生图任务）
app.post('/:id/board-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  try {
    const r = await generateBoardImage(id, { configId: body.config_id ?? undefined, model: body.model || undefined })
    return success(c, { version_id: r.versionId, task_id: r.taskId })
  } catch (err: any) {
    return badRequest(c, err?.message || '出图失败')
  }
})

// GET /storyboards/:id/board-versions — 故事板图版本（新的在前）
app.get('/:id/board-versions', async (c) => {
  return success(c, await listBoardVersions(Number(c.req.param('id'))))
})

// POST /storyboards/:id/board-versions/:vid/select — 选定版本为当前故事板
app.post('/:id/board-versions/:vid/select', async (c) => {
  try {
    await selectBoardVersion(Number(c.req.param('id')), Number(c.req.param('vid')))
    return success(c)
  } catch (err: any) {
    return badRequest(c, err?.message || '切换失败')
  }
})

// POST /storyboards/:id/board-review — 审核故事板（approved / rejected / pending）
app.post('/:id/board-review', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!BOARD_REVIEW_STATUSES.includes(body.status)) return badRequest(c, 'status 只支持 approved / rejected / pending')
  try {
    await reviewBoard(Number(c.req.param('id')), body.status)
    return success(c)
  } catch (err: any) {
    return badRequest(c, err?.message || '审核失败')
  }
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id })
  await db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id))
  await db.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, id))
  await db.delete(schema.storyboards).where(eq(schema.storyboards.id, id))
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id })
  return success(c)
})

export default app
