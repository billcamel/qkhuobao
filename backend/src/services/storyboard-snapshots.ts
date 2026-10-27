/**
 * 分镜快照 — 整集重新拆分（save_storyboards replace_existing）或恢复前自动留存当前分镜，
 * 可整体恢复：分镜行按原 ID 回填，sys_task / 视频文件的关联不断。
 * 每集最多保留 MAX_SNAPSHOTS_PER_EPISODE 份，超出删除最旧的。
 */
import { desc, eq, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'

type StoryboardRow = typeof schema.storyboards.$inferSelect
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const MAX_SNAPSHOTS_PER_EPISODE = 10

type ScriptSceneRow = typeof schema.episodeScriptScenes.$inferSelect

interface SnapshotData {
  storyboards: StoryboardRow[]
  characterLinks: { storyboardId: number; characterId: number }[]
  propLinks: { storyboardId: number; propId: number }[]
  /** 故事板的剧本场景分组（旧快照无此字段） */
  scriptScenes?: ScriptSceneRow[]
}

function readEpisodeStoryboards(tx: Tx, episodeId: number): SnapshotData {
  const storyboards = tx.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
  const scriptScenes = tx.select().from(schema.episodeScriptScenes)
    .where(eq(schema.episodeScriptScenes.episodeId, episodeId)).all()
  const ids = storyboards.map(sb => sb.id)
  if (!ids.length) return { storyboards, characterLinks: [], propLinks: [], scriptScenes }
  const characterLinks = tx.select().from(schema.storyboardCharacters)
    .where(inArray(schema.storyboardCharacters.storyboardId, ids)).all()
    .map(l => ({ storyboardId: l.storyboardId, characterId: l.characterId }))
  const propLinks = tx.select().from(schema.storyboardProps)
    .where(inArray(schema.storyboardProps.storyboardId, ids)).all()
    .map(l => ({ storyboardId: l.storyboardId, propId: l.propId }))
  return { storyboards, characterLinks, propLinks, scriptScenes }
}

function deleteEpisodeStoryboards(tx: Tx, episodeId: number, ids: number[]) {
  tx.delete(schema.episodeScriptScenes).where(eq(schema.episodeScriptScenes.episodeId, episodeId)).run()
  if (!ids.length) return
  tx.delete(schema.storyboardCharacters).where(inArray(schema.storyboardCharacters.storyboardId, ids)).run()
  tx.delete(schema.storyboardProps).where(inArray(schema.storyboardProps.storyboardId, ids)).run()
  tx.delete(schema.storyboards).where(inArray(schema.storyboards.id, ids)).run()
}

/** 写入快照并修剪旧快照；无分镜时不写，返回 null */
function writeSnapshot(tx: Tx, episodeId: number, reason: string, data: SnapshotData): number | null {
  if (!data.storyboards.length) return null
  const res = tx.insert(schema.storyboardSnapshots).values({
    episodeId,
    reason,
    storyboardCount: data.storyboards.length,
    videoCount: data.storyboards.filter(sb => sb.videoUrl || sb.composedVideoUrl).length,
    data: JSON.stringify(data),
    createdAt: now(),
  }).run()
  const keep = tx.select({ id: schema.storyboardSnapshots.id }).from(schema.storyboardSnapshots)
    .where(eq(schema.storyboardSnapshots.episodeId, episodeId))
    .orderBy(desc(schema.storyboardSnapshots.id)).all()
    .slice(MAX_SNAPSHOTS_PER_EPISODE).map(r => r.id)
  if (keep.length) tx.delete(schema.storyboardSnapshots).where(inArray(schema.storyboardSnapshots.id, keep)).run()
  return getInsertId(res)
}

/** 留存当前分镜快照后清空整集分镜（同一事务，失败不丢数据）；返回快照 ID（无分镜时为 null） */
export function snapshotAndClearEpisodeStoryboards(episodeId: number, reason: string): number | null {
  return db.transaction((tx) => {
    const data = readEpisodeStoryboards(tx, episodeId)
    const snapshotId = writeSnapshot(tx, episodeId, reason, data)
    deleteEpisodeStoryboards(tx, episodeId, data.storyboards.map(sb => sb.id))
    return snapshotId
  })
}

export function listStoryboardSnapshots(episodeId: number) {
  return db.select({
    id: schema.storyboardSnapshots.id,
    reason: schema.storyboardSnapshots.reason,
    storyboardCount: schema.storyboardSnapshots.storyboardCount,
    videoCount: schema.storyboardSnapshots.videoCount,
    createdAt: schema.storyboardSnapshots.createdAt,
  }).from(schema.storyboardSnapshots)
    .where(eq(schema.storyboardSnapshots.episodeId, episodeId))
    .orderBy(desc(schema.storyboardSnapshots.id)).all()
}

/** 恢复快照：先把当前分镜留存为新快照，再按原 ID 回填快照中的分镜与关联；返回恢复的分镜数 */
export function restoreStoryboardSnapshot(episodeId: number, snapshotId: number): number {
  return db.transaction((tx) => {
    const [snap] = tx.select().from(schema.storyboardSnapshots)
      .where(eq(schema.storyboardSnapshots.id, snapshotId)).all()
    if (!snap || snap.episodeId !== episodeId) throw new Error('快照不存在')
    const data = JSON.parse(snap.data) as SnapshotData

    const current = readEpisodeStoryboards(tx, episodeId)
    writeSnapshot(tx, episodeId, 'before-restore', current)
    deleteEpisodeStoryboards(tx, episodeId, current.storyboards.map(sb => sb.id))

    const ts = now()
    for (const sb of data.storyboards) {
      tx.insert(schema.storyboards).values({ ...sb, episodeId, updatedAt: ts }).run()
    }
    if (data.characterLinks.length) tx.insert(schema.storyboardCharacters).values(data.characterLinks).run()
    if (data.propLinks.length) tx.insert(schema.storyboardProps).values(data.propLinks).run()
    for (const scene of data.scriptScenes || []) {
      tx.insert(schema.episodeScriptScenes).values({ ...scene, episodeId }).run()
    }

    const totalSeconds = data.storyboards.reduce((sum, sb) => sum + (sb.duration || 0), 0)
    tx.update(schema.episodes)
      .set({ duration: Math.ceil(totalSeconds / 60), updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId)).run()
    return data.storyboards.length
  })
}
