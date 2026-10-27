/**
 * 故事板落库 — Agent 保存工具（save_boards）与界面编辑（PUT /storyboards/:id/board）共用
 * 写入故事板 JSON 的同时确定性推导 description / video_prompt，并把审核状态重置为 draft（内容变了，旧图需重出/复核）
 */
import { and, asc, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getContentLanguage } from './app-settings.js'
import { boardToDescription, boardToVideoPrompt, checkBoard, parseBoard, type Board } from './board.js'

export interface ScriptSceneInfo {
  no: string
  heading: string
  /** 场景在剧本中的字数（用于总量锚定参考） */
  length: number
}

const SCENE_HEADER = /^##\s*(S\d+)\s*[|｜]\s*(.+)$/gim

/** 解析剧本场景头：## S01 | 内景 · 地点 | 时间段 */
export function parseScriptScenes(script: string): ScriptSceneInfo[] {
  const matches = [...(script || '').matchAll(SCENE_HEADER)]
  return matches.map((m, i) => {
    const start = (m.index || 0) + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index || script.length : script.length
    return { no: m[1].toUpperCase(), heading: m[2].trim(), length: script.slice(start, end).trim().length }
  })
}

export function normalizeSceneNo(no: string) {
  const m = String(no || '').trim().match(/^s?0*(\d+)$/i)
  return m ? `S${m[1].padStart(2, '0')}` : String(no || '').trim().toUpperCase()
}

/** 新增或更新剧本场景分组（按场景号） */
export async function upsertScriptScene(episodeId: number, info: { no: string; heading: string; summary?: string | null }) {
  const sceneNo = normalizeSceneNo(info.no)
  const ts = now()
  const [existing] = await db.select().from(schema.episodeScriptScenes)
    .where(and(eq(schema.episodeScriptScenes.episodeId, episodeId), eq(schema.episodeScriptScenes.sceneNo, sceneNo)))
  const sortOrder = Number(sceneNo.replace(/\D/g, '')) || 0
  if (existing) {
    await db.update(schema.episodeScriptScenes)
      .set({ heading: info.heading || existing.heading, summary: info.summary ?? existing.summary, sortOrder, updatedAt: ts })
      .where(eq(schema.episodeScriptScenes.id, existing.id))
    return existing.id
  }
  const res = await db.insert(schema.episodeScriptScenes).values({
    episodeId, sceneNo, heading: info.heading, summary: info.summary || null, sortOrder, createdAt: ts, updatedAt: ts,
  })
  return getInsertId(res)
}

export async function listScriptScenes(episodeId: number) {
  return db.select().from(schema.episodeScriptScenes)
    .where(eq(schema.episodeScriptScenes.episodeId, episodeId))
    .orderBy(asc(schema.episodeScriptScenes.sortOrder))
}

/** 绑定素材的名字（与 @ 引用一致：场景按地点、角色/道具按名字） */
export async function refNamesFor(sceneId: number | null | undefined, characterIds: number[], propIds: number[]) {
  const [scene] = sceneId ? await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)) : []
  const characters = characterIds.length
    ? (await db.select().from(schema.characters)).filter(c => characterIds.includes(c.id) && !c.deletedAt)
    : []
  const props = propIds.length
    ? (await db.select().from(schema.props)).filter(p => propIds.includes(p.id) && !p.deletedAt)
    : []
  characters.sort((a, b) => characterIds.indexOf(a.id) - characterIds.indexOf(b.id))
  props.sort((a, b) => propIds.indexOf(a.id) - propIds.indexOf(b.id))
  return {
    scene: scene && !scene.deletedAt ? scene.location : null,
    characters: characters.map(c => c.name),
    props: props.map(p => p.name),
  }
}

/** 由故事板推导出的分镜字段（description / video_prompt / 时长 / 审核状态） */
export async function derivedBoardFields(board: Board, opts: {
  duration: number
  atmosphere?: string | null
  sceneId?: number | null
  characterIds: number[]
  propIds: number[]
}) {
  const lang = getContentLanguage()
  const refs = await refNamesFor(opts.sceneId, opts.characterIds, opts.propIds)
  return {
    board: JSON.stringify(board),
    description: boardToDescription(board, lang),
    videoPrompt: boardToVideoPrompt(board, refs, opts.atmosphere, lang),
    duration: opts.duration,
    boardStatus: 'draft',
    updatedAt: now(),
  }
}

/** 界面编辑故事板：校验 + 重新推导；返回 warnings */
export async function updateStoryboardBoard(storyboardId: number, board: Board, patch: { duration?: number; atmosphere?: string | null; title?: string | null } = {}) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const characterIds = (await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))).map(l => l.characterId)
  const propIds = (await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))).map(l => l.propId)
  const duration = patch.duration ?? board.shots[board.shots.length - 1]?.end ?? sb.duration ?? 0
  const atmosphere = patch.atmosphere !== undefined ? patch.atmosphere : sb.atmosphere
  const fields = await derivedBoardFields(board, { duration, atmosphere, sceneId: sb.sceneId, characterIds, propIds })
  await db.update(schema.storyboards).set({
    ...fields,
    atmosphere,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
  }).where(eq(schema.storyboards.id, storyboardId))
  await recomputeEpisodeDuration(sb.episodeId)
  return checkBoard(board, duration, sb.storyboardNumber)
}

export async function recomputeEpisodeDuration(episodeId: number) {
  const rows = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  const total = rows.filter(r => !r.deletedAt).reduce((sum, r) => sum + (r.duration || 0), 0)
  await db.update(schema.episodes).set({ duration: Math.ceil(total / 60), updatedAt: now() }).where(eq(schema.episodes.id, episodeId))
  return total
}

/**
 * 按当前故事板与绑定重新推导 description / video_prompt（不改审核状态）。
 * 用于故事板段的「重新生成视频提示词」：结果与故事板严格一致，不经大模型改写
 */
export async function rederiveBoardText(storyboardId: number): Promise<string | null> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const board = parseBoard(sb?.board)
  if (!sb || !board) return null
  const characterIds = (await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))).map(l => l.characterId)
  const propIds = (await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))).map(l => l.propId)
  const lang = getContentLanguage()
  const refs = await refNamesFor(sb.sceneId, characterIds, propIds)
  const videoPrompt = boardToVideoPrompt(board, refs, sb.atmosphere, lang)
  await db.update(schema.storyboards).set({
    description: boardToDescription(board, lang),
    videoPrompt,
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, storyboardId))
  return videoPrompt
}
