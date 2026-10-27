/**
 * 文本 Agent 异步任务 — 落库于 agent_tasks 表
 * 改写 / 资产提取 / 分镜拆解 / 视频提示词批量 统一走这里：立即返回任务 ID，后台执行，前端轮询。
 * 同集同类（同 target）任务运行中不重复启动；后端重启时运行中的任务标记为 interrupted。
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

export type AgentTaskKind = 'rewrite' | 'extract' | 'breakdown' | 'video_prompts'
export type AgentTaskStatus = 'running' | 'done' | 'failed' | 'interrupted'
export type AgentTaskRow = typeof schema.agentTasks.$inferSelect

export interface AgentTaskProgress {
  setTotal(total: number): Promise<void>
  /** 记录一项完成（ok=false 计入失败），可附带当前处理对象 */
  step(ok: boolean, currentRef?: string | null): Promise<void>
  setCurrent(currentRef: string | null): Promise<void>
}

interface StartOptions {
  kind: AgentTaskKind
  agentType: string
  target?: string | null
  dramaId: number
  episodeId: number
  total?: number
}

/** 任务执行体：返回值写入 result（JSON）；抛错即任务失败 */
export type AgentTaskJob = (progress: AgentTaskProgress, taskId: number) => Promise<Record<string, unknown> | void>

/** 同步查询（better-sqlite3）：与插入之间无 await，保证「查重 + 创建」原子 */
export function findRunningAgentTask(episodeId: number, kind: AgentTaskKind, target?: string | null): AgentTaskRow | null {
  const rows = db.select().from(schema.agentTasks).where(and(
    eq(schema.agentTasks.episodeId, episodeId),
    eq(schema.agentTasks.kind, kind),
    eq(schema.agentTasks.status, 'running'),
  )).all()
  return rows.find(r => (r.target || null) === (target || null)) || null
}

/** 启动后台任务；同集同类同 target 已在运行时返回 { started: false, task: 运行中的任务 } */
export async function startAgentTask(opts: StartOptions, job: AgentTaskJob): Promise<{ started: boolean; task: AgentTaskRow }> {
  const running = findRunningAgentTask(opts.episodeId, opts.kind, opts.target)
  if (running) return { started: false, task: running }

  const ts = now()
  const res = db.insert(schema.agentTasks).values({
    kind: opts.kind,
    agentType: opts.agentType,
    target: opts.target || null,
    dramaId: opts.dramaId,
    episodeId: opts.episodeId,
    status: 'running',
    total: opts.total || 0,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const id = getInsertId(res)
  const label = opts.target ? `${opts.kind}:${opts.target}` : opts.kind
  logTaskStart('AgentTask', label, { taskId: id, episodeId: opts.episodeId, dramaId: opts.dramaId })

  const counters = { completed: 0, failed: 0 }
  const progress: AgentTaskProgress = {
    async setTotal(total) {
      await db.update(schema.agentTasks).set({ total, updatedAt: now() }).where(eq(schema.agentTasks.id, id))
    },
    async step(ok, currentRef) {
      if (ok) counters.completed++
      else counters.failed++
      await db.update(schema.agentTasks).set({
        completed: counters.completed,
        failed: counters.failed,
        ...(currentRef !== undefined ? { currentRef } : {}),
        updatedAt: now(),
      }).where(eq(schema.agentTasks.id, id))
    },
    async setCurrent(currentRef) {
      await db.update(schema.agentTasks).set({ currentRef, updatedAt: now() }).where(eq(schema.agentTasks.id, id))
    },
  }

  void (async () => {
    try {
      const result = await job(progress, id)
      await db.update(schema.agentTasks).set({
        status: 'done',
        currentRef: null,
        result: result ? JSON.stringify(result) : null,
        updatedAt: now(),
        finishedAt: now(),
      }).where(eq(schema.agentTasks.id, id))
      logTaskSuccess('AgentTask', label, { taskId: id, ...counters })
    } catch (err: any) {
      const message = err?.message || 'Agent 任务失败'
      await db.update(schema.agentTasks).set({
        status: 'failed',
        currentRef: null,
        error: message,
        updatedAt: now(),
        finishedAt: now(),
      }).where(eq(schema.agentTasks.id, id))
      logTaskError('AgentTask', label, { taskId: id, error: message })
    }
  })()

  const [task] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id))
  return { started: true, task }
}

export async function getAgentTask(id: number): Promise<AgentTaskRow | null> {
  const [row] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id))
  return row || null
}

/** 某集某类任务的最新一条（target 为空则不按 target 过滤） */
export async function latestAgentTask(episodeId: number, kind: AgentTaskKind, target?: string | null): Promise<AgentTaskRow | null> {
  const rows = await db.select().from(schema.agentTasks)
    .where(and(eq(schema.agentTasks.episodeId, episodeId), eq(schema.agentTasks.kind, kind)))
    .orderBy(desc(schema.agentTasks.id))
  return (target === undefined ? rows[0] : rows.find(r => (r.target || null) === (target || null))) || null
}

/** 某集当前运行中的全部 Agent 任务（页面刷新后恢复进度展示） */
export async function runningAgentTasks(episodeId: number): Promise<AgentTaskRow[]> {
  return db.select().from(schema.agentTasks)
    .where(and(eq(schema.agentTasks.episodeId, episodeId), eq(schema.agentTasks.status, 'running')))
}

/** 启动时调用：上次进程内运行中的任务已随进程中断，标记为 interrupted */
export async function markInterruptedAgentTasks() {
  const rows = await db.select({ id: schema.agentTasks.id }).from(schema.agentTasks)
    .where(eq(schema.agentTasks.status, 'running'))
  if (!rows.length) return
  const ts = now()
  await db.update(schema.agentTasks).set({
    status: 'interrupted',
    error: '服务重启，任务已中断，请重新执行',
    currentRef: null,
    updatedAt: ts,
    finishedAt: ts,
  }).where(inArray(schema.agentTasks.id, rows.map(r => r.id)))
  logTaskWarn('AgentTask', 'interrupted-on-startup', { count: rows.length })
}

/** API 输出：result 解析为对象 */
export function serializeAgentTask(row: AgentTaskRow | null) {
  if (!row) return null
  let result: unknown = null
  try { result = row.result ? JSON.parse(row.result) : null } catch { result = null }
  return {
    id: row.id,
    kind: row.kind,
    agent_type: row.agentType,
    target: row.target,
    episode_id: row.episodeId,
    status: row.status,
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    current_ref: row.currentRef,
    result,
    error: row.error,
    started_at: row.createdAt,
    updated_at: row.updatedAt,
    finished_at: row.finishedAt,
  }
}
