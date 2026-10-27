/**
 * 分镜参考素材与校验 — 后端统一口径
 * - 绑定素材：场景（按地点引用）→ 角色 → 道具，顺序即参考图顺序（与前端历史行为一致）
 * - @引用：video_prompt 中的 @名字 按绑定素材名做最长前缀匹配，支持带空格的名字
 * - 校验：时长范围、台词时长下限、video_prompt 缺失、@引用不在绑定列表
 */
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

type StoryboardRow = typeof schema.storyboards.$inferSelect
type SceneRow = typeof schema.scenes.$inferSelect
type CharacterRow = typeof schema.characters.$inferSelect
type PropRow = typeof schema.props.$inferSelect

export interface StoryboardBindings {
  storyboard: StoryboardRow
  scene: SceneRow | null
  characters: CharacterRow[]
  props: PropRow[]
}

export interface ReferenceAsset {
  kind: 'scene' | 'character' | 'prop'
  id: number
  name: string
  imageUrl: string
}

/** 段落时长建议区间（storyboard-breaker 技能）与视频模型可接受区间 */
export const SEGMENT_MIN_SECONDS = 8
export const SEGMENT_MAX_SECONDS = 15
/** 台词语速：中日韩按字、英文按词；外加表演余量 */
const CJK_CHARS_PER_SECOND = 4.5
const WORDS_PER_SECOND = 2.5
const PERFORMANCE_HEADROOM_SECONDS = 2

/** 读取分镜及其绑定的场景/角色/道具（已软删除的资产不算） */
export async function loadStoryboardBindings(storyboardId: number): Promise<StoryboardBindings | null> {
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard) return null
  const charIds = (await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))).map(l => l.characterId)
  const propIds = (await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))).map(l => l.propId)
  const [scene] = storyboard.sceneId
    ? await db.select().from(schema.scenes).where(eq(schema.scenes.id, storyboard.sceneId))
    : []
  const characters = charIds.length
    ? (await db.select().from(schema.characters).where(inArray(schema.characters.id, charIds))).filter(c => !c.deletedAt)
    : []
  const props = propIds.length
    ? (await db.select().from(schema.props).where(inArray(schema.props.id, propIds))).filter(p => !p.deletedAt)
    : []
  // 保持绑定顺序（inArray 不保证顺序）
  characters.sort((a, b) => charIds.indexOf(a.id) - charIds.indexOf(b.id))
  props.sort((a, b) => propIds.indexOf(a.id) - propIds.indexOf(b.id))
  return { storyboard, scene: scene && !scene.deletedAt ? scene : null, characters, props }
}

/** 可被 @ 引用的名字：场景地点、角色名、道具名 */
export function boundRefNames(b: Pick<StoryboardBindings, 'scene' | 'characters' | 'props'>): string[] {
  return [
    b.scene?.location || '',
    ...b.characters.map(c => c.name || ''),
    ...b.props.map(p => p.name || ''),
  ].map(n => n.trim()).filter(Boolean)
}

/** 按参考图顺序（场景 → 角色 → 道具）收集有图的绑定素材，按图片去重并截断到 limit */
export function orderedReferenceAssets(b: Pick<StoryboardBindings, 'scene' | 'characters' | 'props'>, limit: number): ReferenceAsset[] {
  const out: ReferenceAsset[] = []
  const seen = new Set<string>()
  const push = (kind: ReferenceAsset['kind'], id: number, name: string, url: string | null | undefined) => {
    if (!url || seen.has(url) || out.length >= limit) return
    seen.add(url)
    out.push({ kind, id, name: name.trim(), imageUrl: url })
  }
  if (b.scene) push('scene', b.scene.id, b.scene.location || '', b.scene.imageUrl)
  for (const c of b.characters) push('character', c.id, c.name || '', c.imageUrl)
  for (const p of b.props) push('prop', p.id, p.name || '', p.imageUrl)
  return out
}

