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

/** 内置 moon_bigtts 音色属于语音合成 1.0。空模型与旧版 cluster 名都落到这个资源。 */
export const VOLCENGINE_DEFAULT_RESOURCE_ID = 'seed-tts-1.0'

const VOLCENGINE_LEGACY_RESOURCE_IDS: Record<string, string> = {
  volcano_tts: 'seed-tts-1.0',
  volcano_mega: 'seed-tts-1.0',
  volcano_icl: 'seed-icl-1.0',
}

/**
 * 配置里的模型名即 `X-Api-Resource-Id`（也决定计费商品）。
 * 已保存的旧 cluster（volcano_tts 等）映射到对应的 1.0 资源，其余原样透传。
 */
export function volcengineResourceId(model: string | null | undefined): string {
  const raw = String(model || '').trim()
  if (!raw) return VOLCENGINE_DEFAULT_RESOURCE_ID
  return VOLCENGINE_LEGACY_RESOURCE_IDS[raw] || raw
}

/**
 * 豆包语音 V3 HTTP Chunked 单向流。
 * 新版控制台只认 `X-Api-Key`，不再传 App ID / Access Token。
 * 这是语音产品，不能复用方舟 Seedance/Seedream 的 key。
 */
export function buildVolcengineSpeechRequest(config: VoiceConfig, input: { voiceId: string; text: string }): SpeechRequest {
  const resourceId = volcengineResourceId(config.model)
  // 音色与资源版本必须配套：2.0(seed-tts-2.0) 只认 uranus_bigtts，1.0 只认 moon_bigtts，
  // 混用会被上游以 55000000 "resource ID is mismatched with speaker related resource" 拒绝。
  const isV2Resource = /2\.0/.test(resourceId)
  const speaker = input.voiceId
  if (isV2Resource && speaker.includes('_moon_bigtts')) {
    throw new Error(`音色 ${speaker} 属于豆包语音 1.0，与当前 2.0 资源不匹配，请改用 *_uranus_bigtts 音色`)
  }
  if (!isV2Resource && speaker.includes('_uranus_bigtts')) {
    throw new Error(`音色 ${speaker} 属于豆包语音 2.0，与当前 1.0 资源不匹配，请改用 *_moon_bigtts 音色`)
  }
  return {
    url: joinProviderUrl(config.baseUrl, '/api/v3/tts', '/unidirectional'),
    method: 'POST',
    headers: {
      'X-Api-Key': config.apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: {
      user: { uid: 'huobao-drama' },
      req_params: {
        text: input.text,
        speaker: input.voiceId,
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    },
  }
}

function volcengineEventPayload(line: string): string {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return ''
  if (trimmed.startsWith('data:')) return trimmed.slice(5).trim()
  return trimmed
}

/** 把 V3 单向流（NDJSON，或带 data: 前缀的 SSE）里的音频块按序拼成一段 mp3。 */
export function parseVolcengineAudio(raw: string): Buffer {
  const chunks: Buffer[] = []
  let errorMessage = ''
  let sawEvent = false
  const take = (json: any) => {
    if (!json || typeof json !== 'object') return
    sawEvent = true
    const code = Number(json.code)
    if (code === 0) {
      // V3 的 data 是 base64 音频块。不要走 hex 优先的 decodeAudioPayload，短块可能被误判成 hex。
      if (typeof json.data === 'string' && json.data.trim()) {
        const bytes = Buffer.from(json.data, 'base64')
        if (bytes.length) chunks.push(bytes)
      }
      return
    }
    if (code === 20000000) return
    if (Number.isFinite(code)) {
      errorMessage = String(json.message || `豆包语音合成失败（${code}）`)
    }
  }

  for (const line of String(raw || '').split(/\r?\n/)) {
    const payload = volcengineEventPayload(line)
    if (!payload || payload === '[DONE]') continue
    try { take(JSON.parse(payload)) } catch { /* 跳过 event: 之类的非 JSON 行 */ }
  }
  if (!sawEvent) {
    const trimmed = String(raw || '').trim()
    if (trimmed) {
      try { take(JSON.parse(trimmed)) } catch { /* 整段也不是 JSON */ }
    }
  }
  if (errorMessage) throw new Error(errorMessage)
  if (!chunks.length) throw new Error('豆包语音没有返回音频')
  return Buffer.concat(chunks)
}

export const volcengineVoiceAdapter: VoiceProviderAdapter = {
  provider: 'volcengine',
  catalog: VOLCENGINE_VOICES,
  async synthesize(config, input) {
    if (!config.apiKey) throw new Error('语音合成配置缺少 API Key')
    const resp = await postJson(buildVolcengineSpeechRequest(config, input))
    const text = await resp.text()
    if (!text.trim()) throw new Error(providerMessage('', resp.status))
    try {
      return parseVolcengineAudio(text)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (!resp.ok && (!message || message === '豆包语音没有返回音频')) {
        throw new Error(providerMessage(text, resp.status))
      }
      throw err
    }
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
