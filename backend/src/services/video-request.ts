/**
 * 分镜视频请求组装（auto_references）— 生成任务与「请求预览」共用，保证预览即实际发送内容
 *
 * 故事板约束如何进入视频：
 * - 提示词：故事板推导的 video_prompt（开场画面 → 按镜起止秒的时间轴 → 结尾画面），@名字 换成 @图片N
 * - 参考图：审核通过的段，第 1 张为净版关键帧（去掉标注的多格画面），并写明第几格对应哪段时间；
 *   其余为场景 → 角色 → 道具设定图
 * - 时长：有故事板时以故事板时间轴为准（提示词按秒分段，时长不一致会错位）
 */
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { boardPanelGuide, parseBoard } from './board.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { getDramaStylePrompt } from './style-preset.js'
import { loadStoryboardBindings, orderedReferenceAssets, resolvePromptRefs, type ReferenceAsset } from './storyboard-refs.js'

/** 故事板参考状态：used 已挂净版；off 集开关关闭；not_approved 未审核通过；clean_missing 净版未就绪；no_board 无故事板；
 *  blocked 本项目当前风格下含人物的关键帧曾被平台真人审核拒绝（空镜段不受影响） */
export type BoardReferenceState = 'used' | 'off' | 'not_approved' | 'clean_missing' | 'no_board' | 'blocked'

type StoryboardRow = typeof schema.storyboards.$inferSelect

/** 只有审核通过的当前版本的净版关键帧才可作为视频参考（审核后改过文字/换过版本都会回到非通过状态） */
export function boardReferenceState(sb: StoryboardRow, boardReferenceOn: boolean, cleanImageUrl: string | null | undefined, blockedForPeople = false): BoardReferenceState {
  if (!parseBoard(sb.board)) return 'no_board'
  if (!boardReferenceOn) return 'off'
  if (sb.boardStatus !== 'approved') return 'not_approved'
  if (blockedForPeople) return 'blocked'
  return cleanImageUrl ? 'used' : 'clean_missing'
}

/** 项目当前风格是否已被真人审核拦过故事板参考（换风格后自动失效） */
export function isBoardRefBlocked(drama: { style?: string | null; boardRefBlockedStyle?: string | null } | null | undefined) {
  return !!drama?.boardRefBlockedStyle && drama.boardRefBlockedStyle === (drama.style || '-')
}

/** 段内是否有人物出场（含人物的关键帧才会触发真人审核；空镜不受影响） */
export async function storyboardHasCharacters(storyboardIds: number[]): Promise<Set<number>> {
  if (!storyboardIds.length) return new Set()
  const links = await db.select().from(schema.storyboardCharacters).where(inArray(schema.storyboardCharacters.storyboardId, storyboardIds))
  return new Set(links.map(l => l.storyboardId))
}

/** 批量求各分镜当前版本的净版关键帧地址 */
export async function cleanImagesByStoryboard(rows: StoryboardRow[]): Promise<Map<number, string | null>> {
  const versionIds = rows.map(r => r.boardVersionId).filter((v): v is number => !!v)
  const versions = versionIds.length
    ? await db.select().from(schema.storyboardBoardVersions).where(inArray(schema.storyboardBoardVersions.id, versionIds))
    : []
  const byVersion = new Map(versions.map(v => [v.id, v.cleanImageUrl]))
  return new Map(rows.map(r => [r.id, r.boardVersionId ? byVersion.get(r.boardVersionId) || null : null]))
}

export function boardReferenceNote(guide: string) {
  return `@图片1 是本段各镜头的关键画面（多格按镜头顺序从左到右排列：${guide}），只用于参考每个镜头的构图、景别、人物站位与场景布置；视频是正常的单画面，不要出现多格拼接、分屏或任何文字。`
}

export interface VoiceClipRef {
  index: number
  characterId: number
  name: string
  url: string
}

/** 参考视频条数：Seedance / MiniMax ≤3，Wan 3.0 ≤5。声音只走 reference_video，不走 reference_audio。 */
export function voiceClipLimit(provider?: string | null) {
  return (provider || '').toLowerCase() === 'aliyun' ? 5 : 3
}

export function collectVoiceClips(characters: { id: number; name?: string | null; voiceClipUrl?: string | null }[], limit: number): VoiceClipRef[] {
  const clips: VoiceClipRef[] = []
  for (const character of characters) {
    const url = String(character.voiceClipUrl || '').trim()
    if (!url || clips.length >= limit) continue
    clips.push({ index: clips.length + 1, characterId: character.id, name: (character.name || '').trim(), url })
  }
  return clips
}

