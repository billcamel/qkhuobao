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
 * 角色上持久化的音色。clip_url 是定妆图加这段声音合成的说话短视频，
 * 资产页播放它，镜头生成时作为 reference_video 传入（视频模型用视频携带参考声音）。
 */
export interface CharacterVoice {
  provider: string
  voice_id: string
  name: string
  /** 说话短视频。没有生成过则为 null */
  clip_url: string | null
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
