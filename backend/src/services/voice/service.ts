import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { getActiveConfig, isOfficialProvider, parseConfigTemperature, type AIConfig } from '../ai.js'
import { saveBinaryFile } from '../../utils/storage.js'
import { generateVideo } from '../generation.js'
import { talkingClipPrompt, talkingClipRequest } from './talking-clip.js'
import { now } from '../../utils/response.js'
import { getVoiceAdapter } from './adapters.js'
import { clearedVoiceColumns, parseVoiceMeta, presentCharacter, previewTextFor, voiceColumnValues } from './binding.js'
import { defaultVoiceFor, inferCharacterGender, inferPersona, pickPortraitVoice } from './catalog.js'
import { ensureMinAudioDuration } from './local-audio.js'
import { dubbingCastForEpisode } from './dubbing-cast.js'
import {
  audioDisplayName,
  listStoredAudioFiles,
  localAudioExists,
  localVoiceKey,
  mergeLibraryItems,
  normalizeLocalAudioUrl,
  voiceBindFromBody,
} from './local-audio.js'
import type { VoiceConfig } from './types.js'

export { presentCharacter, readCharacterVoice } from './binding.js'
export { dubbingCastForEpisode }

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
  }
}

export async function listTtsConfigs(): Promise<VoiceConfig[]> {
  const rows = await db.select().from(schema.aiServiceConfigs)
  return rows
    .filter(row => row.serviceType === 'tts' && row.isActive && isOfficialProvider('tts', row.provider))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(rowToVoiceConfig)
}

/** 服务器上已有的参考音频：角色已保存的优先带上名字，再补 voice-audio / uploads 里的文件。 */
export async function listLocalReferenceAudios() {
  const rows = await db.select().from(schema.characters)
  const saved = rows
    .filter(row => !row.deletedAt && row.voicePreviewUrl)
    .map(row => ({ audio_url: String(row.voicePreviewUrl), name: row.voiceName }))
  const items = mergeLibraryItems([...saved, ...listStoredAudioFiles()])
    .filter(item => localAudioExists(item.audio_url))
  return { items }
}

async function requireCharacter(id: number) {
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!row || row.deletedAt) throw new Error('角色不存在')
  return row
}

function characterGenderText(row: { name?: string | null; role?: string | null; appearance?: string | null; description?: string | null; styling?: string | null }) {
  return [row.role, row.appearance, row.description, row.styling, row.name]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join('\n')
}

export async function setCharacterVoice(id: number, body: any) {
  const row = await requireCharacter(id)
  const bind = voiceBindFromBody(body)
  if (!localAudioExists(bind.audioUrl)) throw new Error('参考音频不存在或已删除')
  const previous = normalizeLocalAudioUrl(row.voicePreviewUrl || '')
  const same = previous === bind.audioUrl
  const previousMeta = parseVoiceMeta(row.voiceMeta)
  const meta: Record<string, unknown> = {
    source: bind.source,
    sample_text: same && typeof previousMeta.sample_text === 'string' ? previousMeta.sample_text : null,
  }
  if (same && Number(previousMeta.clip_task_id) > 0) meta.clip_task_id = Number(previousMeta.clip_task_id)
  await db.update(schema.characters).set({
    ...voiceColumnValues({
      provider: 'local',
      voiceId: localVoiceKey(bind.audioUrl),
      voiceName: audioDisplayName(bind.audioUrl, bind.name),
      clipUrl: same ? row.voiceClipUrl : null,
      audioUrl: bind.audioUrl,
      meta,
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

function clipTaskMatches(raw: string | null, voiceKey: string) {
  try {
    const params = JSON.parse(raw || '{}')
    if (params.purpose !== 'voice_clip') return false
    return !params.voiceId || params.voiceId === voiceKey
  } catch {
    return false
  }
}

async function dramaAspectRatio(dramaId: number | null | undefined) {
  if (!dramaId) return null
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  return drama?.aspectRatio ?? null
}

async function mergeClipMeta(id: number, sampleText: string, taskId: number | null) {
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!row) return
  const meta = parseVoiceMeta(row.voiceMeta)
  meta.sample_text = sampleText
  if (taskId) meta.clip_task_id = taskId
  else delete meta.clip_task_id
  await db.update(schema.characters).set({
    voiceMeta: JSON.stringify(meta),
    updatedAt: now(),
  }).where(eq(schema.characters.id, id))
}

function unknownVoiceError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || '')
  return /voice|speaker|音色|voice_id|voice type|not exist|not found|invalid|denied/i.test(message)
}

async function synthesizeReference(config: VoiceConfig, voiceId: string, fallbackId: string, text: string) {
  const adapter = getVoiceAdapter(config.provider)
  try {
    return { audio: await adapter.synthesize(config, { voiceId, text }), voiceId }
  } catch (err) {
    if (!fallbackId || voiceId === fallbackId || !unknownVoiceError(err)) throw err
    return { audio: await adapter.synthesize(config, { voiceId: fallbackId, text }), voiceId: fallbackId }
  }
}

/** 用已保存的参考音频和形象照做口型试听。不重新选音色，也不再合成一条新的参考音频。 */
async function enqueueTalkingClip(
  row: typeof schema.characters.$inferSelect,
  audioUrl: string | null,
  text: string,
  videoConfig: AIConfig,
) {
  const image = String(row.imageUrl || row.localPath || '').trim()
  let voiceKey = String(row.voiceId || '').trim() || (audioUrl ? localVoiceKey(audioUrl) : 'model-native-audio')
  const processing = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.characterId, row.id),
    eq(schema.sysTask.type, 'video'),
    eq(schema.sysTask.status, 'processing'),
  ))
  const pending = processing.find(task => clipTaskMatches(task.params, voiceKey))
  if (pending) {
    await mergeClipMeta(row.id, text, pending.id)
    return { taskId: pending.id, status: 'processing' as const }
  }
  const assetKey = audioUrl ? localVoiceKey(audioUrl) : null
  if (assetKey && voiceKey !== assetKey) {
    voiceKey = assetKey
    await db.update(schema.characters).set({
      voiceProvider: 'local',
      voiceId: assetKey,
      updatedAt: now(),
    }).where(eq(schema.characters.id, row.id))
  }
  const prompt = talkingClipPrompt(row.name, text)
  const clipRequest = talkingClipRequest(videoConfig.provider, image, audioUrl, prompt, await dramaAspectRatio(row.dramaId))
  const taskId = await generateVideo({
    characterId: row.id,
    dramaId: row.dramaId,
    configId: videoConfig.id,
    // 没有参考音频时不要传 voiceId，否则任务完成回调会判定「音色已变」而不回写 voice_clip_url
    voiceId: audioUrl ? voiceKey : undefined,
    ...clipRequest,
  })
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  await mergeClipMeta(row.id, text, task?.status === 'processing' ? taskId : null)
  return { taskId, status: task?.status || 'processing' }
}

