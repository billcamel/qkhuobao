import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { runVideoQc } from '../services/qc.js'
import { DATA_ROOT } from '../utils/paths.js'

const app = new Hono()
const QC_DIR = path.join(DATA_ROOT, 'qc')

/** 最近质检索引（新的在前） */
app.get('/reports', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 50), 500)
  const file = path.join(QC_DIR, 'index.jsonl')
  if (!fs.existsSync(file)) return success(c, [])
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
  const rows = lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return success(c, rows)
})

/** 单条质检报告 */
app.get('/:kind/:id', async (c) => {
  const kind = c.req.param('kind')
  if (kind !== 'task' && kind !== 'merge') return badRequest(c, 'kind 只能是 task 或 merge')
  const file = path.join(QC_DIR, `${kind}-${Number(c.req.param('id'))}.json`)
  if (!fs.existsSync(file)) return success(c, null)
  return success(c, JSON.parse(fs.readFileSync(file, 'utf-8')))
})

/** 手动重跑某个任务/成片的质检 */
app.post('/scan/:kind/:id', async (c) => {
  const kind = c.req.param('kind')
  const id = Number(c.req.param('id'))
  if (kind !== 'task' && kind !== 'merge') return badRequest(c, 'kind 只能是 task 或 merge')
  const link = await resolveFile(kind, id)
  if (!link) return badRequest(c, kind === 'task' ? '任务不存在或还没有本地视频' : '成片记录不存在')
  try {
    const report = await runVideoQc({ kind: kind as 'task' | 'merge', id, file: link.file, label: link.label })
    return success(c, report)
  } catch (e: any) {
    return badRequest(c, e.message)
  }
})

/** 重跑一整集所有镜头的质检 */
app.post('/scan/episode/:id', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const sbs = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  const ids = sbs.filter(s => !s.deletedAt).map(s => s.id)
  const results: any[] = []
  for (const sbId of ids) {
    const [task] = await db.select().from(schema.sysTask).where(and(
      eq(schema.sysTask.storyboardId, sbId), eq(schema.sysTask.type, 'video'),
      eq(schema.sysTask.status, 'completed'))).orderBy(schema.sysTask.id)
    if (!task?.localPath) continue
    try {
      const r = await runVideoQc({ kind: 'task', id: task.id, file: task.localPath, label: `分镜 ${sbId}` })
      results.push({ task_id: task.id, storyboard_id: sbId, score: r.score, issues: r.issues })
    } catch (e: any) {
      results.push({ task_id: task.id, storyboard_id: sbId, error: e.message })
    }
  }
  return success(c, results)
})

async function resolveFile(kind: string, id: number): Promise<{ file: string; label: string } | null> {
  if (kind === 'task') {
    const [t] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!t?.localPath) return null
    return { file: t.localPath, label: t.storyboardId ? `分镜 ${t.storyboardId}` : `任务 ${t.id}` }
  }
  const [m] = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, id))
  if (!m?.mergedUrl) return null
  return { file: m.mergedUrl, label: `第 ${m.episodeId} 集成片 #${m.id}` }
}

export default app
