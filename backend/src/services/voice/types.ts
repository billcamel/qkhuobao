import type { AIConfig } from '../ai.js'

export type VoiceGender = 'female' | 'male' | 'neutral' | 'child'

/** 内部合成用的一条音色。用户不从目录里挑选。 */
export interface VoiceOption {
  id: string
  name: string
  gender: VoiceGender
  language: string
  description?: string
}

export type VoiceSource = 'upload' | 'library' | 'portrait'

/**
 * 角色上持久化的参考音色。
 * audio_url 是服务器上的参考音频，镜头生成时作为 reference_audio。
 * clip_url 是口型说话短视频，只在资产页播放，不传给镜头。
 * provider / voice_id 表示本地资产，不是 MiniMax、豆包或 OpenAI 的音色 ID。
 */
export interface CharacterVoice {
  provider: 'local'
  /** 本地资产键，形如 local:xxx.mp3 */
  voice_id: string
  name: string
  audio_url: string
  clip_url: string | null
  source: VoiceSource | null
  config_id: number | null
  model: string | null
  meta: {
    gender?: VoiceGender | null
    language?: string | null
    description?: string | null
    sample_text?: string | null
    clip_task_id?: number | null
  }
}

export interface VoiceConfig extends AIConfig {
  name: string
}

export interface SpeechRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: unknown
}

export interface VoiceProviderAdapter {
  provider: string
  catalog: VoiceOption[]
  /** 有密钥时尝试拉服务商音色；失败返回 null，调用方回退内置目录 */
  listVoices?(config: VoiceConfig): Promise<VoiceOption[] | null>
  synthesize(config: VoiceConfig, input: { voiceId: string; text: string }): Promise<Buffer>
}
