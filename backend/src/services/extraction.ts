/**
 * 资产提取任务 — 异步执行，按「集 × 类型」粒度跟踪（agent_tasks 表，kind=extract，target=类型）
 * 角色 / 场景 / 道具 可分别单独提取，同一集的不同类型可并行
 * 提取规则（字段、道具判定、去重）只写在 extractor prompt 与技能中，这里的消息只限定提取范围
 */
import { runAgent, calledTools, type TextModelOptions } from './agent-runner.js'
import { latestAgentTask, startAgentTask, type AgentTaskRow } from './agent-tasks.js'

export type ExtractTarget = 'characters' | 'scenes' | 'props'
export const EXTRACT_TARGETS: ExtractTarget[] = ['characters', 'scenes', 'props']

export interface ExtractTask {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  error?: string
}

const EXTRACT_MESSAGES: Record<ExtractTarget, string> = {
  characters: '请提取本集剧本中的角色：先用 read_existing_characters 读取项目已有角色去重（同名或近名直接复用），再用 save_dedup_characters 保存。本次只提取角色，不要提取场景和道具。',
  scenes: '请提取本集剧本中的场景：先用 read_existing_scenes 读取项目已有场景去重，再用 save_dedup_scenes 保存。本次只提取场景，不要提取角色和道具。',
  props: '请按道具判定标准提取本集的关键道具（宁可少提，没有就传空数组）：先用 read_existing_props 读取项目已有道具去重，再用 save_dedup_props 保存。本次只提取道具，不要提取角色和场景。',
}

const SAVE_TOOL: Record<ExtractTarget, string> = {
  characters: 'save_dedup_characters',
  scenes: 'save_dedup_scenes',
  props: 'save_dedup_props',
}

/** 同步执行一类资产提取（供故事板生成前补齐资产）；未保存时抛错 */
export async function runExtraction(episodeId: number, dramaId: number, target: ExtractTarget, opts: TextModelOptions = {}) {
  const result = await runAgent('extractor', EXTRACT_MESSAGES[target], {
    ...opts, episodeId, dramaId, maxSteps: 20, logScope: 'Extract',
  })
  if (!calledTools(result).includes(SAVE_TOOL[target])) {
    throw new Error('Agent 已结束但没有保存提取结果，请重试或更换文本模型')
  }
  return result
}

/** 启动异步提取任务（立即返回）；同集同类型已在运行时返回 false；可指定文本模型覆盖 */
export async function startExtraction(episodeId: number, dramaId: number, target: ExtractTarget, opts: TextModelOptions = {}): Promise<boolean> {
  const { started } = await startAgentTask(
    { kind: 'extract', agentType: 'extractor', target, episodeId, dramaId },
    async () => {
      // 以是否实际调用保存工具判定：Agent「正常结束」但没保存是常见的静默失败
      const result = await runExtraction(episodeId, dramaId, target, opts)
      return { reply: (result?.text || '').slice(0, 300) }
    },
  )
  return started
}

function toExtractTask(row: AgentTaskRow | null): ExtractTask | null {
  if (!row) return null
  return {
    status: row.status === 'running' ? 'running' : row.status === 'done' ? 'done' : 'error',
    started_at: row.createdAt,
    finished_at: row.finishedAt || undefined,
    error: row.error || undefined,
  }
}

/** 查询某集三类资产的提取任务状态（未启动过的类型为 null） */
export async function getExtractionStatus(episodeId: number): Promise<Record<ExtractTarget, ExtractTask | null>> {
  const result = {} as Record<ExtractTarget, ExtractTask | null>
  for (const target of EXTRACT_TARGETS) result[target] = toExtractTask(await latestAgentTask(episodeId, 'extract', target))
  return result
}
