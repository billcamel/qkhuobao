/**
 * 视频提示词生成 — prompt_generator Agent 逐分镜生成 video_prompt
 * - 单个分镜：generateStoryboardVideoPrompt（同步，供单镜按钮与批量复用）
 * - 批量：agent_tasks 表跟踪（kind=video_prompts），按 VIDEO_PROMPT_CONCURRENCY 并发
 * 上下文只读单个分镜（read_storyboard_detail），保存只写 video_prompt（save_video_prompt）
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'
import { runAgent, type TextModelOptions } from './agent-runner.js'
import { rederiveBoardText } from './board-store.js'
import { latestAgentTask, startAgentTask, type AgentTaskProgress, type AgentTaskRow } from './agent-tasks.js'

type StoryboardRow = typeof schema.storyboards.$inferSelect

export interface VideoPromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

/** 批量并发数：默认 3；中转站限流严格时可调小 */
const CONCURRENCY = Math.max(1, Number(process.env.VIDEO_PROMPT_CONCURRENCY || 3) || 3)

/** 视频模型标签：跟随该集锁定的视频配置，供 Agent 按模型特性生成 */
export async function episodeVideoModelLabel(episodeId: number): Promise<string> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (ep?.videoConfigId) {
    const [cfg] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId))
    if (cfg) return `${cfg.name} (${cfg.provider})`
  }
  return '默认'
}

function videoPromptMessage(sb: StoryboardRow, videoLabel: string) {
  return `请为分镜 #${sb.storyboardNumber}(storyboard_id=${sb.id})生成视频提示词(video_prompt)。视频模型：${videoLabel}，请按该模型的特性和时长限制生成。先调用 read_storyboard_detail 读取该分镜，再调用 save_video_prompt 保存；不要改动其他分镜。`
}

/** 为单个分镜生成并保存 video_prompt；以实际落库为准，失败抛错 */
export async function generateStoryboardVideoPrompt(
  sb: StoryboardRow,
  dramaId: number,
  opts: TextModelOptions & { videoLabel?: string } = {},
): Promise<string> {
  // 故事板段：视频提示词由故事板确定性推导（开场 → 按镜时间轴 → 结尾），不让大模型改写偏离故事板
  if (sb.board) {
    const derived = await rederiveBoardText(sb.id)
    if (derived) return derived
  }
  const before = sb.videoPrompt || ''
  const startedAt = new Date().toISOString()
  const videoLabel = opts.videoLabel || await episodeVideoModelLabel(sb.episodeId)
  await runAgent('prompt_generator', videoPromptMessage(sb, videoLabel), {
    model: opts.model,
    configId: opts.configId,
    episodeId: sb.episodeId,
    dramaId,
    maxSteps: 8,
  })
  const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
  const prompt = (fresh?.videoPrompt || '').trim()
  // 重新生成时旧提示词非空：要求本次确实写入过（updatedAt 晚于开始时间或内容变化）
  const saved = prompt && (prompt !== before.trim() || (fresh?.updatedAt || '') >= startedAt)
  if (!saved) throw new Error('Agent 已结束但没有保存视频提示词')
  return prompt
}

/** 有限并发执行，单项失败不影响其他项 */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await worker(item)
    }
  })
  await Promise.all(lanes)
}

/** 批量为若干分镜生成 video_prompt，进度写入任务；返回失败的分镜号 */
export async function fillVideoPrompts(
  storyboards: StoryboardRow[],
  dramaId: number,
  progress: AgentTaskProgress,
  opts: TextModelOptions & { videoLabel?: string } = {},
): Promise<number[]> {
  const failedShots: number[] = []
  await runPool(storyboards, CONCURRENCY, async (sb) => {
    await progress.setCurrent(String(sb.id))
    logTaskProgress('VideoPrompt', 'shot', { episodeId: sb.episodeId, storyboardId: sb.id })
    try {
      await generateStoryboardVideoPrompt(sb, dramaId, opts)
      await progress.step(true)
    } catch (err: any) {
      failedShots.push(sb.storyboardNumber)
      logTaskError('VideoPrompt', 'shot', { storyboardId: sb.id, error: err?.message })
      await progress.step(false)
    }
  })
  return failedShots.sort((a, b) => a - b)
}

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: TextModelOptions = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const pending = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    : sbs.filter(sb => !(sb.videoPrompt || '').trim())
  if (!pending.length) return { started: false, total: 0 }

  const videoLabel = await episodeVideoModelLabel(episodeId)
  const { started } = await startAgentTask(
    { kind: 'video_prompts', agentType: 'prompt_generator', episodeId, dramaId, total: pending.length },
    async (progress) => {
      const failedShots = await fillVideoPrompts(pending, dramaId, progress, { ...opts, videoLabel })
      return { failed_shots: failedShots }
    },
  )
  if (!started) return { started: false, total: -1 }
  return { started: true, total: pending.length }
}

function toBatchStatus(row: AgentTaskRow | null): VideoPromptBatchStatus | null {
  if (!row) return null
  return {
    status: row.status === 'running' ? 'running' : row.status === 'done' ? 'done' : 'error',
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    current_storyboard_id: row.currentRef ? Number(row.currentRef) : undefined,
    started_at: row.createdAt,
    finished_at: row.finishedAt || undefined,
    error: row.error || undefined,
  }
}

export async function getVideoPromptBatchStatus(episodeId: number): Promise<VideoPromptBatchStatus | null> {
  return toBatchStatus(await latestAgentTask(episodeId, 'video_prompts'))
}