export async function previewCharacterVoice(id: number, body: any = {}) {
  const row = await requireCharacter(id)
  const image = String(row.imageUrl || row.localPath || '').trim()
  if (!image) throw new Error('请先生成角色形象，再生成说话视频')
  // 参考音频改为可选：没有就按角色形象与台词直接生成，由视频模型自己出声
  const savedAudio = normalizeLocalAudioUrl(row.voicePreviewUrl)
  const audioUrl = savedAudio && localAudioExists(savedAudio) ? savedAudio : null
  const videoConfig = await getActiveConfig('video')
  if (!videoConfig) throw new Error('未配置视频模型，请先到设置页添加并启用')
  const meta = parseVoiceMeta(row.voiceMeta)
  const text = previewTextFor(row.name, body?.text || (typeof meta.sample_text === 'string' ? meta.sample_text : ''))
  const started = await enqueueTalkingClip(row, audioUrl, text, videoConfig)
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, started.taskId))
  const [fresh] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  return {
    task_id: started.taskId,
    status: task?.status || started.status,
    error: task?.status === 'failed' ? task.errorMsg : null,
    text,
    character: presentCharacter(fresh),
  }
}

/** 按形象照生成一条参考音频并保存到本地。语音服务只在内部合成，用户不指定远程音色 ID。 */
export async function generateCharacterVoiceFromPortrait(id: number, body: any = {}) {
  const row = await requireCharacter(id)
  const image = String(row.imageUrl || row.localPath || '').trim()
  if (!image) throw new Error('请先生成角色形象，再根据形象照生成音色')

  const configs = await listTtsConfigs()
  const previous = parseVoiceMeta(row.voiceMeta)
  const pinnedId = Number(previous.config_id)
  const config = (Number.isFinite(pinnedId) ? configs.find(item => item.id === pinnedId) : null) || configs[0]
  if (!config) throw new Error('未配置语音合成，请到设置页添加并启用')
  if (!config.apiKey) throw new Error('语音合成配置缺少 API Key')

  const genderText = characterGenderText(row)
  const gender = inferCharacterGender(genderText)
  // 气质/年龄段决定音色池，避免同剧同性别角色撞声线
  const persona = inferPersona([
    row.name, row.role, row.description, row.appearance, row.styling,
  ].filter(Boolean).join(' '))
  const fallback = pickPortraitVoice(config.provider, gender, persona, `${row.id}:${row.name || ''}`)
  const storedVoiceId = previous.synth_provider === config.provider && typeof previous.synth_voice_id === 'string'
    ? previous.synth_voice_id.trim()
    : ''
  const text = previewTextFor(row.name, body?.text)
  const synthesized = await synthesizeReference(config, storedVoiceId || fallback.id, fallback.id, text)
  const audioPath = await saveBinaryFile(synthesized.audio, 'voice-audio', '.mp3')
  // 上游 r2v 要求参考音频 ≥1.8s，短句先补静音，避免说话片段报 400
  await ensureMinAudioDuration(audioPath)
  const voiceName = audioDisplayName(audioPath, row.name ? `${row.name}的参考音色` : '形象照参考音色')
  await db.update(schema.characters).set({
    ...voiceColumnValues({
      provider: 'local',
      voiceId: localVoiceKey(audioPath),
      voiceName,
      clipUrl: null,
      audioUrl: audioPath,
      meta: {
        source: 'portrait',
        config_id: config.id ?? null,
        model: config.model || null,
        gender,
        persona,
        sample_text: text,
        synth_provider: config.provider,
        synth_voice_id: synthesized.voiceId,
      },
    }),
    updatedAt: now(),
  }).where(eq(schema.characters.id, id))

  let taskId: number | null = null
  let status = 'saved'
  let clipError: string | null = null
  const videoConfig = await getActiveConfig('video')
  if (videoConfig) {
    try {
      const fresh = await requireCharacter(id)
      const started = await enqueueTalkingClip(fresh, audioPath, text, videoConfig)
      taskId = started.taskId
      status = started.status
    } catch (err: any) {
      clipError = err?.message || '说话视频生成失败'
    }
  }
  const [done] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  return {
    task_id: taskId,
    status,
    clip_error: clipError,
    text,
    character: presentCharacter(done),
  }
}
