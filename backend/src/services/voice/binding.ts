import { toSnakeCase } from '../../utils/transform.js'
import type { CharacterVoice, VoiceGender } from './types.js'

type CharacterRow = {
  voiceProvider?: string | null
  voiceId?: string | null
  voiceName?: string | null
  voicePreviewUrl?: string | null
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

/** 未绑定音色时返回 null。列为空字符串也视为未绑定。 */
export function readCharacterVoice(row: CharacterRow | null | undefined): CharacterVoice | null {
  const voiceId = String(row?.voiceId || '').trim()
  const provider = String(row?.voiceProvider || '').trim()
  if (!voiceId || !provider) return null
  const meta = parseVoiceMeta(row?.voiceMeta)
  const configId = Number(meta.config_id)
  return {
    provider,
    voice_id: voiceId,
    name: String(row?.voiceName || '').trim() || voiceId,
    preview_url: row?.voicePreviewUrl ? String(row.voicePreviewUrl) : null,
    config_id: Number.isFinite(configId) && configId > 0 ? configId : null,
    model: typeof meta.model === 'string' && meta.model ? meta.model : null,
    meta: {
      gender: asGender(meta.gender),
      language: typeof meta.language === 'string' ? meta.language : null,
      description: typeof meta.description === 'string' ? meta.description : null,
      sample_text: typeof meta.sample_text === 'string' ? meta.sample_text : null,
    },
  }
}

/** API 角色对象附带 voice，供前端和后续配音直接读 character.voice */
export function presentCharacter(row: Record<string, any>) {
  return { ...toSnakeCase(row), voice: readCharacterVoice(row) }
}

export function clearedVoiceColumns() {
  return {
    voiceProvider: null,
    voiceId: null,
    voiceName: null,
    voicePreviewUrl: null,
    voiceMeta: null,
  }
}

export function voiceColumnValues(input: {
  provider: string
  voiceId: string
  voiceName: string
  previewUrl?: string | null
  meta: Record<string, unknown>
}) {
  return {
    voiceProvider: input.provider,
    voiceId: input.voiceId,
    voiceName: input.voiceName,
    voicePreviewUrl: input.previewUrl ?? null,
    voiceMeta: JSON.stringify(input.meta),
  }
}

const PREVIEW_TEXT_MAX = 120

export function previewTextFor(name: string, requested?: string | null): string {
  const custom = String(requested || '').trim()
  if (custom) return [...custom].slice(0, PREVIEW_TEXT_MAX).join('')
  const who = String(name || '').trim()
  return who ? `大家好，我是${who}。` : '大家好，这是一段音色试听。'
}
