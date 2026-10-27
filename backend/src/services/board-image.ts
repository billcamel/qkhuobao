/**
 * 故事板出图 — 每段一次图像模型调用，整张生成带文字/箭头的故事板图
 * 出图提示词由故事板 JSON 按模板确定性拼装（不经 LLM），参考图挂该段绑定的场景/角色/道具图，
 * 每次出图新建一个版本（storyboard_board_versions），完成后由 generation 回写为该段当前故事板（待审核）
 */
import { desc, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getContentLanguage, type ContentLanguage } from './app-settings.js'
import { boardPanels, parseBoard, type Board, type BoardBeat, type BoardShot } from './board.js'
import { generateImage } from './generation.js'
import { getDramaStylePrompt } from './style-preset.js'
import { loadStoryboardBindings, orderedReferenceAssets } from './storyboard-refs.js'

/** generation 归一化参考图时最多保留 6 张 */
const MAX_BOARD_REFS = 6

interface BoardText {
  rule: string
  legendSubject: string
  legendCamera: string
  start: string
  end: string
  continue: string
  footer: string
  action: string
  camera: string
  sound: string
  narration: string
  dialogue: string
  seconds: (a: number, b: number) => string
  total: (n: number) => string
  shotRange: (n: number, a: number, b: number) => string
}

const TEXT: Record<ContentLanguage, BoardText> = {
  zh: {
    rule: '同镜号 A/B/C 为连续动作，不切镜；镜号变化才切镜。',
    legendSubject: '红箭头：人物 / 道具动作', legendCamera: '蓝箭头：摄影机运动',
    start: '本段开始：', end: '本段结束：', continue: '同镜持续', footer: '标注仅用于制作，不出现在成片中。',
    action: '动作：', camera: '运镜：', sound: '声音：', narration: '旁白：', dialogue: '台词：',
    seconds: (a, b) => `${a}-${b}秒`, total: n => `${n}秒`, shotRange: (n, a, b) => `Shot ${n}：${a}-${b}秒`,
  },
  en: {
    rule: 'Same shot number A/B/C = continuous action, no cut; a new shot number means a cut.',
    legendSubject: 'Red arrow: character / prop action', legendCamera: 'Blue arrow: camera movement',
    start: 'Segment start: ', end: 'Segment end: ', continue: 'same shot continues', footer: 'Annotations are for production only and do not appear in the final film.',
    action: 'Action: ', camera: 'Camera: ', sound: 'Sound: ', narration: 'Narration: ', dialogue: 'Dialogue: ',
    seconds: (a, b) => `${a}-${b}s`, total: n => `${n}s`, shotRange: (n, a, b) => `Shot ${n}: ${a}-${b}s`,
  },
  ja: {
    rule: '同じカット番号の A/B/C は連続動作でカットしない。カット番号が変わるとカット。',
    legendSubject: '赤矢印：人物 / 小道具の動き', legendCamera: '青矢印：カメラの動き',
    start: 'このパートの開始：', end: 'このパートの終了：', continue: '同カット継続', footer: '注記は制作用で、完成映像には表示されない。',
    action: '動作：', camera: 'カメラ：', sound: '音：', narration: 'ナレーション：', dialogue: 'セリフ：',
    seconds: (a, b) => `${a}-${b}秒`, total: n => `${n}秒`, shotRange: (n, a, b) => `Shot ${n}：${a}-${b}秒`,
  },
  ko: {
    rule: '같은 컷 번호의 A/B/C는 연속 동작으로 컷하지 않음. 컷 번호가 바뀌면 컷.',
    legendSubject: '빨간 화살표: 인물 / 소품 동작', legendCamera: '파란 화살표: 카메라 움직임',
    start: '이 구간 시작: ', end: '이 구간 끝: ', continue: '같은 컷 지속', footer: '주석은 제작용이며 완성 영상에는 나타나지 않음.',
    action: '동작: ', camera: '카메라: ', sound: '소리: ', narration: '내레이션: ', dialogue: '대사: ',
    seconds: (a, b) => `${a}-${b}초`, total: n => `${n}초`, shotRange: (n, a, b) => `Shot ${n}: ${a}-${b}초`,
  },
}

/** 场景头「内景 · 指挥所 | 深夜」→ 故事板标题「内景 指挥所 - 深夜」 */
export function boardHeading(heading: string | null | undefined, fallback: string) {
  const h = (heading || '').trim()
  if (!h) return fallback
  return h.replace(/\s*[·・]\s*/g, ' ').replace(/\s*[|｜]\s*/g, ' - ')
}

