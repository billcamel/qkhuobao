import { toSnakeCase } from '../../utils/transform.js'
import { audioDisplayName, localVoiceKey, normalizeLocalAudioUrl } from './local-audio.js'
import type { CharacterVoice, VoiceGender, VoiceSource } from './types.js'

type CharacterRow = {
  voiceProvider?: string | null
  voiceId?: string | null
  voiceName?: string | null
  voicePreviewUrl?: string | null
  voiceClipUrl?: string | null
  voiceMeta?: string | null
}

const GENDERS = new Set<VoiceGender>(['female', 'male', 'neutral', 'child'])

export function parseVoiceMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function asGender(value: unknown): VoiceGender | null {
  return typeof value === 'string' && GENDERS.has(value as VoiceGender) ? value as VoiceGender : null
}

function asSource(value: unknown): VoiceSource | null {
  return value === 'upload' || value === 'library' || value === 'portrait' ? value : null
}

/**
 * 有本地参考音频才算绑定。只存了远程 voice_id、还没有音频文件时返回 null。
 * 对外的 voice_id 是本地资产键，不把库里残留的服务商音色 ID 交出去。
 */
export function readCharacterVoice(row: CharacterRow | null | undefined): CharacterVoice | null {
  const audioUrl = normalizeLocalAudioUrl(row?.voicePreviewUrl)
  if (!audioUrl) return null
  const meta = parseVoiceMeta(row?.voiceMeta)
  const configId = Number(meta.config_id)
  return {
    provider: 'local',
    voice_id: localVoiceKey(audioUrl),
    name: audioDisplayName(audioUrl, row?.voiceName),
    audio_url: audioUrl,
    clip_url: row?.voiceClipUrl ? String(row.voiceClipUrl) : null,
    source: asSource(meta.source),
    config_id: Number.isFinite(configId) && configId > 0 ? configId : null,
    model: typeof meta.model === 'string' && meta.model ? meta.model : null,
    meta: {
      gender: asGender(meta.gender),
      language: typeof meta.language === 'string' ? meta.language : null,
      description: typeof meta.description === 'string' ? meta.description : null,
      sample_text: typeof meta.sample_text === 'string' ? meta.sample_text : null,
      clip_task_id: Number(meta.clip_task_id) > 0 ? Number(meta.clip_task_id) : null,
    },
  }
}

/** API 角色对象附带 voice。有参考音频时，外层音色字段也改成本地资产，避免前端读到远程音色 ID。 */
export function presentCharacter(row: Record<string, any>) {
  const voice = readCharacterVoice(row)
  const presented: Record<string, any> = { ...toSnakeCase(row), voice }
  if (voice) {
    presented.voice_provider = 'local'
    presented.voice_id = voice.voice_id
    presented.voice_name = voice.name
    presented.voice_preview_url = voice.audio_url
    presented.voice_meta = JSON.stringify({
      source: voice.source,
      config_id: voice.config_id,
      model: voice.model,
      gender: voice.meta.gender,
      language: voice.meta.language,
      description: voice.meta.description,
      sample_text: voice.meta.sample_text,
      clip_task_id: voice.meta.clip_task_id,
    })
  }
  return presented
}

export function clearedVoiceColumns() {
  return {
    voiceProvider: null,
    voiceId: null,
    voiceName: null,
    voicePreviewUrl: null,
    voiceClipUrl: null,
    voiceMeta: null,
  }
}

export function voiceColumnValues(input: {
  provider: string
  voiceId: string
  voiceName: string
  clipUrl?: string | null
  audioUrl?: string | null
  meta: Record<string, unknown>
}) {
  return {
    voiceProvider: input.provider,
    voiceId: input.voiceId,
    voiceName: input.voiceName,
    voicePreviewUrl: input.audioUrl ?? null,
    voiceClipUrl: input.clipUrl ?? null,
    voiceMeta: JSON.stringify(input.meta),
  }
}

const PREVIEW_TEXT_MAX = 120

export function previewTextFor(name: string, requested?: string | null): string {
  const custom = String(requested || '').trim()
  if (custom) return [...custom].slice(0, PREVIEW_TEXT_MAX).join('')
  const who = String(name || '').trim()
  // 文本太短会导致 TTS 只有 1 秒出头，下游 r2v 要求 ≥1.8s，默认句给足长度
  return who
    ? `大家好，我是${who}。这一段是用于确认音色的试听，麻烦听听这个声线是否适合这个角色。`
    : '大家好，这是一段音色试听，用来确认声线是否合适。'
}
