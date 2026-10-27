/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId } from '../context.js'
import { boundRefNames, checkStoryboardDraft, findInvalidRefs, loadStoryboardBindings } from '../../services/storyboard-refs.js'
import { snapshotAndClearEpisodeStoryboards } from '../../services/storyboard-snapshots.js'
import { boardSchema, checkBoard } from '../../services/board.js'
import { derivedBoardFields, normalizeSceneNo, parseScriptScenes, recomputeEpisodeDuration, upsertScriptScene } from '../../services/board-store.js'

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  await db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))


  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    await db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    })
  }
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  await db.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))

  const uniqueIds = [...new Set(propIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const propId of uniqueIds) {
    await db.insert(schema.storyboardProps).values({
      storyboardId,
      propId,
    })
  }
}

async function getEpisodeSceneIds(episodeId: number) {
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  return new Set(links.map(link => link.sceneId))
}

async function getEpisodeCharacterIds(episodeId: number) {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  return new Set(links.map(link => link.characterId))
}

async function getEpisodePropIds(episodeId: number) {
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  return new Set(links.map(link => link.propId))
}

async function validateStoryboardBindings(episodeId: number, dramaId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined) {
  const episodeSceneIds = await getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = await getEpisodeCharacterIds(episodeId)
  const episodePropIds = await getEpisodePropIds(episodeId)

  // 场景/角色/道具属于本剧但尚未关联到当前集时，自动补关联（拆分时即完成绑定）
  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) {
      throw new Error(`scene_id ${sceneId} 不属于当前项目`)
    }
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() })
  }

  const uniqueCharacterIds = [...new Set((characterIds || []).filter(Boolean))]
  for (const characterId of uniqueCharacterIds) {
    if (episodeCharacterIds.has(characterId)) continue
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
    if (!character || character.dramaId !== dramaId || character.deletedAt) {
      throw new Error(`character_id ${characterId} 不属于当前项目`)
    }
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() })
  }

  const uniquePropIds = [...new Set((propIds || []).filter(Boolean))]
  for (const propId of uniquePropIds) {
    if (episodePropIds.has(propId)) continue
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) {
      throw new Error(`prop_id ${propId} 不属于当前项目`)
    }
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() })
  }
}

/** 本剧资产名索引：用于按 scene_id / character_ids / prop_ids 求分镜可引用的 @名字 */
async function loadDramaAssetNames(dramaId: number) {
  const sceneNames = new Map((await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId)))
    .filter(s => !s.deletedAt).map(s => [s.id, s.location]))
  const characterNames = new Map((await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId)))
    .filter(c => !c.deletedAt).map(c => [c.id, c.name]))
  const propNames = new Map((await db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId)))
    .filter(p => !p.deletedAt).map(p => [p.id, p.name]))
  return (sceneId: number | null | undefined, characterIds: number[] = [], propIds: number[] = []) => [
    sceneId != null ? sceneNames.get(sceneId) : undefined,
    ...characterIds.map(id => characterNames.get(id)),
    ...propIds.map(id => propNames.get(id)),
  ].filter((n): n is string => Boolean(n && n.trim()))
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        reference_images: c.referenceImages || '',
      }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    const existingStoryboardPayload = await Promise.all(existingStoryboards
      .filter(sb => !sb.deletedAt)
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        // 只给摘要：默认整集重拆不需要旧分镜全文，回传全文会成倍放大上下文
        const description = sb.description || ''
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          prop_ids: sbPropLinks.map(link => link.propId),
          duration: sb.duration || 0,
          description: description.length > 120 ? `${description.slice(0, 120)}…` : description,
          has_video: Boolean(sb.videoUrl || sb.composedVideoUrl),
        }
      }))

    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      // 剧本场景（## S01 | 内景 · 地点 | 时间段）：故事板按场景分组，每个场景 1 到多段
      script_scenes: parseScriptScenes(script),
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