/** 按格数选画幅：1 格 4:3，2 格 16:9，3-4 格 21:9（像素数落在 Seedream 允许范围内） */
export function boardImageSize(panels: number) {
  if (panels <= 1) return '2304x1728'
  if (panels === 2) return '2560x1440'
  return '3024x1296'
}

function panelTitle(shot: BoardShot, beat: BoardBeat, beatIndex: number, T: BoardText) {
  if (beatIndex > 0) return `${beat.code}｜${T.continue}`
  return `${beat.code}｜${shot.size}｜${T.seconds(shot.start, shot.end)}`
}

function panelLines(shot: BoardShot, beat: BoardBeat, beatIndex: number, T: BoardText) {
  const camera = beatIndex === 0 ? [shot.angle, shot.movement].filter(Boolean).join('，') : beat.camera
  return [
    `${T.action}${beat.action}`,
    camera ? `${T.camera}${camera}` : '',
    beat.sound ? `${T.sound}${beat.sound}` : '',
    beat.narration ? `${T.narration}${beat.narration}` : '',
    ...(beat.dialogue || []).map(d => `${T.dialogue}${d.speaker}：「${d.line}」`),
  ].filter(Boolean)
}

export interface BoardImagePromptInput {
  board: Board
  heading: string
  duration: number
  /** 参考图说明：第 N 张参考图是谁 */
  refs: { name: string; kind: 'scene' | 'character' | 'prop' }[]
  stylePrompt?: string
  lang?: ContentLanguage | null
}

/** 拼装故事板出图提示词（版式 + 每格内容 + 参考图说明 + 风格） */
export function buildBoardImagePrompt(input: BoardImagePromptInput): string {
  const T = TEXT[input.lang || 'zh'] || TEXT.zh
  const panels = boardPanels(input.board)
  const shotRanges = input.board.shots.map(s => T.shotRange(s.no, s.start, s.end)).join('　')
  const refDesc = input.refs.map((r, i) => {
    const kind = r.kind === 'scene' ? '场景' : r.kind === 'character' ? '人物' : '道具'
    return `图${i + 1}是${kind}「${r.name}」`
  }).join('；')

  const panelDesc = panels.map((p, i) => {
    const cut = i > 0 && p.beatIndex === 0
    const arrows = [
      p.beat.subject_arrow ? `画面上用红色箭头标注人物/道具动作方向，箭头旁写「${p.beat.subject_arrow}」` : '',
      p.beat.camera_arrow ? `画面上用蓝色箭头标注摄影机运动，箭头旁写「${p.beat.camera_arrow}」` : '',
    ].filter(Boolean).join('；')
    return [
      `第${i + 1}格：标题栏写「${panelTitle(p.shot, p.beat, p.beatIndex, T)}」${cut ? '，标题栏左上角有红底白字「CUT」标记' : ''}`,
      `画面（${p.shot.size}，${p.shot.angle || ''}）：${p.beat.frame || p.beat.action}`,
      arrows,
      `画面下方文字区逐行写：${panelLines(p.shot, p.beat, p.beatIndex, T).map(l => `「${l}」`).join('、')}`,
    ].filter(Boolean).join('。')
  })

  return [
    `一张专业影视分镜故事板（storyboard sheet），白色背景，横版排版，整洁的制作文档风格，共 ${panels.length} 格画面横向等宽并排。`,
    `顶部左侧粗体大标题：「${input.heading}｜${T.total(input.duration)}」；标题下方一行小字：「${T.rule}」。`,
    `顶部中间一个细线方框，内写：「${shotRanges}」。顶部右侧图例：红色箭头配文字「${T.legendSubject}」，蓝色箭头配文字「${T.legendCamera}」。`,
    `标题下方一条浅蓝色横条，居中写：「${T.start}${input.board.start_state}」。`,
    ...panelDesc,
    `画格下方一条浅蓝色横条，居中写：「${T.end}${input.board.end_state}」。右下角小字：「${T.footer}」。`,
    refDesc ? `参考图：${refDesc}。画格中的人物、场景、道具外观必须与对应参考图一致。` : '',
    `画格内的画面为电影剧照质感，光影与构图专业${input.stylePrompt ? `，画面风格：${input.stylePrompt}` : ''}。`,
    '所有文字清晰可读、不要错字、不要重复、不要乱码；文字只出现在标题栏、横条与文字区，不要写进画面内容里。',
  ].filter(Boolean).join('\n')
}

