/**
 * 故事板出图 — 每段一次图像模型调用，整张生成带文字/箭头的故事板图
 * 出图提示词由故事板 JSON 按模板确定性拼装（不经 LLM），参考图挂该段绑定的场景/角色/道具图，
 * 每次出图新建一个版本（storyboard_board_versions），完成后由 generation 回写为该段当前故事板（待审核）
 */
import { desc, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskWarn } from '../utils/task-logger.js'
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

/** 画面描述里出现「人」的字眼时不判为空镜（人群、背影、队伍等） */
const HUMAN_WORDS = /人|队伍|战士|士兵|兵|身影|背影|众|他|她|们|手|脚|脸|character|person|people|soldier|crowd|figure|人物|キャラ|兵士|사람|병사|군인/i

/** 场景头「内景 · 指挥所 | 深夜」→ 故事板标题「内景 指挥所 - 深夜」 */
export function boardHeading(heading: string | null | undefined, fallback: string) {
  const h = (heading || '').trim()
  if (!h) return fallback
  return h.replace(/\s*[·・]\s*/g, ' ').replace(/\s*[|｜]\s*/g, ' - ')
}

/** 项目画幅 "9:16" → 宽高比；非法值按 16:9 */
export function parseAspect(aspect?: string | null) {
  const m = String(aspect || '').match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  const w = m ? Number(m[1]) : 16
  const h = m ? Number(m[2]) : 9
  return { label: m ? `${m[1]}:${m[2]}` : '16:9', ratio: w / h, portrait: h > w }
}

/** 故事板整页画幅：横幅画格 1 格 4:3、2 格 16:9、3-4 格 21:9；竖幅画格整体收窄一档（像素数落在 Seedream 允许范围内） */
export function boardImageSize(panels: number, aspect?: string | null) {
  const portrait = parseAspect(aspect).portrait
  const sizes = portrait
    ? ['1728x2304', '2304x1728', '2560x1440', '3024x1296']
    : ['2304x1728', '2560x1440', '3024x1296', '3024x1296']
  return sizes[Math.min(Math.max(panels, 1), 4) - 1]
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
  /** 项目画幅（如 9:16），决定每格画面的比例 */
  aspect?: string | null
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

  // 每格出场人物：绑定角色中名字出现在该格画面/动作描述里的人。实测不写明时模型会凭空加人或把同一角色画两次
  const characterNames = input.refs.filter(r => r.kind === 'character').map(r => r.name).filter(Boolean)
  const panelPeople = (beat: BoardBeat) => {
    const text = `${beat.frame || ''}${beat.action}`
    return characterNames.filter(n => text.includes(n))
  }
  const panelDesc = panels.map((p, i) => {
    const cut = i > 0 && p.beatIndex === 0
    const people = panelPeople(p.beat)
    const text = `${p.beat.frame || ''}${p.beat.action}`
    const empty = !people.length && !HUMAN_WORDS.test(text.replace(/^空镜[：:]/, ''))
    const cast = people.length
      ? `这一格出场的设定人物：${people.join('、')}，每人只画一次，不要重复画同一个人`
      : HUMAN_WORDS.test(text)
        ? '这一格没有设定人物出场：只画画面描述中写到的人（如人群、背影），不要添加有清晰面孔的人物'
        // 实测：「特写 + 侧对雨幕」这类空镜，模型会脑补出一个人物特写，必须明确写空镜
        : '这一格是空镜：画面中没有任何人物，不要出现人脸、人影或身体局部'
    const arrows = [
      p.beat.subject_arrow ? `画面上用红色箭头标注人物/道具动作方向，箭头旁写「${p.beat.subject_arrow}」` : '',
      p.beat.camera_arrow ? `画面上用蓝色箭头标注摄影机运动，箭头旁写「${p.beat.camera_arrow}」` : '',
    ].filter(Boolean).join('；')
    return [
      `第${i + 1}格：标题栏写「${panelTitle(p.shot, p.beat, p.beatIndex, T)}」${cut ? '，标题栏左上角有红底白字「CUT」标记' : ''}`,
      // 空镜：先声明无人，再写镜头对准的物体；不写机位角度（「侧对雨幕」会被读成人物朝向，实测会画出人物特写）
      empty
        ? `画面（空镜${p.shot.size}，无人物，镜头对准的是景物本身）：${(p.beat.frame || p.beat.action).replace(/^空镜[：:]\s*/, '')}`
        : `画面（${p.shot.size}，${p.shot.angle || ''}）：${p.beat.frame || p.beat.action}`,
      cast,
      arrows,
      `画面下方文字区逐行写：${panelLines(p.shot, p.beat, p.beatIndex, T).map(l => `「${l}」`).join('、')}`,
    ].filter(Boolean).join('。')
  })

  return [
    `一张专业影视分镜故事板（storyboard sheet），白色背景，横版排版，整洁的制作文档风格，共 ${panels.length} 格画面横向等宽并排，每格画面比例为 ${parseAspect(input.aspect).label}（${parseAspect(input.aspect).portrait ? '竖幅' : '横幅'}）。`,
    `顶部左侧粗体大标题：「${input.heading}｜${T.total(input.duration)}」；标题下方一行小字：「${T.rule}」。`,
    `顶部中间一个细线方框，内写：「${shotRanges}」。顶部右侧图例：红色箭头配文字「${T.legendSubject}」，蓝色箭头配文字「${T.legendCamera}」。`,
    `标题下方一条浅蓝色横条，居中写：「${T.start}${input.board.start_state}」。`,
    ...panelDesc,
    `画格下方一条浅蓝色横条，居中写：「${T.end}${input.board.end_state}」。右下角小字：「${T.footer}」。`,
    refDesc ? `参考图：${refDesc}。画格中的人物、场景、道具外观必须与对应参考图一致。` : '',
    '每一格只画该格描述里的人物，同一个人物在同一格中只能出现一次，不要凭空添加其他角色。',
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
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId))

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
    aspect: drama?.aspectRatio,
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
    size: boardImageSize(boardPanels(board).length, drama?.aspectRatio),
    referenceImages: refs.map(r => r.imageUrl),
    frameType: 'board',
    boardVersionId: versionId,
    configId: opts.configId ?? ep.imageConfigId ?? undefined,
  })
  await db.update(schema.storyboardBoardVersions).set({ taskId }).where(eq(schema.storyboardBoardVersions.id, versionId))
  return { versionId, taskId }
}