const storyboardFields = z.object({
  shot_number: z.number(),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  image_prompt: z.string().optional(),
  video_prompt: z.string().optional(),
  bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(),
  duration: z.number().optional(),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
})

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Save storyboards for this episode. Call in batches of at most 8 storyboards: the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates.',
  inputSchema: z.object({
    replace_existing: z.boolean().optional(),
    storyboards: z.array(storyboardFields),
  }),
  execute: async ({ storyboards, replace_existing }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    logTaskProgress('StoryboardTool', 'save-begin', {
      episodeId,
      dramaId,
      replaceExisting: replace_existing === true,
      count: storyboards.length,
      shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
    })
    if (replace_existing === true) {
      // 旧分镜先留存快照再清空（同一事务），误拆后可在界面整体恢复
      const snapshotId = snapshotAndClearEpisodeStoryboards(episodeId, 'rebreakdown')
      if (snapshotId) logTaskProgress('StoryboardTool', 'snapshot-before-replace', { episodeId, snapshotId })
    }

    // shot_number → id 索引（含本次调用内新增的行），保证按分镜号幂等 upsert
    const existingRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const shotToId = new Map<number, number>(
      existingRows.filter(sb => !sb.deletedAt).map(sb => [sb.storyboardNumber, sb.id]),
    )

    const refNamesOf = await loadDramaAssetNames(dramaId)
    const warnings: string[] = []
    for (const sb of storyboards) {
      await validateStoryboardBindings(episodeId, dramaId, sb.scene_id, sb.character_ids, sb.prop_ids)
      warnings.push(...checkStoryboardDraft({
        shotNumber: sb.shot_number,
        duration: sb.duration,
        description: sb.description,
        videoPrompt: sb.video_prompt,
        refNames: refNamesOf(sb.scene_id, sb.character_ids, sb.prop_ids),
      }))
      const existingId = shotToId.get(sb.shot_number)
      if (existingId !== undefined) {
        await db.update(schema.storyboards).set({
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          updatedAt: ts,
        }).where(eq(schema.storyboards.id, existingId))
        await syncStoryboardCharacters(existingId, sb.character_ids || [])
        await syncStoryboardProps(existingId, sb.prop_ids || [])
      } else {
        const res = await db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: sb.shot_number,
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          createdAt: ts, updatedAt: ts,
        })
        const newId = getInsertId(res)
        shotToId.set(sb.shot_number, newId)
        await syncStoryboardCharacters(newId, sb.character_ids || [])
        await syncStoryboardProps(newId, sb.prop_ids || [])
      }
    }

    // 整集时长 = 当前全部存活分镜时长之和（分批保存时不能再按单批累加）
    const allRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const totalDuration = allRows
      .filter(sb => !sb.deletedAt)
      .reduce((sum, sb) => sum + (sb.duration || 0), 0)

    await db.update(schema.episodes)
      .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId))

    logTaskSuccess('StoryboardTool', 'save-complete', {
      episodeId,
      count: storyboards.length,
      totalDuration,
      warnings: warnings.length || undefined,
    })
    if (warnings.length) logTaskWarn('StoryboardTool', 'save-warnings', { episodeId, warnings })
    return {
      message: `Saved ${storyboards.length} storyboards`,
      count: storyboards.length,
      total_duration: totalDuration,
      ...(warnings.length ? { warnings } : {}),
    }
  },
})

const boardSegmentSchema = z.object({
  shot_number: z.number().int().describe('全集段序号，从 1 起连续递增（跨场景累计）'),
  part: z.number().int().optional().describe('该剧本场景内第几段，从 1 起'),
  title: z.string().describe('3-5 字概括本段'),
  duration: z.number().describe('段时长（秒），等于最后一镜的结束时间'),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
  atmosphere: z.string().optional().describe('光线 + 色调 + 声音 + 整体氛围'),
  board: boardSchema,
})