/** 为一段生成新版本故事板图；返回版本 ID 与生图任务 ID */
export async function generateBoardImage(storyboardId: number, opts: { configId?: number; model?: string } = {}) {
  const b = await loadStoryboardBindings(storyboardId)
  if (!b) throw new Error('分镜不存在')
  const board = parseBoard(b.storyboard.board)
  if (!board) throw new Error('该分镜还没有故事板，请先生成故事板')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, b.storyboard.episodeId))
  if (!ep) throw new Error('剧集不存在')

  const [scriptScene] = b.storyboard.scriptScene
    ? (await db.select().from(schema.episodeScriptScenes).where(eq(schema.episodeScriptScenes.episodeId, ep.id)))
      .filter(s => s.sceneNo === b.storyboard.scriptScene)
    : []
  const refs = orderedReferenceAssets(b, MAX_BOARD_REFS)
  const prompt = buildBoardImagePrompt({
    board,
    heading: boardHeading(scriptScene?.heading, b.storyboard.title || `#${b.storyboard.storyboardNumber}`),
    duration: b.storyboard.duration || board.shots[board.shots.length - 1]?.end || 0,
    refs: refs.map(r => ({ name: r.name, kind: r.kind })),
    stylePrompt: await getDramaStylePrompt(ep.dramaId),
    lang: getContentLanguage(),
  })

  const [last] = await db.select().from(schema.storyboardBoardVersions)
    .where(eq(schema.storyboardBoardVersions.storyboardId, storyboardId))
    .orderBy(desc(schema.storyboardBoardVersions.version)).limit(1)
  const res = await db.insert(schema.storyboardBoardVersions).values({
    storyboardId, version: (last?.version || 0) + 1, prompt, createdAt: now(),
  })
  const versionId = getInsertId(res)
  const taskId = await generateImage({
    storyboardId,
    dramaId: ep.dramaId,
    prompt,
    model: opts.model,
    size: boardImageSize(boardPanels(board).length),
    referenceImages: refs.map(r => r.imageUrl),
    frameType: 'board',
    boardVersionId: versionId,
    configId: opts.configId ?? ep.imageConfigId ?? undefined,
  })
  await db.update(schema.storyboardBoardVersions).set({ taskId }).where(eq(schema.storyboardBoardVersions.id, versionId))
  return { versionId, taskId }
}

/** 版本列表（附生图任务状态） */
export async function listBoardVersions(storyboardId: number) {
  const versions = await db.select().from(schema.storyboardBoardVersions)
    .where(eq(schema.storyboardBoardVersions.storyboardId, storyboardId))
    .orderBy(desc(schema.storyboardBoardVersions.version))
  const out = []
  for (const v of versions) {
    const [task] = v.taskId ? await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, v.taskId)) : []
    out.push({
      id: v.id,
      version: v.version,
      image_url: v.imageUrl,
      prompt: v.prompt,
      status: v.imageUrl ? 'completed' : task?.status === 'failed' ? 'failed' : 'processing',
      error: task?.status === 'failed' ? task.errorMsg : null,
      created_at: v.createdAt,
    })
  }
  return out
}

/** 选定某个已出图版本为当前故事板 */
export async function selectBoardVersion(storyboardId: number, versionId: number) {
  const [v] = await db.select().from(schema.storyboardBoardVersions).where(eq(schema.storyboardBoardVersions.id, versionId))
  if (!v || v.storyboardId !== storyboardId) throw new Error('版本不存在')
  if (!v.imageUrl) throw new Error('该版本还没有出图')
  await db.update(schema.storyboards).set({
    boardImageUrl: v.imageUrl, boardVersionId: v.id, boardStatus: 'pending', updatedAt: now(),
  }).where(eq(schema.storyboards.id, storyboardId))
}

export const BOARD_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const

export async function reviewBoard(storyboardId: number, status: typeof BOARD_REVIEW_STATUSES[number]) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  if (!sb.board) throw new Error('该分镜还没有故事板')
  await db.update(schema.storyboards).set({ boardStatus: status, updatedAt: now() }).where(eq(schema.storyboards.id, storyboardId))
}
