import type { AIConfig } from '../ai.js'

export type VoiceGender = 'female' | 'male' | 'neutral' | 'child'

/** 目录或服务商实时列表里的一条音色 */
export interface VoiceOption {
  id: string
  name: string
  gender: VoiceGender
  language: string
  description?: string
}

/**
 * 角色上持久化的音色。
 * audio_url 是 TTS 样本，镜头生成时作为 reference_audio。
 * clip_url 是口型说话短视频，只在资产页播放，不传给镜头。
 */
export interface CharacterVoice {
  provider: string
  voice_id: string
  name: string
  /** TTS 样本。镜头的 reference_audio */
  audio_url: string | null
  /** 口型试听视频。资产页播放 */
  clip_url: string | null
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
