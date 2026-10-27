import { toast } from 'vue-sonner'
import { agentTaskAPI } from './useApi'
import { toastError } from './useToast'
import { i18n } from './i18n'

const POLL_INTERVAL_MS = 2500
// 整集拆分 + 补齐提示词可能持续较久；超过上限只停止前端等待，后端任务继续
const MAX_POLLS = 1440

export interface AgentTask {
  id: number
  kind: string
  agent_type: string
  status: 'running' | 'done' | 'failed' | 'interrupted'
  current_ref: string | null
  total: number
  completed: number
  failed: number
  result: any
  error: string | null
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 后端编排的异步 Agent 任务：start 返回 { task, already_running }，随后轮询 /agent/tasks/:id
 * running/runningType 保持旧语义（全局一个文本 Agent 运行中），progress 为补齐阶段的进度
 */
export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  // phase：后端任务当前阶段（故事板生成：extract 补资产 / design 设计 / fill 补提示词）
  const progress = ref<{ total: number; completed: number; phase: string | null } | null>(null)

  function report(task: AgentTask) {
    if (task.status === 'done') {
      const warnings: string[] = task.result?.warnings || []
      if (warnings.length) {
        toast.warning(i18n.global.t('composables.agent.doneWithWarnings', { n: warnings.length }), {
          description: warnings.slice(0, 3).join('\n') + (warnings.length > 3 ? '\n…' : ''),
          duration: 12000,
        })
      } else {
        toast.success(i18n.global.t('composables.agent.done'))
      }
      return
    }
    toastError(task.error, { fallback: 'composables.agent.failed' })
  }

  async function follow(type: string, task: AgentTask, onDone?: (task: AgentTask) => void) {
    running.value = true
    runningType.value = type
    try {
      let current = task
      for (let i = 0; current.status === 'running' && i < MAX_POLLS; i++) {
        await sleep(POLL_INTERVAL_MS)
        try {
          current = await agentTaskAPI.get(task.id) as AgentTask
          progress.value = { total: current.total, completed: current.completed + current.failed, phase: current.current_ref || null }
        } catch { /* 网络抖动：下一轮再试 */ }
      }
      if (current.status === 'running') return
      report(current)
      onDone?.(current)
    } finally {
      running.value = false
      runningType.value = null
      progress.value = null
    }
  }

  async function run(type: string, start: () => Promise<any>, onDone?: (task: AgentTask) => void) {
    if (running.value) { toast.warning(i18n.global.t('composables.agent.busy')); return }
    running.value = true
    runningType.value = type
    let res: any
    try {
      res = await start()
    } catch (err: any) {
      running.value = false
      runningType.value = null
      toastError(err)
      return
    }
    if (res?.already_running) toast.info(i18n.global.t('composables.agent.alreadyRunning'))
    await follow(type, res.task, onDone)
  }

  /** 页面刷新后恢复对运行中任务的跟踪 */
  function resume(type: string, task: AgentTask, onDone?: (task: AgentTask) => void) {
    if (running.value || task?.status !== 'running') return
    void follow(type, task, onDone)
  }

  return { running, runningType, progress, run, resume }
}
