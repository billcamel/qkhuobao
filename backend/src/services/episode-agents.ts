/**
 * 剧本改写 / 分镜拆解 — 后端编排的异步 Agent 任务（agent_tasks 表）
 * 发给 Agent 的消息只描述本次任务；规则在 prompt 与技能文件中。
 * Agent 结束后以落库结果判定成败，并对产出做规则校验（warnings 写入任务 result）。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskWarn } from '../utils/task-logger.js'
import { calledTools, runAgent, type TextModelOptions } from './agent-runner.js'
import { startAgentTask, type AgentTaskRow } from './agent-tasks.js'
import { boundRefNames, checkStoryboardDraft, loadStoryboardBindings } from './storyboard-refs.js'
import { episodeVideoModelLabel, fillVideoPrompts } from './video-prompts.js'
import { EXTRACT_TARGETS, runExtraction } from './extraction.js'
import { parseBoard, checkBoard } from './board.js'
import { normalizeSceneNo, parseScriptScenes } from './board-store.js'

type EpisodeRow = typeof schema.episodes.$inferSelect

/** 与 storyboard-breaker 技能的总量锚定一致：500 字/分钟、平均 12 秒/段 */
const CHARS_PER_MINUTE = 500
const AVG_SEGMENT_SECONDS = 12
/** 段落数偏离预期超过该比例才告警（技能允许 ±20%，留出余量避免噪音） */
const COUNT_TOLERANCE = 0.4

const SCENE_HEADER = /^##\s*S\d+/m

export async function startRewrite(ep: EpisodeRow, opts: TextModelOptions = {}): Promise<{ started: boolean; task: AgentTaskRow }> {
  return startAgentTask(
    { kind: 'rewrite', agentType: 'script_rewriter', episodeId: ep.id, dramaId: ep.dramaId },
    async () => {
      const result = await runAgent('script_rewriter', '请读取本集原始内容，改写为格式化剧本，并调用 save_script 保存完整剧本。', {
        ...opts, episodeId: ep.id, dramaId: ep.dramaId, maxSteps: 10, logScope: 'Rewrite',
      })
      const [fresh] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, ep.id))
      const script = (fresh?.scriptContent || '').trim()
      if (!calledTools(result).includes('save_script') || !script) {
        throw new Error('Agent 已结束但没有保存剧本，请重试或更换文本模型')
      }
      const sceneCount = (script.match(/^##\s*S\d+/gm) || []).length
      const warnings: string[] = []
      if (!SCENE_HEADER.test(script)) {
        warnings.push('剧本缺少场景头（## S编号 | 内景/外景 · 地点 | 时间段），后续资产提取与分镜拆解可能不准确')
      }
      return { script_length: script.length, scene_count: sceneCount, warnings }
    },
  )
}

/** 整集分镜规则校验：逐段校验 + 段数与剧本字数的总量对比 + 镜号连续性 */
export async function validateEpisodeStoryboards(episodeId: number, scriptLength: number) {
  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const warnings: string[] = []
  for (const sb of sbs) {
    const board = parseBoard(sb.board)
    if (board) {
      warnings.push(...checkBoard(board, sb.duration || 0, sb.storyboardNumber))
      continue
    }
    const b = await loadStoryboardBindings(sb.id)
    if (!b) continue
    warnings.push(...checkStoryboardDraft({
      shotNumber: sb.storyboardNumber,
      duration: sb.duration,
      description: sb.description,
      videoPrompt: sb.videoPrompt,
      refNames: boundRefNames(b),
    }))
  }
  const expected = Math.max(1, Math.round((scriptLength / CHARS_PER_MINUTE) * 60 / AVG_SEGMENT_SECONDS))
  if (sbs.length && Math.abs(sbs.length - expected) / expected > COUNT_TOLERANCE) {
    warnings.push(`共 ${sbs.length} 个分镜段落，按剧本字数预估约 ${expected} 个，偏差较大，请检查是否有遗漏或拆得过碎`)
  }
  const gaps = sbs.filter((sb, i) => sb.storyboardNumber !== i + 1).map(sb => sb.storyboardNumber)
  if (gaps.length) warnings.push(`镜号不连续（从 S${gaps[0]} 起），可能有批次保存失败`)
  const totalDuration = sbs.reduce((sum, sb) => sum + (sb.duration || 0), 0)
  return { storyboards: sbs, warnings, expected, totalDuration }
}

