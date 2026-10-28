import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'
import { presentCharacter, previewTextFor, readCharacterVoice } from '../src/services/voice/binding.ts'
import { appendVoiceClipNote, collectVoiceClips, voiceClipLimit } from '../src/services/video-request.ts'
import { talkingClipPrompt, talkingClipRequest } from '../src/services/voice/talking-clip.ts'
import {
  buildMinimaxSpeechRequest,
  buildOpenAiSpeechRequest,
  buildVolcengineSpeechRequest,
  decodeAudioPayload,
  parseMinimaxAudio,
  parseVolcengineAudio,
} from '../src/services/voice/adapters.ts'
import { MINIMAX_VOICES, OPENAI_VOICES, VOLCENGINE_VOICES } from '../src/services/voice/catalog.ts'
import type { VoiceConfig } from '../src/services/voice/types.ts'

const config = (partial: Partial<VoiceConfig>): VoiceConfig => ({
  provider: 'openai',
  name: 'test',
  baseUrl: 'https://example.test',
  apiKey: 'sk-test',
  model: 'tts-1',
  appId: null,
  ...partial,
})

test('character voice is absent until both provider and voice id are stored', () => {
  assert.equal(readCharacterVoice(null), null)
  assert.equal(readCharacterVoice({ voiceProvider: 'openai', voiceId: '  ' }), null)
  assert.equal(readCharacterVoice({ voiceProvider: '', voiceId: 'alloy' }), null)
})

test('character voice round-trips metadata and is attached for later dubbing', () => {
  const row = {
    id: 7,
    name: '林小雨',
    voiceProvider: 'minimax',
    voiceId: 'female-shaonv',
    voiceName: '少女',
    voiceClipUrl: 'static/voice-clips/demo.mp4',
    voiceMeta: JSON.stringify({ config_id: 4, model: 'speech-02-hd', gender: 'female', language: 'zh', sample_text: '大家好' }),
  }
  const voice = readCharacterVoice(row)
  assert.equal(voice?.provider, 'minimax')
  assert.equal(voice?.voice_id, 'female-shaonv')
  assert.equal(voice?.name, '少女')
  assert.equal(voice?.clip_url, 'static/voice-clips/demo.mp4')
  assert.equal(voice?.config_id, 4)
  assert.equal(voice?.model, 'speech-02-hd')
  assert.equal(voice?.meta.gender, 'female')
  const presented = presentCharacter(row)
  assert.equal(presented.voice_id, 'female-shaonv')
  assert.deepEqual(presented.voice, voice)
})

test('preview line uses the character name and caps custom text', () => {
  assert.equal(previewTextFor('阿宁', ''), '大家好，我是阿宁。')
  assert.equal(previewTextFor('', '  '), '大家好，这是一段音色试听。')
  assert.equal(previewTextFor('阿宁', '甲'.repeat(200)).length, 120)
})

