/**
 * 文本 Agent 单次调用的公共封装：构建请求上下文 + 逐步日志
 */
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskProgress } from '../utils/task-logger.js'

/** 顶栏选择的文本模型/配置覆盖（不传则跟随 Agent 与文本配置默认） */
export interface TextModelOptions { model?: string; configId?: number }

export interface RunAgentOptions extends TextModelOptions {
  episodeId: number
  dramaId: number
  maxSteps: number
  /** 日志标签，如 Extract / Breakdown */
  logScope?: string
}

export async function runAgent(agentType: string, message: string, opts: RunAgentOptions) {
  const agent = mastra.getAgent(agentType)
  if (!agent) throw new Error(`Agent 不可用：${agentType}`)
  const requestContext = buildAgentRequestContext({
    episodeId: opts.episodeId,
    dramaId: opts.dramaId,
    modelOverride: opts.model || undefined,
    textConfigId: opts.configId || undefined,
  })
  return agent.generate([{ role: 'user', content: message }], {
    maxSteps: opts.maxSteps,
    requestContext,
    onStepFinish: opts.logScope
      ? (step: any) => {
          const tools = (step?.toolCalls || [])
            .map((t: any) => t?.toolName || t?.payload?.toolName)
            .filter(Boolean)
          logTaskProgress(opts.logScope!, `${agentType}-step`, {
            episodeId: opts.episodeId,
            tools: tools.length ? tools.join(',') : undefined,
            text: (step?.text || '').slice(0, 200) || undefined,
          })
        }
      : undefined,
  })
}

/** 工具名归一化：Mastra 记录的是 tools 对象的键（saveScript），统一转为工具 id 风格（save_script） */
export function toToolId(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** 统计一次 generate 结果中调用过的工具（返回工具 id 风格名字，如 save_script） */
export function calledTools(result: any): string[] {
  const names = new Set<string>()
  const add = (t: any) => {
    const name = t?.toolName || t?.payload?.toolName
    if (name) names.add(toToolId(name))
  }
  for (const step of result?.steps || []) for (const t of step?.toolCalls || []) add(t)
  for (const t of result?.toolCalls || []) add(t)
  return [...names]
}
