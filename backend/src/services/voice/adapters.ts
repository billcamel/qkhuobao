import { randomUUID } from 'node:crypto'
import { joinProviderUrl } from '../adapters/url.js'
import { MINIMAX_VOICES, OPENAI_VOICES, VOLCENGINE_VOICES, inferGender } from './catalog.js'
import type { SpeechRequest, VoiceConfig, VoiceOption, VoiceProviderAdapter } from './types.js'

const PREVIEW_TIMEOUT_MS = 30_000

export function decodeAudioPayload(raw: string): Buffer {
  const compact = raw.trim()
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) return Buffer.from(compact, 'hex')
  return Buffer.from(compact, 'base64')
}

function providerMessage(text: string, status: number): string {
  try {
    const json = JSON.parse(text)
    const msg = json?.error?.message || json?.base_resp?.status_msg || json?.message
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 300)
  } catch { /* 非 JSON 错误体 */ }
  return `语音合成失败（${status}）`
}

async function postJson(req: SpeechRequest): Promise<Response> {
  return fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
  })
}

export function buildOpenAiSpeechRequest(config: VoiceConfig, input: { voiceId: string; text: string }): SpeechRequest {
  return {
    url: joinProviderUrl(config.baseUrl, '/v1', '/audio/speech'),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: config.model || 'tts-1',
      input: input.text,
      voice: input.voiceId,
      response_format: 'mp3',
    },
  }
}

export const openaiVoiceAdapter: VoiceProviderAdapter = {
  provider: 'openai',
  catalog: OPENAI_VOICES,
  async synthesize(config, input) {
    const req = buildOpenAiSpeechRequest(config, input)
    const resp = await postJson(req)
    if (!resp.ok) throw new Error(providerMessage(await resp.text(), resp.status))
    const audio = Buffer.from(await resp.arrayBuffer())
    if (!audio.length) throw new Error('语音合成没有返回音频')
    return audio
  },
}

export function buildMinimaxSpeechRequest(config: VoiceConfig, input: { voiceId: string; text: string }): SpeechRequest {
  return {
    url: joinProviderUrl(config.baseUrl, '/v1', '/t2a_v2'),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: config.model || 'speech-02-hd',
      text: input.text,
      stream: false,
      voice_setting: { voice_id: input.voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    },
  }
}

function minimaxVoicesFrom(json: any): VoiceOption[] {
  const rows = [
    ...(Array.isArray(json?.system_voice) ? json.system_voice : []),
    ...(Array.isArray(json?.voice_cloning) ? json.voice_cloning : []),
    ...(Array.isArray(json?.voice_generation) ? json.voice_generation : []),
  ]
  const seen = new Set<string>()
  const voices: VoiceOption[] = []
  for (const row of rows) {
    const id = String(row?.voice_id || row?.voiceId || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = String(row?.voice_name || row?.voiceName || id).trim() || id
    const description = Array.isArray(row?.description) ? row.description.filter(Boolean).join(' ') : String(row?.description || '')
    voices.push({
      id,
      name,
      gender: inferGender(id, name),
      language: 'zh',
      description: description || undefined,
    })
  }
  return voices
}

export function parseMinimaxAudio(json: any): Buffer {
  const code = json?.base_resp?.status_code
  if (code !== undefined && code !== 0) {
    throw new Error(String(json?.base_resp?.status_msg || 'MiniMax 语音合成失败'))
  }
  const audio = json?.data?.audio
  if (typeof audio !== 'string' || !audio) throw new Error('MiniMax 没有返回音频')
  const bytes = decodeAudioPayload(audio)
  if (!bytes.length) throw new Error('MiniMax 没有返回音频')
  return bytes
}

export const minimaxVoiceAdapter: VoiceProviderAdapter = {
  provider: 'minimax',
  catalog: MINIMAX_VOICES,
  async listVoices(config) {
    if (!config.apiKey) return null
    const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/get_voice'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ voice_type: 'all' }),
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
    })
    if (!resp.ok) return null
    const json = await resp.json().catch(() => null)
    const voices = minimaxVoicesFrom(json)
    return voices.length ? voices : null
  },
  async synthesize(config, input) {
    const resp = await postJson(buildMinimaxSpeechRequest(config, input))
    const json = await resp.json().catch(() => null)
    if (!resp.ok) throw new Error(providerMessage(JSON.stringify(json || {}), resp.status))
    return parseMinimaxAudio(json)
  },
}

/**
 * 豆包语音 HTTP 合成。鉴权头是 `Bearer;token`（分号，不是空格）。
 * API Key 填 Access Token；App ID 放在配置 settings.app_id；模型名即 cluster。
 * 这是语音产品，不能复用方舟 Seedance/Seedream 的 key。
 */
export function buildVolcengineSpeechRequest(config: VoiceConfig, input: { voiceId: string; text: string }): SpeechRequest {
  const token = config.apiKey
  const appId = config.appId || ''
  return {
    url: joinProviderUrl(config.baseUrl, '/api/v1', '/tts'),
    method: 'POST',
    headers: {
      Authorization: `Bearer;${token}`,
      'Content-Type': 'application/json',
    },
    body: {
      app: { appid: appId, token, cluster: config.model || 'volcano_tts' },
      user: { uid: 'huobao-drama' },
      audio: {
        voice_type: input.voiceId,
        encoding: 'mp3',
        speed_ratio: 1,
        volume_ratio: 1,
        pitch_ratio: 1,
      },
      request: {
        reqid: randomUUID(),
        text: input.text,
        text_type: 'plain',
        operation: 'query',
      },
    },
  }
}

export function parseVolcengineAudio(json: any): Buffer {
  const code = Number(json?.code)
  if (code !== 3000) throw new Error(String(json?.message || '豆包语音合成失败'))
  if (typeof json?.data !== 'string' || !json.data) throw new Error('豆包语音没有返回音频')
  const bytes = decodeAudioPayload(json.data)
  if (!bytes.length) throw new Error('豆包语音没有返回音频')
  return bytes
}

export const volcengineVoiceAdapter: VoiceProviderAdapter = {
  provider: 'volcengine',
  catalog: VOLCENGINE_VOICES,
  async synthesize(config, input) {
    if (!config.appId) throw new Error('请在设置中填写火山语音 App ID')
    const resp = await postJson(buildVolcengineSpeechRequest(config, input))
    const json = await resp.json().catch(() => null)
    if (!resp.ok && !json?.code) throw new Error(providerMessage(JSON.stringify(json || {}), resp.status))
    return parseVolcengineAudio(json)
  },
}

export const voiceAdapters: Record<string, VoiceProviderAdapter> = {
  openai: openaiVoiceAdapter,
  minimax: minimaxVoiceAdapter,
  volcengine: volcengineVoiceAdapter,
}

export function getVoiceAdapter(provider: string): VoiceProviderAdapter {
  const adapter = voiceAdapters[(provider || '').toLowerCase()]
  if (!adapter) throw new Error('不支持的语音服务商')
  return adapter
}