/** 告诉视频模型：这些参考视频只提供角色声音，不要把试听画面剪进成片 */
export function voiceClipPromptNote(clips: { index: number; name: string }[]) {
  if (!clips.length) return ''
  return clips.map(clip => `@视频${clip.index} 是${clip.name || '角色'}的说话样本，只借用这个声音；成片不要出现这段试听画面。`).join('\n')
}

export function appendVoiceClipNote(prompt: string, clips: { index: number; name: string }[]) {
  const note = voiceClipPromptNote(clips)
  if (!note) return prompt
  return prompt ? `${prompt}\n${note}` : note
}

export interface StoryboardVideoInput {
  prompt: string
  references: (ReferenceAsset & { index: number })[]
  /** 出场角色已有说话短视频时，按绑定顺序放入 reference_video（不是 reference_audio） */
  voiceClips: VoiceClipRef[]
  boardState: BoardReferenceState
  /** 有故事板时为故事板时长，否则 undefined（沿用请求值） */
  duration?: number
}

/** 组装分镜的视频提示词与参考图；rawPrompt 为空时取分镜已保存的 video_prompt */
export async function buildStoryboardVideoInput(storyboardId: number, opts: { provider?: string | null; rawPrompt?: string | null; disableBoard?: boolean }): Promise<StoryboardVideoInput | null> {
  const bindings = await loadStoryboardBindings(storyboardId)
  if (!bindings) return null
  const sb = bindings.storyboard
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  const [drama] = ep ? await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)) : []
  const board = parseBoard(sb.board)
  const clean = (await cleanImagesByStoryboard([sb])).get(sb.id)
  // disableBoard：真人审核兜底重提时强制不挂故事板参考；
  // 本项目风格被拦过时，含人物的段直接跳过（避免每段先被拒一次），空镜段照常挂
  const blocked = isBoardRefBlocked(drama) && bindings.characters.length > 0
  const boardState = boardReferenceState(sb, ep?.boardReference !== false && !opts.disableBoard, clean, blocked)

  const limit = (opts.provider || '').toLowerCase() === 'aliyun' ? 10 : 9
  const useBoard = boardState === 'used' && !!clean && !!board
  const assetRefs = orderedReferenceAssets(bindings, useBoard ? limit - 1 : limit)
  const refs: ReferenceAsset[] = useBoard
    ? [{ kind: 'scene', id: 0, name: '', imageUrl: clean! }, ...assetRefs]
    : assetRefs

  const raw = String(opts.rawPrompt || '').trim() || sb.videoPrompt || ''
  const resolved = resolvePromptRefs(raw, refs)
  const prompt = useBoard ? `${boardReferenceNote(boardPanelGuide(board!))}\n${resolved}` : resolved
  const voiceClips = collectVoiceClips(bindings.characters, voiceClipLimit(opts.provider))
  return {
    prompt: appendVoiceClipNote(prompt, voiceClips),
    references: refs.map((r, i) => ({ ...r, index: i + 1 })),
    voiceClips,
    boardState,
    duration: board ? board.shots[board.shots.length - 1]?.end : undefined,
  }
}

/** 视频提示词最前方注入项目视觉风格（与生成任务口径一致） */
export async function applyVideoStylePrefix(prompt: string, dramaId: number | null | undefined) {
  if (!String(prompt || '').trim()) return prompt
  const stylePrompt = await getDramaStylePrompt(dramaId)
  return stylePrompt ? `${stylePrompt}，\n${prompt}` : prompt
}

/** 请求预览：与 POST /tasks（auto_references）实际发送的提示词、参考图、时长一致，但不提交任务 */
export async function previewStoryboardVideoRequest(storyboardId: number, configId?: number | null) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) return null
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  const cfgId = configId ?? ep?.videoConfigId ?? null
  const config = cfgId ? (await getConfigById(cfgId)) ?? await getActiveConfig('video') : await getActiveConfig('video')
  const input = await buildStoryboardVideoInput(storyboardId, { provider: config?.provider })
  if (!input) return null
  return {
    provider: config?.provider || null,
    model: config?.model || null,
    duration: input.duration ?? sb.duration,
    board_state: input.boardState,
    prompt: await applyVideoStylePrefix(input.prompt, ep?.dramaId),
    references: input.references.map(r => ({ index: r.index, kind: r.id === 0 ? 'board' : r.kind, name: r.name, url: r.imageUrl })),
    reference_videos: input.voiceClips.map(clip => ({
      index: clip.index,
      name: clip.name,
      url: clip.url,
      character_id: clip.characterId,
      role: 'reference_video',
    })),
  }
}
