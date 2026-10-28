/**
 * 配音选角读取入口。
 *
 * 视频生成和 FFmpeg 拼接都不做语音合成。后续导出/配音（含仓库外的配音脚本）
 * 读取本函数或角色对象上的 voice，不必再改表。
 * voice 为 null 表示该角色还没指定音色。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { readCharacterVoice } from './binding.js'
import type { CharacterVoice } from './types.js'

export interface DubbingCastMember {
  character_id: number
  name: string
  role: string | null
  voice: CharacterVoice | null
}

export function toDubbingCastMember(row: typeof schema.characters.$inferSelect): DubbingCastMember {
  return {
    character_id: row.id,
    name: row.name,
    role: row.role || null,
    voice: readCharacterVoice(row),
  }
}

export async function dubbingCastForEpisode(episodeId: number): Promise<DubbingCastMember[]> {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const ids = links.map(link => link.characterId)
  if (!ids.length) return []
  const rows = await db.select().from(schema.characters)
  return rows
    .filter(row => ids.includes(row.id) && !row.deletedAt)
    .map(toDubbingCastMember)
}
