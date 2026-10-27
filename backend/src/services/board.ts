/**
 * 故事板（storyboard board）— 剧本场景的落地方案
 *
 * 层级：剧本场景（S01）→ 段（= 一个分镜行 = 一次视频生成）→ 镜（镜号变化 = 切镜）→ 拍（1A/1B 同镜连续动作，一拍一格画面）
 * 故事板 JSON 存在 storyboards.board，是该段的唯一事实来源：
 * - description（【镜头N】格式，兼容旧链路）与 video_prompt（按镜的真实起止时间分段）由它确定性推导，不再让模型各写一份
 * - 故事板图的出图提示词也由它按模板拼装（见 board-image.ts）
 */
import { z } from 'zod'
import type { ContentLanguage } from './app-settings.js'
import { estimateDialogueSeconds } from './storyboard-refs.js'

/** 段时长：视频模型单次生成 5-15 秒（seedance-2.0-mini 最短 5 秒，见 docs/local-setup-notes.md） */
export const BOARD_MIN_SECONDS = 5
export const BOARD_MAX_SECONDS = 15
/** 一段最多 4 格画面（故事板图横向排版上限） */
export const BOARD_MAX_PANELS = 4
const PERFORMANCE_HEADROOM_SECONDS = 2
/** 单镜内开口前后的停顿余量 */
const SHOT_HEADROOM_SECONDS = 1

export const boardBeatSchema = z.object({
  code: z.string().describe('拍号：镜号 + 字母，如 1A、1B、2A'),
  frame: z.string().optional().describe('这一格的画面：谁在哪、构图与神态（用于出图）'),
  action: z.string().describe('动作：人物/道具/环境在这一拍里发生了什么'),
  camera: z.string().optional().describe('运镜补充（同镜持续时的变化，如「镜头继续推近」）'),
  sound: z.string().optional().describe('声音：环境音/动作音/音乐'),
  narration: z.string().optional().describe('旁白'),
  dialogue: z.array(z.object({ speaker: z.string(), line: z.string() })).optional().describe('台词'),
  subject_arrow: z.string().optional().describe('红箭头标注（人物/道具动作方向），如「行进」「划过」'),
  camera_arrow: z.string().optional().describe('蓝箭头标注（摄影机运动），如「缓慢推近」'),
})

export const boardShotSchema = z.object({
  no: z.number().int().describe('镜号，段内从 1 起'),
  start: z.number().describe('段内起始秒'),
  end: z.number().describe('段内结束秒'),
  size: z.string().describe('景别：大远景/远景/全景/中景/中近景/近景/特写/大特写'),
  angle: z.string().optional().describe('机位角度：如「正面偏侧，齐眼高」「俯拍」'),
  movement: z.string().optional().describe('运镜：固定/推/拉/摇/移/跟，含速度，如「固定后极缓推近」'),
  purpose: z.string().optional().describe('镜头目的：这一镜要让观众感受到什么'),
  beats: z.array(boardBeatSchema).min(1).max(3),
})

export const boardSchema = z.object({
  start_state: z.string().describe('本段开始时画面的状态（承接上一段结束）'),
  end_state: z.string().describe('本段结束时画面的状态（交给下一段开始）'),
  shots: z.array(boardShotSchema).min(1),
})

export type Board = z.infer<typeof boardSchema>
export type BoardShot = z.infer<typeof boardShotSchema>
export type BoardBeat = z.infer<typeof boardBeatSchema>