async function cleanTaskStatus(taskId: number) {
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  return task?.status === 'failed' ? 'failed' : 'processing'
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
      clean_image_url: v.cleanImageUrl,
      clean_status: v.cleanImageUrl ? 'completed' : v.cleanTaskId ? (await cleanTaskStatus(v.cleanTaskId)) : 'none',
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

// ─── 净版关键帧图（视频参考用） ─────────────────────────────────────
// 实测：带文字/箭头的故事板直接喂给视频模型，构图约束很好，但箭头等标注会被画进视频开头。
// 因此视频参考改用净版：以故事板图为参考做编辑，只保留画格画面，去掉所有制作标注。

/** 净版画幅：画格按项目画幅横向等宽拼接，单格高 1080（横幅）/ 1920（竖幅），总宽不超过 4096 */
export function cleanBoardSize(panels: number, aspect?: string | null) {
  const { ratio, portrait } = parseAspect(aspect)
  const n = Math.max(panels, 1)
  let height = portrait ? 1920 : 1080
  if (n * height * ratio > 4096) height = 4096 / (n * ratio)
  const round8 = (v: number) => Math.max(8, Math.round(v / 8) * 8)
  return `${round8(n * height * ratio)}x${round8(height)}`
}

export function buildCleanBoardPrompt(panels: number, aspect?: string | null) {
  const { label, portrait } = parseAspect(aspect)
  const frame = `每格画面比例为 ${label}（${portrait ? '竖幅' : '横幅'}）`
  const layout = panels <= 1
    ? `只输出这一格画面，铺满整张图，${frame}`
    : `把 ${panels} 格画面按原顺序从左到右等宽横向并排，${frame}，格与格之间没有间隙`
  return [
    '参考图是一张电影分镜故事板。请只保留其中的画格画面内容，生成一张干净的关键帧拼图。',
    `${layout}。`,
    '画面中的人物、服装、道具、场景、构图、机位、光线与色调必须与参考图中对应画格完全一致。',
    '彻底去掉所有文字、标题、标题栏、Shot 时间框、图例、红色和蓝色箭头、箭头旁的文字、CUT 标记、浅蓝色横条、边框和白色背景；画面里不能出现任何文字、箭头或标注。',
  ].join('\n')
}

/** 为某个已出图版本生成净版关键帧图（已生成或生成中则跳过）；返回生图任务 ID 或 null */
export async function generateCleanBoardImage(versionId: number, opts: { configId?: number; model?: string } = {}) {
  const [v] = await db.select().from(schema.storyboardBoardVersions).where(eq(schema.storyboardBoardVersions.id, versionId))
  if (!v?.imageUrl || v.cleanImageUrl) return null
  if (v.cleanTaskId) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, v.cleanTaskId))
    if (task?.status === 'processing') return null
  }
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, v.storyboardId))
  const board = parseBoard(sb?.board)
  if (!sb || !board) return null
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  const [drama] = ep ? await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)) : []
  const panels = boardPanels(board).length
  const taskId = await generateImage({
    storyboardId: sb.id,
    dramaId: ep?.dramaId,
    prompt: buildCleanBoardPrompt(panels, drama?.aspectRatio),
    model: opts.model,
    size: cleanBoardSize(panels, drama?.aspectRatio),
    referenceImages: [v.imageUrl],
    frameType: 'board_clean',
    boardVersionId: v.id,
    configId: opts.configId ?? ep?.imageConfigId ?? undefined,
  })
  await db.update(schema.storyboardBoardVersions).set({ cleanTaskId: taskId }).where(eq(schema.storyboardBoardVersions.id, v.id))
  return taskId
}

/** 视频参考用的故事板图：当前版本的净版（未生成时返回 null，调用方不挂故事板参考，避免标注泄漏） */
export async function videoReferenceBoardImage(storyboardId: number): Promise<string | null> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb?.boardVersionId) return null
  const [v] = await db.select().from(schema.storyboardBoardVersions).where(eq(schema.storyboardBoardVersions.id, sb.boardVersionId))
  return v?.cleanImageUrl || null
}

export const BOARD_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const

/** 审核故事板；审核通过时自动为当前版本生成净版关键帧图（供视频参考） */
export async function reviewBoard(storyboardId: number, status: typeof BOARD_REVIEW_STATUSES[number]) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  if (!sb.board) throw new Error('该分镜还没有故事板')
  await db.update(schema.storyboards).set({ boardStatus: status, updatedAt: now() }).where(eq(schema.storyboards.id, storyboardId))
  if (status === 'approved' && sb.boardVersionId) {
    try {
      await generateCleanBoardImage(sb.boardVersionId)
    } catch (err: any) {
      logTaskWarn('BoardImage', 'clean-generate-failed', { storyboardId, error: err?.message })
    }
  }
}