const saveBoards = createTool({
  id: 'save_boards',
  description: 'Save the storyboard (故事板) segments of ONE script scene. Call once per script scene in script order; the first call of a full regeneration sets replace_existing: true (old storyboards are snapshotted, then cleared). Segments are upserted by shot_number, so re-saving a scene fixes it. description and video_prompt are derived automatically from each board. Returns warnings to fix.',
  inputSchema: z.object({
    replace_existing: z.boolean().optional(),
    script_scene: z.object({
      no: z.string().describe('剧本场景号，如 S01'),
      heading: z.string().optional().describe('场景头，如「内景 · 指挥所 | 深夜」，缺省取剧本'),
      summary: z.string().describe('一句话场景目的，如「牺牲·信念的极致：……」'),
    }),
    segments: z.array(boardSegmentSchema).min(1),
  }),
  execute: async ({ replace_existing, script_scene, segments }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    const scriptScenes = parseScriptScenes(ep?.scriptContent || ep?.content || '')
    const sceneNo = normalizeSceneNo(script_scene.no)
    const known = scriptScenes.find(s => normalizeSceneNo(s.no) === sceneNo)

    if (replace_existing === true) {
      const snapshotId = snapshotAndClearEpisodeStoryboards(episodeId, 'rebreakdown')
      if (snapshotId) logTaskProgress('StoryboardTool', 'snapshot-before-replace', { episodeId, snapshotId })
    }
    await upsertScriptScene(episodeId, {
      no: sceneNo,
      heading: script_scene.heading || known?.heading || sceneNo,
      summary: script_scene.summary,
    })

    const warnings: string[] = []
    if (scriptScenes.length && !known) warnings.push(`剧本中没有场景 ${sceneNo}，请使用 read_storyboard_context 返回的 script_scenes 场景号`)
    const existing = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
    const shotToId = new Map(existing.map(sb => [sb.storyboardNumber, sb.id]))
    const ts = now()
    for (const seg of segments) {
      const characterIds = seg.character_ids || []
      const propIds = seg.prop_ids || []
      await validateStoryboardBindings(episodeId, dramaId, seg.scene_id, characterIds, propIds)
      const derived = await derivedBoardFields(seg.board, {
        duration: seg.duration, atmosphere: seg.atmosphere, sceneId: seg.scene_id, characterIds, propIds,
      })
      const fields = {
        ...derived,
        title: seg.title,
        scriptScene: sceneNo,
        atmosphere: seg.atmosphere,
        sceneId: seg.scene_id ?? null,
      }
      let id = shotToId.get(seg.shot_number)
      if (id !== undefined) {
        await db.update(schema.storyboards).set(fields).where(eq(schema.storyboards.id, id))
      } else {
        const res = await db.insert(schema.storyboards).values({
          episodeId, storyboardNumber: seg.shot_number, ...fields, createdAt: ts,
        })
        id = getInsertId(res)
        shotToId.set(seg.shot_number, id)
      }
      await syncStoryboardCharacters(id, characterIds)
      await syncStoryboardProps(id, propIds)
      warnings.push(...checkBoard(seg.board, seg.duration, seg.shot_number))
    }
    const totalDuration = await recomputeEpisodeDuration(episodeId)
    logTaskSuccess('StoryboardTool', 'boards-saved', {
      episodeId, scene: sceneNo, count: segments.length, totalDuration, warnings: warnings.length || undefined,
    })
    if (warnings.length) logTaskWarn('StoryboardTool', 'board-warnings', { episodeId, warnings })
    return {
      message: `Saved ${segments.length} segments for ${sceneNo}`,
      total_duration: totalDuration,
      ...(warnings.length ? { warnings } : {}),
    }
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    title: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id))
    if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }

    // 过滤模型回传的垃圾值：视频提示词 Agent 常把整行字段回传，
    // 拿不准的字符串字段写成 "null"/"undefined"，直接覆盖会毁掉已有内容
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const v = fields[key]
      if (typeof v === 'string' && (v === 'null' || v === 'undefined' || v === 'NULL' || v === 'Null')) {
        delete fields[key]
      }
    }

    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const currentCharacterIds = 'character_ids' in fields
      ? fields.character_ids
      : (await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)))
          .map(link => link.characterId)

    const currentPropIds = 'prop_ids' in fields
      ? fields.prop_ids
      : (await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboard_id)))
          .map(link => link.propId)

    await validateStoryboardBindings(
      episodeId,
      dramaId,
      'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
      currentCharacterIds,
      currentPropIds,
    )

    const updates: Record<string, any> = { updatedAt: now() }
    if ('title' in fields) updates.title = fields.title
    if ('shot_type' in fields) updates.shotType = fields.shot_type
    if ('angle' in fields) updates.angle = fields.angle
    if ('movement' in fields) updates.movement = fields.movement
    if ('location' in fields) updates.location = fields.location
    if ('time' in fields) updates.time = fields.time
    if ('result' in fields) updates.result = fields.result
    if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
    if ('image_prompt' in fields) updates.imagePrompt = fields.image_prompt
    if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
    if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
    if ('description' in fields) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('duration' in fields) updates.duration = fields.duration
    await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id))
    if ('character_ids' in fields) await syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
    if ('prop_ids' in fields) await syncStoryboardProps(storyboard_id, fields.prop_ids || [])
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    const fresh = await loadStoryboardBindings(storyboard_id)
    const warnings = fresh ? checkStoryboardDraft({
      shotNumber: fresh.storyboard.storyboardNumber,
      duration: fresh.storyboard.duration,
      description: fresh.storyboard.description,
      videoPrompt: fresh.storyboard.videoPrompt,
      refNames: boundRefNames(fresh),
    }) : []
    return { message: `Storyboard ${storyboard_id} updated`, ...(warnings.length ? { warnings } : {}) }
  },
})

