/**
 * 角色参考音色的本地音频。
 * 只接受已经落在服务器 static/voice-audio 或 static/uploads 下的文件，不接受远程 URL。
 */
import fs from 'fs'
import path from 'path'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { getAbsolutePath } from '../../utils/storage.js'
import type { VoiceSource } from './types.js'

export const LOCAL_AUDIO_DIRS = ['voice-audio', 'uploads'] as const
const LOCAL_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac'])

export function normalizeLocalAudioUrl(input: unknown): string | null {
  let raw = String(input ?? '').trim()
  if (!raw || raw.includes('\0')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  raw = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  if (raw.split('/').some(part => part === '..' || part === '.')) return null
  const match = raw.match(/^static\/(voice-audio|uploads)\/([^/]+)$/)
  if (!match) return null
  const filename = match[2]
  if (!filename || filename.startsWith('.')) return null
  if (!LOCAL_AUDIO_EXTS.has(path.extname(filename).toLowerCase())) return null
  return `static/${match[1]}/${filename}`
}

/** 口型任务用来识别「是不是同一条参考音频」的本地键，不是服务商 voice_id。 */
export function localVoiceKey(audioUrl: string): string {
  return `local:${path.basename(audioUrl)}`
}

export function audioDisplayName(audioUrl: string, preferred?: string | null): string {
  const cleaned = String(preferred || '').replace(/[/\\]/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned) return [...cleaned].slice(0, 80).join('')
  return path.basename(audioUrl, path.extname(audioUrl)) || '参考音频'
}

export function localAudioExists(audioUrl: string): boolean {
  const normalized = normalizeLocalAudioUrl(audioUrl)
  if (!normalized) return false
  try {
    return fs.statSync(getAbsolutePath(normalized)).isFile()
  } catch {
    return false
  }
}

export function listStoredAudioFiles(root = STORAGE_ROOT): { audio_url: string; name: string }[] {
  const found: { audio_url: string; name: string }[] = []
  for (const dir of LOCAL_AUDIO_DIRS) {
    let names: string[] = []
    try { names = fs.readdirSync(path.join(root, dir)) } catch { continue }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const audioUrl = normalizeLocalAudioUrl(`static/${dir}/${name}`)
      if (!audioUrl) continue
      try {
        if (!fs.statSync(path.join(root, dir, name)).isFile()) continue
      } catch { continue }
      found.push({ audio_url: audioUrl, name: audioDisplayName(audioUrl) })
    }
  }
  return found
}

/** 角色上已保存的名字优先于文件名。同一路径只保留一条。 */
export function mergeLibraryItems(items: { audio_url: string; name?: string | null }[]): { audio_url: string; name: string }[] {
  const map = new Map<string, string>()
  for (const item of items) {
    const audioUrl = normalizeLocalAudioUrl(item.audio_url)
    if (!audioUrl) continue
    const explicit = String(item.name || '').trim()
    const current = map.get(audioUrl)
    if (!current) {
      map.set(audioUrl, audioDisplayName(audioUrl, explicit))
      continue
    }
    if (explicit && current === audioDisplayName(audioUrl)) map.set(audioUrl, audioDisplayName(audioUrl, explicit))
  }
  return [...map.entries()]
    .map(([audio_url, name]) => ({ audio_url, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export function voiceBindFromBody(body: any): { audioUrl: string; name: string | null; source: Exclude<VoiceSource, 'portrait'> } {
  const remoteId = String(body?.voice_id ?? body?.voiceId ?? '').trim()
  const raw = body?.audio_url ?? body?.audioUrl
  if (!String(raw ?? '').trim()) {
    if (remoteId) throw new Error('请上传或选择本地参考音频，不再绑定远程音色')
    throw new Error('请上传或选择本地参考音频')
  }
  const audioUrl = normalizeLocalAudioUrl(raw)
  if (!audioUrl) throw new Error('请选择服务器上的参考音频')
  const name = String(body?.name ?? body?.voice_name ?? body?.voiceName ?? '').trim() || null
  return { audioUrl, name, source: body?.source === 'library' ? 'library' : 'upload' }
}
