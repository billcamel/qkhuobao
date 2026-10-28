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
 * 角色上持久化的音色。后期配音只读这个对象，不必再拆列。
 * preview_url 为已生成的短试听（static/ 相对路径或绝对 URL），没有则为 null。
 */
export interface CharacterVoice {
  provider: string
  voice_id: string
  name: string
  preview_url: string | null
  config_id: number | null
  model: string | null
  meta: {
    gender?: VoiceGender | null
    language?: string | null
    description?: string | null
    sample_text?: string | null
  }
}

export interface VoiceConfig extends AIConfig {
  name: string
  appId: string | null
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