const NEIGHBOR_SUMMARY_CHARS = 160

const readStoryboardDetail = createTool({
  id: 'read_storyboard_detail',
  description: 'Read one storyboard segment for video-prompt generation: its description/atmosphere/duration, bound scene/characters/props, the names allowed in @ references, and short summaries of the previous and next segments.',
  inputSchema: z.object({
    storyboard_id: z.number(),
  }),
  execute: async ({ storyboard_id }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const b = await loadStoryboardBindings(storyboard_id)
    if (!b || b.storyboard.episodeId !== ids.episodeId) return { error: `Storyboard ${storyboard_id} not found in current episode` }
    const sb = b.storyboard
    const siblings = (await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, ids.episodeId)))
      .sort((x, y) => x.storyboardNumber - y.storyboardNumber)
    const pos = siblings.findIndex(x => x.id === sb.id)
    const summary = (x: typeof sb | undefined) => x ? {
      shot_number: x.storyboardNumber,
      title: x.title || '',
      description: (x.description || '').slice(0, NEIGHBOR_SUMMARY_CHARS),
    } : null
    return {
      storyboard: {
        id: sb.id,
        shot_number: sb.storyboardNumber,
        title: sb.title || '',
        duration: sb.duration || 0,
        description: sb.description || '',
        atmosphere: sb.atmosphere || '',
        current_video_prompt: sb.videoPrompt || '',
        // 有故事板时按「镜」的真实起止时间写 video_prompt
        board: sb.board ? JSON.parse(sb.board) : null,
      },
      scene: b.scene ? { name: b.scene.location, time: b.scene.time, lighting: b.scene.lighting || '' } : null,
      characters: b.characters.map(c => ({ name: c.name, styling: c.styling || '' })),
      props: b.props.map(p => ({ name: p.name, description: p.description || '' })),
      allowed_ref_names: boundRefNames(b),
      previous: summary(siblings[pos - 1]),
      next: summary(siblings[pos + 1]),
    }
  },
})

const saveVideoPrompt = createTool({
  id: 'save_video_prompt',
  description: 'Save the video_prompt of one storyboard segment (only this field is changed). Returns warnings when @ references are not in the bound list or the prompt breaks rules; fix and save again.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    video_prompt: z.string(),
  }),
  execute: async ({ storyboard_id, video_prompt }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const b = await loadStoryboardBindings(storyboard_id)
    if (!b || b.storyboard.episodeId !== ids.episodeId) return { error: `Storyboard ${storyboard_id} not found in current episode` }
    const prompt = video_prompt.trim()
    if (!prompt || prompt === 'null' || prompt === 'undefined') return { error: 'video_prompt 不能为空' }
    await db.update(schema.storyboards)
      .set({ videoPrompt: prompt, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboard_id))
    const names = boundRefNames(b)
    const invalid = findInvalidRefs(prompt, names)
    logTaskSuccess('StoryboardTool', 'video-prompt-saved', {
      episodeId: ids.episodeId,
      storyboardId: storyboard_id,
      invalidRefs: invalid.length ? invalid.join(',') : undefined,
    })
    if (invalid.length) {
      return {
        saved: true,
        warnings: [`@${invalid.join('、@')} 不在本分镜绑定的素材中，生成视频时无法挂接参考图；可引用：${names.join('、') || '（无绑定素材）'}。请修正后重新调用 save_video_prompt`],
      }
    }
    return { saved: true }
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, saveBoards, updateStoryboard, readStoryboardDetail, saveVideoPrompt }
