import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { isOfficialProvider, parseConfigAppId, parseConfigTemperature } from '../ai.js'
import fs from 'node:fs'
import { getAbsolutePath, saveBinaryFile } from '../../utils/storage.js'
import { renderSpeakingClip } from './speaking-clip.js'
import { now } from '../../utils/response.js'
import { getVoiceAdapter } from './adapters.js'
import { clearedVoiceColumns, presentCharacter, previewTextFor, readCharacterVoice, voiceColumnValues } from './binding.js'
import { dubbingCastForEpisode } from './dubbing-cast.js'
import type { VoiceConfig, VoiceOption } from './types.js'

export { dubbingCastForEpisode, presentCharacter, readCharacterVoice }

function rowToVoiceConfig(row: typeof schema.aiServiceConfigs.$inferSelect): VoiceConfig {
  const models = row.model ? JSON.parse(row.model) : []
  return {
    id: row.id,
    provider: (row.provider || '').toLowerCase(),
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: Array.isArray(models) ? (models[0] || '') : '',
    temperature: parseConfigTemperature(row.settings),
    appId: parseConfigAppId(row.settings),
  }
}

export async function listTtsConfigs(): Promise<VoiceConfig[]> {
  const rows = await db.select().from(schema.aiServiceConfigs)
  return rows
    .filter(row => row.serviceType === 'tts' && row.isActive && isOfficialProvider('tts', row.provider))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(rowToVoiceConfig)
}

function publicVoice(provider: string, voice: VoiceOption) {
  return {
    voice_id: voice.id,
    name: voice.name,
    gender: voice.gender,
    language: voice.language,
    description: voice.description || '',
    provider,
  }
}

export async function listAvailableVoices() {
  const configs = await listTtsConfigs()
  const providers = []
  for (const config of configs) {
    const adapter = getVoiceAdapter(config.provider)
    let voices = adapter.catalog
    let source: 'live' | 'catalog' = 'catalog'
    if (adapter.listVoices && config.apiKey) {
      try {
        const live = await adapter.listVoices(config)
        if (live?.length) {
          voices = live
          source = 'live'
        }
      } catch {
        source = 'catalog'
      }
    }
    providers.push({
      config_id: config.id,
      provider: config.provider,
      name: config.name,
      model: config.model,
      source,
      voices: voices.map(voice => publicVoice(config.provider, voice)),
    })
  }
  return { configured: providers.length > 0, providers }
}

async function requireCharacter(id: number) {
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!row || row.deletedAt) throw new Error('角色不存在')
  return row
}

function findKnownVoice(provider: string, voiceId: string) {
  return getVoiceAdapter(provider).catalog.find(voice => voice.id === voiceId) || null
}

export async function setCharacterVoice(id: number, body: any) {
  const row = await requireCharacter(id)
  const provider = String(body?.provider || '').trim().toLowerCase()
  const voiceId = String(body?.voice_id ?? body?.voiceId ?? '').trim()
  if (!isOfficialProvider('tts', provider)) throw new Error('不支持的语音服务商')
  if (!voiceId || voiceId.length > 128) throw new Error('音色 ID 无效')

  const configs = await listTtsConfigs()
  const requestedConfigId = Number(body?.config_id ?? body?.configId)
  let config = Number.isFinite(requestedConfigId)
    ? configs.find(item => item.id === requestedConfigId) || null
    : null
  if (requestedConfigId && !config) throw new Error('语音配置不存在或未启用')
  if (config && config.provider !== provider) throw new Error('该语音配置与音色服务商不一致')
  if (!config) config = configs.find(item => item.provider === provider) || null

  const known = findKnownVoice(provider, voiceId)
  const voiceName = String(body?.voice_name ?? body?.voiceName ?? '').trim() || known?.name || voiceId
  const sameVoice = row.voiceProvider === provider && row.voiceId === voiceId
  await db.update(schema.characters).set({
    ...voiceColumnValues({
      provider,
      voiceId,
      voiceName,
      clipUrl: sameVoice ? row.voiceClipUrl : null,
      meta: {
        config_id: config?.id ?? null,
        model: config?.model || null,
        gender: known?.gender || null,
        language: known?.language || null,
        description: known?.description || null,
      },
    }),
    updatedAt: now(),
  }).where(eq(schema.characters.id, id))

  const [fresh] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  return presentCharacter(fresh)
}

export async function clearCharacterVoice(id: number) {
  await requireCharacter(id)
  await db.update(schema.characters).set({ ...clearedVoiceColumns(), updatedAt: now() })
    .where(eq(schema.characters.id, id))
  const [fresh] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  return presentCharacter(fresh)
}

async function resolveSynthConfig(provider: string, configId: number | null): Promise<VoiceConfig> {
  const configs = await listTtsConfigs()
  const pinned = configId ? configs.find(item => item.id === configId && item.provider === provider) : null
  const config = pinned || configs.find(item => item.provider === provider) || null
  if (!config) throw new Error('未配置该服务商的语音合成，请到设置页添加并启用')
  if (!config.apiKey) throw new Error('语音合成配置缺少 API Key')
  return config
}

export async function previewCharacterVoice(id: number, body: any = {}) {
  let row = await requireCharacter(id)
  const image = row.imageUrl || row.localPath || ''
  if (!String(image).trim()) throw new Error('请先生成角色形象，再生成说话视频')

  let bound = readCharacterVoice(row)
  const requestedProvider = String(body?.provider || '').trim().toLowerCase()
  const requestedVoiceId = String(body?.voice_id ?? body?.voiceId ?? '').trim()
  if (requestedProvider && requestedVoiceId && (requestedProvider !== bound?.provider || requestedVoiceId !== bound?.voice_id)) {
    await setCharacterVoice(id, body)
    row = await requireCharacter(id)
    bound = readCharacterVoice(row)
  }
  const provider = bound?.provider || ''
  const voiceId = bound?.voice_id || ''
  if (!isOfficialProvider('tts', provider) || !voiceId) throw new Error('请先为角色选择音色')

  const requestedConfigId = Number(body?.config_id ?? body?.configId)
  const configId = Number.isFinite(requestedConfigId) && requestedConfigId > 0
    ? requestedConfigId
    : bound?.config_id ?? null
  const config = await resolveSynthConfig(provider, configId)
  const text = previewTextFor(row.name, body?.text)
  const audio = await getVoiceAdapter(provider).synthesize(config, { voiceId, text })
  const audioPath = await saveBinaryFile(audio, 'temp', '.mp3')
  let clipUrl = ''
  try {
    clipUrl = await renderSpeakingClip(image, audioPath)
  } finally {
    const audioAbs = getAbsolutePath(audioPath)
    if (fs.existsSync(audioAbs)) fs.unlinkSync(audioAbs)
  }

  const meta = {
    config_id: config.id ?? bound?.config_id ?? null,
    model: config.model || bound?.model || null,
    gender: bound?.meta.gender || null,
    language: bound?.meta.language || null,
    description: bound?.meta.description || null,
    sample_text: text,
  }
  await db.update(schema.characters).set({
    voiceClipUrl: clipUrl,
    voicePreviewUrl: null,
    voiceMeta: JSON.stringify(meta),
    updatedAt: now(),
  }).where(eq(schema.characters.id, id))

  const [fresh] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  return {
    clip_url: clipUrl,
    saved: true,
    text,
    character: presentCharacter(fresh),
  }
}