/** 故事板生成前确保资产已提取：本集还没有关联的角色与场景时，先并行提取三类资产 */
async function ensureEpisodeAssets(ep: EpisodeRow, opts: TextModelOptions) {
  const chars = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id))
  const scenes = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id))
  if (chars.length || scenes.length) return false
  const results = await Promise.allSettled(EXTRACT_TARGETS.map(t => runExtraction(ep.id, ep.dramaId, t, opts)))
  const failed = results.filter(r => r.status === 'rejected')
  if (failed.length === results.length) throw new Error('资产提取失败，无法生成故事板，请先在「资产」中提取角色与场景')
  return true
}

/**
 * 生成故事板（整集）：补齐资产 → 故事板设计 Agent 按剧本场景逐个保存 → 整集校验
 * description / video_prompt 在保存时由故事板推导；旧数据缺提示词时兜底补齐
 */
export async function startBreakdown(
  ep: EpisodeRow,
  opts: TextModelOptions & { videoLabel?: string } = {},
): Promise<{ started: boolean; task: AgentTaskRow }> {
  return startAgentTask(
    { kind: 'breakdown', agentType: 'storyboard_breaker', episodeId: ep.id, dramaId: ep.dramaId },
    async (progress) => {
      await progress.setCurrent('extract')
      const extracted = await ensureEpisodeAssets(ep, opts)

      await progress.setCurrent('design')
      const startedAt = now()
      const videoLabel = opts.videoLabel || await episodeVideoModelLabel(ep.id)
      const message = `请基于当前集剧本设计整集故事板：按剧本场景顺序，每个场景调用一次 save_boards 保存该场景的全部段。本次视频模型：${videoLabel}，段时长不要超过该模型单次生成上限。`
      const result = await runAgent('storyboard_breaker', message, {
        model: opts.model, configId: opts.configId, episodeId: ep.id, dramaId: ep.dramaId, maxSteps: 40, logScope: 'Breakdown',
      })

      const [fresh] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, ep.id))
      const script = fresh?.scriptContent || fresh?.content || ''
      let report = await validateEpisodeStoryboards(ep.id, script.length)
      const written = report.storyboards.filter(sb => sb.createdAt >= startedAt || sb.updatedAt >= startedAt)
      if (!calledTools(result).includes('save_boards') || !written.length) {
        throw new Error('Agent 已结束但没有保存故事板（原有分镜未改动），请重试或更换文本模型')
      }
      const stale = report.storyboards.length - written.length

      // 旧链路兜底：缺 video_prompt 的段逐个补齐
      const missing = report.storyboards.filter(sb => !(sb.videoPrompt || '').trim())
      let failedPromptShots: number[] = []
      if (missing.length) {
        await progress.setCurrent('fill')
        await progress.setTotal(missing.length)
        failedPromptShots = await fillVideoPrompts(missing, ep.dramaId, progress, { ...opts, videoLabel })
        report = await validateEpisodeStoryboards(ep.id, script.length)
      }

      // 剧本场景覆盖检查：每个 ## Sxx 都应有故事板
      const covered = new Set(report.storyboards.map(sb => sb.scriptScene).filter(Boolean))
      const uncovered = parseScriptScenes(script).map(s => normalizeSceneNo(s.no)).filter(no => !covered.has(no))

      const warnings = [...report.warnings]
      if (uncovered.length) warnings.unshift(`剧本场景 ${uncovered.join('、')} 没有生成故事板，可能被遗漏`)
      if (stale > 0) warnings.unshift(`有 ${stale} 个旧分镜未被本次生成覆盖（Agent 未清空旧分镜），请检查或重新生成`)
      if (warnings.length) logTaskWarn('Breakdown', 'validation', { episodeId: ep.id, warnings: warnings.length })
      return {
        extracted_assets: extracted,
        storyboards: report.storyboards.length,
        expected_storyboards: report.expected,
        total_duration: report.totalDuration,
        filled_prompts: missing.length - failedPromptShots.length,
        failed_prompt_shots: failedPromptShots,
        warnings,
      }
    },
  )
}