/** 名字按长度降序，保证「林小雨」优先于「林小」匹配 */
function sortedNames(names: string[]) {
  return [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
}

const REF_TOKEN = /^[^\s@，。、；：！？,.;:!?「」『』“”"'（）()【】\[\]]+/

/** 扫描 @引用：返回每个 @ 位置匹配到的名字（未匹配为 null）及原始片段 */
function scanRefs(prompt: string, names: string[]) {
  const ordered = sortedNames(names)
  const refs: { index: number; name: string | null; token: string }[] = []
  for (let i = prompt.indexOf('@'); i !== -1; i = prompt.indexOf('@', i + 1)) {
    const name = ordered.find(n => prompt.startsWith(n, i + 1)) || null
    const token = name || (prompt.slice(i + 1).match(REF_TOKEN)?.[0] ?? '')
    refs.push({ index: i, name, token })
  }
  return refs
}

/** video_prompt 中不在 names 内的 @引用（去重，保持出现顺序） */
export function findInvalidRefs(prompt: string, names: string[]): string[] {
  const invalid = scanRefs(prompt || '', names)
    .filter(r => !r.name && r.token)
    .map(r => r.token)
  return [...new Set(invalid)]
}

/** 将 @名字 替换为 @图片N名字（N 为参考图序号，1 起）；没有图片的名字保持原样 */
export function resolvePromptRefs(prompt: string, refs: ReferenceAsset[]): string {
  if (!prompt) return ''
  const indexByName = new Map<string, number>()
  refs.forEach((r, i) => { if (r.name && !indexByName.has(r.name)) indexByName.set(r.name, i + 1) })
  if (!indexByName.size) return prompt
  const hits = scanRefs(prompt, [...indexByName.keys()]).filter(r => r.name)
  let out = ''
  let cursor = 0
  for (const hit of hits) {
    out += prompt.slice(cursor, hit.index) + `@图片${indexByName.get(hit.name!)}`
    cursor = hit.index + 1
  }
  return out + prompt.slice(cursor)
}

/** 估算 description 中台词与旁白的朗读秒数（中日韩按字、英文按词） */
export function estimateDialogueSeconds(description: string): number {
  if (!description) return 0
  const spoken: string[] = []
  // 「…」/『…』 内的台词（中日韩剧本格式）
  for (const m of description.matchAll(/[「『]([^「」『』]+)[」』]/g)) spoken.push(m[1])
  // 旁白：…（到行尾或下一个【镜头N】）
  for (const m of description.matchAll(/(?:旁白|ナレーション|내레이션|Narration)\s*[：:]\s*([^\n【]+)/gi)) spoken.push(m[1])
  // 英文台词：says: "..."
  for (const m of description.matchAll(/says\s*:\s*["“]([^"”]+)["”]/gi)) spoken.push(m[1])
  let seconds = 0
  for (const text of spoken) {
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length
    const words = (text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length
    seconds += cjk / CJK_CHARS_PER_SECOND + words / WORDS_PER_SECOND
  }
  return seconds
}

export interface DraftCheckInput {
  shotNumber: number
  duration?: number | null
  description?: string | null
  videoPrompt?: string | null
  refNames: string[]
}

/** 单个分镜段落的规则校验，返回人读的警告列表（空数组 = 通过） */
export function checkStoryboardDraft(input: DraftCheckInput): string[] {
  const warnings: string[] = []
  const label = `分镜 ${input.shotNumber}`
  const duration = Number(input.duration || 0)
  if (duration && (duration < SEGMENT_MIN_SECONDS || duration > SEGMENT_MAX_SECONDS)) {
    warnings.push(`${label}：时长 ${duration} 秒不在 ${SEGMENT_MIN_SECONDS}-${SEGMENT_MAX_SECONDS} 秒范围内`)
  }
  const dialogue = estimateDialogueSeconds(input.description || '')
  if (dialogue > 0) {
    const needed = Math.ceil(dialogue + PERFORMANCE_HEADROOM_SECONDS)
    if (duration && needed > duration) {
      warnings.push(`${label}：台词与旁白约需 ${needed} 秒（含 ${PERFORMANCE_HEADROOM_SECONDS} 秒表演余量），超过时长 ${duration} 秒，请延长时长或把部分台词拆到下一段`)
    }
  }
  const prompt = (input.videoPrompt || '').trim()
  if (!prompt) {
    warnings.push(`${label}：缺少 video_prompt`)
  } else {
    const invalid = findInvalidRefs(prompt, input.refNames)
    if (invalid.length) {
      const allowed = input.refNames.length ? input.refNames.join('、') : '（无绑定素材）'
      warnings.push(`${label}：video_prompt 中的 @${invalid.join('、@')} 不在本分镜绑定的素材中（可引用：${allowed}）；请改为绑定素材的完整名字，或先绑定对应素材`)
    }
  }
  return warnings
}