export function parseBoard(raw: string | null | undefined): Board | null {
  if (!raw) return null
  try {
    const parsed = boardSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function boardPanels(board: Board): { shot: BoardShot; beat: BoardBeat; beatIndex: number }[] {
  return board.shots.flatMap(shot => shot.beats.map((beat, beatIndex) => ({ shot, beat, beatIndex })))
}

function spokenText(beat: BoardBeat) {
  return [
    beat.narration ? `旁白：${beat.narration}` : '',
    ...(beat.dialogue || []).map(d => `${d.speaker}说：「${d.line}」`),
  ].filter(Boolean).join(' ')
}

/** 故事板规则校验：时间轴、格数、拍号、台词时长下限 */
export function checkBoard(board: Board, duration: number, shotNumber: number): string[] {
  const label = `分镜 ${shotNumber}`
  const warnings: string[] = []
  if (duration < BOARD_MIN_SECONDS || duration > BOARD_MAX_SECONDS) {
    warnings.push(`${label}：时长 ${duration} 秒不在 ${BOARD_MIN_SECONDS}-${BOARD_MAX_SECONDS} 秒范围内`)
  }
  let cursor = 0
  board.shots.forEach((shot, i) => {
    if (shot.no !== i + 1) warnings.push(`${label}：镜号应从 1 起连续，第 ${i + 1} 个镜写成了 ${shot.no}`)
    if (Math.abs(shot.start - cursor) > 0.01) warnings.push(`${label}：镜 ${shot.no} 应从 ${cursor} 秒开始（时间轴需首尾相接）`)
    if (shot.end <= shot.start) warnings.push(`${label}：镜 ${shot.no} 的结束时间必须大于开始时间`)
    cursor = shot.end
    shot.beats.forEach((beat, j) => {
      const expected = `${shot.no}${String.fromCharCode(65 + j)}`
      if (beat.code.trim().toUpperCase() !== expected) warnings.push(`${label}：拍号应为 ${expected}，实际为 ${beat.code}`)
    })
  })
  if (Math.abs(cursor - duration) > 0.01) warnings.push(`${label}：各镜时间之和 ${cursor} 秒与段时长 ${duration} 秒不一致`)
  // 逐镜台词下限：实测视频模型优先保证台词说完，镜头放不下台词时会自行拉长该镜、切镜点整体后移
  for (const shot of board.shots) {
    const spoken = estimateDialogueSeconds(shot.beats.map(spokenText).join('\n'))
    if (!spoken) continue
    const needed = Math.ceil(spoken + SHOT_HEADROOM_SECONDS)
    const span = shot.end - shot.start
    if (needed > span) warnings.push(`${label}：镜 ${shot.no} 的台词/旁白约需 ${needed} 秒，镜头只有 ${span} 秒，请延长该镜或把部分台词拆到下一镜`)
  }
  const panels = boardPanels(board).length
  if (panels > BOARD_MAX_PANELS) warnings.push(`${label}：共 ${panels} 格画面，超过 ${BOARD_MAX_PANELS} 格上限，请拆成两段`)
  const dialogue = estimateDialogueSeconds(boardPanels(board).map(p => spokenText(p.beat)).join('\n'))
  if (dialogue > 0) {
    const needed = Math.ceil(dialogue + PERFORMANCE_HEADROOM_SECONDS)
    if (needed > duration) warnings.push(`${label}：台词与旁白约需 ${needed} 秒（含 ${PERFORMANCE_HEADROOM_SECONDS} 秒表演余量），超过时长 ${duration} 秒，请延长或拆段`)
  }
  if (!board.start_state.trim() || !board.end_state.trim()) warnings.push(`${label}：缺少本段开始/结束状态`)
  return warnings
}

// ─── 推导文本（按内容语言） ─────────────────────────────────────────

interface Labels {
  shot: (n: number) => string
  says: string
  narration: string
  sound: string
  seconds: (a: number, b: number) => string
  cast: string
  scene: string
  props: string
  cutTo: string
  atmosphere: string
  sep: string
  listSep: string
  end: string
  opening: string
  ending: string
}

const LABELS: Record<ContentLanguage, Labels> = {
  zh: { shot: n => `【镜头${n}】`, says: '说：', narration: '旁白：', sound: '声音：', seconds: (a, b) => `${a}-${b}秒`, cast: '出场人物：', scene: '场景：', props: '道具：', cutTo: '切到', atmosphere: '氛围：', sep: '，', listSep: '、', end: '。', opening: '开场画面（承接上一段）：', ending: '结尾画面（交给下一段）：' },
  en: { shot: n => `【镜头${n}】`, says: ' says: ', narration: 'Narration: ', sound: 'Sound: ', seconds: (a, b) => `${a}-${b}s`, cast: 'Characters: ', scene: 'Scene: ', props: 'Props: ', cutTo: 'Cut to', atmosphere: 'Atmosphere: ', sep: ', ', listSep: ', ', end: '.', opening: 'Opening frame (continues from the previous segment): ', ending: 'Ending frame (hands over to the next segment): ' },
  ja: { shot: n => `【镜头${n}】`, says: 'が言う：', narration: 'ナレーション：', sound: '音：', seconds: (a, b) => `${a}-${b}秒`, cast: '登場人物：', scene: 'シーン：', props: '小道具：', cutTo: 'カット：', atmosphere: '雰囲気：', sep: '、', listSep: '、', end: '。', opening: '冒頭の画面（前のパートから続く）：', ending: 'ラストの画面（次のパートへ渡す）：' },
  ko: { shot: n => `【镜头${n}】`, says: '이(가) 말한다: ', narration: '내레이션: ', sound: '소리: ', seconds: (a, b) => `${a}-${b}초`, cast: '등장인물: ', scene: '장면: ', props: '소품: ', cutTo: '컷 전환', atmosphere: '분위기: ', sep: ', ', listSep: ', ', end: '.', opening: '시작 화면(앞 구간에서 이어짐): ', ending: '마지막 화면(다음 구간으로 넘김): ' },
}

const labelsOf = (lang?: ContentLanguage | null) => LABELS[lang || 'zh'] || LABELS.zh

function trimEnd(text: string) {
  return text.trim().replace(/[。.，,；;、\s]+$/u, '')
}

function beatLine(beat: BoardBeat, L: Labels) {
  const parts = [trimEnd(beat.action)]
  if (beat.camera) parts.push(trimEnd(beat.camera))
  if (beat.sound) parts.push(`${L.sound}${trimEnd(beat.sound)}`)
  const text = parts.filter(Boolean).join(L.sep) + L.end
  const gap = L.end === '.' ? ' ' : ''
  const spoken = [
    beat.narration ? `${L.narration}${beat.narration.trim()}` : '',
    ...(beat.dialogue || []).map(d => `${d.speaker.trim()}${L.says}「${d.line.trim()}」`),
  ].filter(Boolean).join(gap || ' ')
  return spoken ? `${text}${gap}${spoken}` : text
}

function shotCamera(shot: BoardShot, L: Labels) {
  return [shot.size, shot.angle, shot.movement].map(v => trimEnd(v || '')).filter(Boolean).join('·')
}

/** 净版关键帧的格序 → 镜头时间对照（视频参考说明用）：第 N 格 = 拍号 + 起止秒 */
export function boardPanelGuide(board: Board): string {
  return boardPanels(board).map((p, i) => {
    const range = p.beatIndex === 0 ? `${p.shot.start}-${p.shot.end}秒` : `${p.shot.start}-${p.shot.end}秒内的后续动作`
    return `第${i + 1}格=${p.beat.code}（${range}，${p.shot.size}）`
  }).join('，')
}

/** 故事板 → description（【镜头N】（景别·角度·运镜）1A … 1B …），兼容旧的提示词与校验链路 */
export function boardToDescription(board: Board, lang?: ContentLanguage | null): string {
  const L = labelsOf(lang)
  return board.shots.map(shot => {
    const beats = shot.beats.map(b => `${b.code} ${beatLine(b, L)}`).join(L.end === '.' ? ' ' : '')
    return `${L.shot(shot.no)}（${shotCamera(shot, L)}）${beats}`
  }).join('\n')
}

/** 把文本中出现的绑定素材名加上 @（最长优先，已带 @ 的不重复加） */
export function tagRefNames(text: string, names: string[]): string {
  const ordered = [...new Set(names.filter(n => n && n.trim()))].sort((a, b) => b.length - a.length)
  if (!ordered.length) return text
  const escaped = ordered.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return text.replace(new RegExp(`(@?)(${escaped.join('|')})`, 'g'), (_m, at, name) => `@${name}`)
}

export interface BoardRefNames {
  scene?: string | null
  characters: string[]
  props: string[]
}

/**
 * 故事板 → video_prompt：首行信息头，之后按「镜」的真实起止时间分段（不再固定 3 秒），
 * 切镜处写「切到」，素材名自动加 @ 以挂接参考图
 */
export function boardToVideoPrompt(board: Board, refs: BoardRefNames, atmosphere?: string | null, lang?: ContentLanguage | null): string {
  const L = labelsOf(lang)
  const names = [refs.scene || '', ...refs.characters, ...refs.props].filter(Boolean)
  const header = [
    refs.characters.length ? `${L.cast}${refs.characters.map(n => `@${n}`).join(L.listSep)}` : '',
    refs.scene ? `${L.scene}@${refs.scene}` : '',
    refs.props.length ? `${L.props}${refs.props.map(n => `@${n}`).join(L.listSep)}` : '',
  ].filter(Boolean).join(lang === 'en' || lang === 'ko' ? '; ' : '；')
  const lines = board.shots.map((shot, i) => {
    const camera = shotCamera(shot, L).replace(/·/g, L.sep)
    const lead = i === 0 ? camera : `${L.cutTo}${lang === 'en' || lang === 'ko' ? ' ' : ''}${camera}`
    const beats = shot.beats.map(b => beatLine(b, L)).join(L.end === '.' ? ' ' : '')
    const gap = lang === 'en' || lang === 'ko' ? ' ' : ''
    return `${L.seconds(shot.start, shot.end)}：${lead}${L.end}${gap}${tagRefNames(beats, names)}`
  })
  // 段首段尾状态是故事板的衔接约束：开场画面放在时间轴前，结尾画面放在时间轴后
  const opening = board.start_state?.trim() ? `${L.opening}${tagRefNames(trimEnd(board.start_state), names)}${L.end}` : ''
  const ending = board.end_state?.trim() ? `${L.ending}${tagRefNames(trimEnd(board.end_state), names)}${L.end}` : ''
  const tail = atmosphere?.trim() ? [`${L.atmosphere}${trimEnd(atmosphere)}${L.end}`] : []
  return [header ? header + L.end : '', opening, ...lines, ending, ...tail].filter(Boolean).join('\n')
}
