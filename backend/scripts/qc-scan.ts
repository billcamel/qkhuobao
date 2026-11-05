/**
 * 整集体检：把一集所有已完成镜头 + 最新成片跑一遍质检，输出中文报告。
 * 用法：npx tsx scripts/qc-scan.ts 6
 */
import fs from 'node:fs'
import path from 'node:path'
import { eq, and, desc } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { runVideoQc, reportToMarkdown, type QCReport } from '../src/services/qc.js'
import { DATA_ROOT } from '../src/utils/paths.js'

const episodeId = Number(process.argv[2] || 6)

const sbs = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
  .filter(s => !s.deletedAt)
  .sort((a, b) => (a.storyboardNumber || 0) - (b.storyboardNumber || 0))

const reports: QCReport[] = []
for (const sb of sbs) {
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.storyboardId, sb.id), eq(schema.sysTask.type, 'video'),
    eq(schema.sysTask.status, 'completed'))).orderBy(desc(schema.sysTask.id))
  const task = rows[0]
  if (!task?.localPath) continue
  try {
    const r = await runVideoQc({ kind: 'task', id: task.id, file: task.localPath, label: `${sb.storyboardNumber} 号镜` })
    reports.push(r)
  } catch (e: any) {
    console.log(`分镜 ${sb.storyboardNumber} 质检失败：${e.message}`)
  }
}

const [latestMerge] = await db.select().from(schema.videoMerges)
  .where(eq(schema.videoMerges.episodeId, episodeId)).orderBy(desc(schema.videoMerges.id))
let mergeReport: QCReport | null = null
if (latestMerge?.mergedUrl) {
  try {
    mergeReport = await runVideoQc({ kind: 'merge', id: latestMerge.id, file: latestMerge.mergedUrl, label: `第 ${episodeId} 集成片` })
  } catch (e: any) {
    console.log(`整集质检失败：${e.message}`)
  }
}

// 跨镜头相对清晰度：低于全集中位数 65% 的标为嫌疑糊片
const sharps = reports.map(r => r.metrics.sharpness).sort((a, b) => a - b)
const median = sharps.length ? sharps[Math.floor(sharps.length / 2)] : 0
const suspects = reports.filter(r => median > 0 && r.metrics.sharpness < median * 0.65)

const lines: string[] = []
lines.push(`# 第 ${episodeId} 集生成后质检报告`)
lines.push('')
lines.push(`- 镜头 ${reports.length} 条${mergeReport ? ' · 成片 1 条' : ''} · 生成时间 ${new Date().toISOString()}`)
lines.push(`- 清晰度中位数 ${median.toFixed(2)}`)
if (suspects.length) lines.push(`- 相对偏糊镜头：${suspects.map(r => r.label).join('、')}`)
lines.push('')
lines.push('| 镜头 | 分数 | 时长 | 清晰度 | 闪烁 | 色跳 | 卡帧 | 主要问题 |')
lines.push('|---|---|---|---|---|---|---|---|')
for (const r of reports) {
  const main = r.issues.filter(i => i.severity === 'major').map(i => i.type).join('、') || r.issues.map(i => i.type).join('、') || '—'
  lines.push(`| ${r.label} | ${r.score} | ${r.probe.duration.toFixed(1)}s | ${r.metrics.sharpness} | ${r.metrics.flickerEvents} | ${r.metrics.colorJumps} | ${r.metrics.frozenEvents} | ${main} |`)
}
if (mergeReport) {
  lines.push('')
  lines.push(reportToMarkdown(mergeReport))
}

const out = path.join(DATA_ROOT, 'qc', `episode-${episodeId}.md`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, lines.join('\n'), 'utf-8')
console.log(lines.join('\n'))
console.log(`\n报告已写入 ${out}`)
process.exit(0)