test('speech requests follow each vendor contract', () => {
  const openai = buildOpenAiSpeechRequest(config({ baseUrl: 'https://api.openai.com/v1', model: 'tts-1' }), { voiceId: 'nova', text: 'hi' })
  assert.equal(openai.url, 'https://api.openai.com/v1/audio/speech')
  assert.equal(openai.headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(openai.body, { model: 'tts-1', input: 'hi', voice: 'nova', response_format: 'mp3' })

  const minimax = buildMinimaxSpeechRequest(config({ provider: 'minimax', baseUrl: 'https://api.minimaxi.com', model: 'speech-02-hd' }), { voiceId: 'female-shaonv', text: '你好' })
  assert.equal(minimax.url, 'https://api.minimaxi.com/v1/t2a_v2')
  assert.equal((minimax.body as any).voice_setting.voice_id, 'female-shaonv')
  assert.equal((minimax.body as any).stream, false)

  const volc = buildVolcengineSpeechRequest(config({
    provider: 'volcengine',
    baseUrl: 'https://openspeech.bytedance.com',
    apiKey: 'token-1',
    appId: 'app-9',
    model: 'volcano_tts',
  }), { voiceId: 'zh_female_shuangkuaisisi_moon_bigtts', text: '试听' })
  assert.equal(volc.url, 'https://openspeech.bytedance.com/api/v1/tts')
  assert.equal(volc.headers.Authorization, 'Bearer;token-1')
  assert.equal((volc.body as any).app.appid, 'app-9')
  assert.equal((volc.body as any).app.cluster, 'volcano_tts')
  assert.equal((volc.body as any).audio.voice_type, 'zh_female_shuangkuaisisi_moon_bigtts')
  assert.equal((volc.body as any).request.operation, 'query')
})

test('vendor audio payloads decode to bytes', () => {
  const pcm = Buffer.from([0x49, 0x44, 0x33])
  assert.deepEqual(decodeAudioPayload(pcm.toString('hex')), pcm)
  assert.deepEqual(parseMinimaxAudio({ base_resp: { status_code: 0 }, data: { audio: pcm.toString('hex') } }), pcm)
  assert.throws(() => parseMinimaxAudio({ base_resp: { status_code: 1001, status_msg: 'bad key' } }), /bad key/)
  assert.deepEqual(parseVolcengineAudio({ code: 3000, data: pcm.toString('base64') }), pcm)
  assert.throws(() => parseVolcengineAudio({ code: 3001, message: 'quota' }), /quota/)
})

test('built-in voice catalogs keep unique ids', () => {
  for (const list of [OPENAI_VOICES, MINIMAX_VOICES, VOLCENGINE_VOICES]) {
    assert.equal(new Set(list.map(voice => voice.id)).size, list.length)
    assert.ok(list.length >= 8)
  }
  assert.ok(OPENAI_VOICES.some(voice => voice.id === 'nova'))
  assert.ok(MINIMAX_VOICES.some(voice => voice.id === 'female-shaonv'))
  assert.ok(VOLCENGINE_VOICES.some(voice => voice.id === 'zh_female_shuangkuaisisi_moon_bigtts'))
})

test('speaking clips are attached as reference videos, not audio', () => {
  assert.equal(voiceClipLimit('volcengine'), 3)
  assert.equal(voiceClipLimit('minimax'), 3)
  assert.equal(voiceClipLimit('aliyun'), 5)
  const clips = collectVoiceClips([
    { id: 1, name: '林小雨', voiceClipUrl: 'static/voice-clips/a.mp4' },
    { id: 2, name: '旁白', voiceClipUrl: '' },
    { id: 3, name: '阿宁', voiceClipUrl: 'static/voice-clips/b.mp4' },
    { id: 4, name: '多出来', voiceClipUrl: 'static/voice-clips/c.mp4' },
    { id: 5, name: '再多', voiceClipUrl: 'static/voice-clips/d.mp4' },
  ], 3)
  assert.deepEqual(clips.map(clip => clip.name), ['林小雨', '阿宁', '多出来'])
  assert.equal(clips[0].index, 1)
  const prompt = appendVoiceClipNote('开场', clips.slice(0, 1))
  assert.match(prompt, /@视频1 是林小雨的说话样本/)
  assert.equal(appendVoiceClipNote('开场', []), '开场')
})

test('talking preview asks the video model for lip sync from the portrait and the voice line', () => {
  const line = '大家好，我是林小雨。'
  const prompt = talkingClipPrompt('林小雨', line)
  assert.match(prompt, /口型与参考音频一致/)
  assert.match(prompt, /大家好，我是林小雨/)
  const seedance = talkingClipRequest('volcengine', 'static/face.png', 'static/voice-audio/a.mp3', prompt)
  assert.deepEqual(seedance.referenceImageUrls, ['static/face.png'])
  assert.deepEqual(seedance.referenceAudioUrls, ['static/voice-audio/a.mp3'])
  assert.equal(seedance.firstFrameUrl, undefined)
  assert.equal(seedance.purpose, 'voice_clip')
  assert.equal(seedance.generateAudio, true)
  const minimax = talkingClipRequest('minimax', 'static/face.png', 'static/voice-audio/a.mp3', prompt)
  assert.equal(minimax.firstFrameUrl, 'static/face.png')
  assert.equal(minimax.referenceImageUrls, undefined)
  const wan = talkingClipRequest('aliyun', 'static/face.png', 'static/voice-audio/a.mp3', prompt)
  assert.deepEqual(wan.referenceImageUrls, ['static/face.png'])
  assert.equal(wan.firstFrameUrl, undefined)
})

test('existing character tables gain voice columns on startup', () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`CREATE TABLE characters (
    id INTEGER PRIMARY KEY,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  initSqliteSchema(sqlite)
  const names = (sqlite.prepare('PRAGMA table_info(characters)').all() as { name: string }[]).map(col => col.name)
  for (const column of ['voice_provider', 'voice_id', 'voice_name', 'voice_preview_url', 'voice_clip_url', 'voice_meta']) {
    assert.ok(names.includes(column), column)
  }
  sqlite.close()
})
