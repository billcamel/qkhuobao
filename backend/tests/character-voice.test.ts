import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { presentCharacter, previewTextFor, readCharacterVoice } from '../src/services/voice/binding.ts'
import { appendVoiceAudioNote, collectVoiceAudios, voiceAudioLimit } from '../src/services/video-request.ts'
import { talkingClipPrompt, talkingClipRequest } from '../src/services/voice/talking-clip.ts'
import { catalogFor, defaultVoiceFor, inferCharacterGender } from '../src/services/voice/catalog.ts'
import { listStoredAudioFiles, mergeLibraryItems, normalizeLocalAudioUrl, voiceBindFromBody } from '../src/services/voice/local-audio.ts'
import {
  buildMinimaxSpeechRequest,
  buildOpenAiSpeechRequest,
  buildVolcengineSpeechRequest,
  decodeAudioPayload,
  parseMinimaxAudio,
  parseVolcengineAudio,
  volcengineResourceId,
} from '../src/services/voice/adapters.ts'
import { MINIMAX_VOICES, OPENAI_VOICES, VOLCENGINE_VOICES } from '../src/services/voice/catalog.ts'
import type { VoiceConfig } from '../src/services/voice/types.ts'

const config = (partial: Partial<VoiceConfig>): VoiceConfig => ({
  provider: 'openai',
  name: 'test',
  baseUrl: 'https://example.test',
  apiKey: 'sk-test',
  model: 'tts-1',
  ...partial,
})

test('character voice is the saved local audio, not a remote voice id', () => {
  assert.equal(readCharacterVoice(null), null)
  assert.equal(readCharacterVoice({ voiceProvider: 'openai', voiceId: 'alloy' }), null)
  assert.equal(readCharacterVoice({ voiceProvider: 'minimax', voiceId: 'female-shaonv', voicePreviewUrl: '  ' }), null)
  const audioOnly = readCharacterVoice({ voicePreviewUrl: 'static/voice-audio/demo.mp3', voiceName: '林小雨的参考音色' })
  assert.equal(audioOnly?.provider, 'local')
  assert.equal(audioOnly?.voice_id, 'local:demo.mp3')
  assert.equal(audioOnly?.audio_url, 'static/voice-audio/demo.mp3')
  assert.equal(audioOnly?.name, '林小雨的参考音色')
  assert.equal(audioOnly?.source, null)
})

test('character voice round-trips the local asset and hides the internal synth id', () => {
  const row = {
    id: 7,
    name: '林小雨',
    voiceProvider: 'local',
    voiceId: 'local:demo.mp3',
    voiceName: '林小雨的参考音色',
    voicePreviewUrl: 'static/voice-audio/demo.mp3',
    voiceClipUrl: 'static/voice-clips/demo.mp4',
    voiceMeta: JSON.stringify({
      source: 'portrait',
      config_id: 4,
      model: 'speech-02-hd',
      gender: 'female',
      language: 'zh',
      sample_text: '大家好',
      synth_provider: 'minimax',
      synth_voice_id: 'female-shaonv',
    }),
  }
  const voice = readCharacterVoice(row)
  assert.equal(voice?.provider, 'local')
  assert.equal(voice?.voice_id, 'local:demo.mp3')
  assert.equal(voice?.name, '林小雨的参考音色')
  assert.equal(voice?.audio_url, 'static/voice-audio/demo.mp3')
  assert.equal(voice?.clip_url, 'static/voice-clips/demo.mp4')
  assert.equal(voice?.source, 'portrait')
  assert.equal(voice?.config_id, 4)
  assert.equal(voice?.model, 'speech-02-hd')
  assert.equal(voice?.meta.gender, 'female')
  assert.equal(JSON.stringify(voice).includes('female-shaonv'), false)
  const presented = presentCharacter(row)
  assert.equal(presented.voice_provider, 'local')
  assert.equal(presented.voice_id, 'local:demo.mp3')
  assert.equal(presented.voice_preview_url, 'static/voice-audio/demo.mp3')
  assert.deepEqual(presented.voice, voice)
  assert.equal(JSON.stringify(presented).includes('female-shaonv'), false)

  const legacy = presentCharacter({
    voiceProvider: 'minimax',
    voiceId: 'female-shaonv',
    voiceName: '少女',
    voicePreviewUrl: '/static/voice-audio/legacy.mp3',
    voiceMeta: JSON.stringify({ synth_voice_id: 'zh_female_shuangkuaisisi_moon_bigtts' }),
  })
  assert.equal(legacy.voice.provider, 'local')
  assert.equal(legacy.voice.voice_id, 'local:legacy.mp3')
  assert.equal(legacy.voice.audio_url, 'static/voice-audio/legacy.mp3')
  assert.equal(legacy.voice_id, 'local:legacy.mp3')
  assert.equal(JSON.stringify(legacy).includes('shuangkuaisisi'), false)
})

test('local reference audio rejects remote urls and provider voice ids', () => {
  assert.equal(normalizeLocalAudioUrl('/static/uploads/take.wav'), 'static/uploads/take.wav')
  assert.equal(normalizeLocalAudioUrl('static/voice-audio/demo.mp3'), 'static/voice-audio/demo.mp3')
  assert.equal(normalizeLocalAudioUrl('https://cdn.example/a.mp3'), null)
  assert.equal(normalizeLocalAudioUrl('static/voice-audio/../../etc/passwd.mp3'), null)
  assert.equal(normalizeLocalAudioUrl('static/images/face.png'), null)
  assert.throws(() => voiceBindFromBody({ provider: 'volcengine', voice_id: 'zh_female_shuangkuaisisi_moon_bigtts' }), /不再绑定远程音色/)
  assert.throws(() => voiceBindFromBody({}), /请上传或选择本地参考音频/)
  assert.deepEqual(voiceBindFromBody({ audio_url: 'static/uploads/a.m4a', name: '旁白', source: 'library' }), {
    audioUrl: 'static/uploads/a.m4a',
    name: '旁白',
    source: 'library',
  })
})

test('portrait generation picks an internal voice from the character text', () => {
  assert.equal(inferCharacterGender('女主，长发御姐'), 'female')
  assert.equal(inferCharacterGender('十岁男孩'), 'child')
  assert.equal(inferCharacterGender('阳光少年'), 'male')
  assert.equal(inferCharacterGender(''), 'neutral')
  for (const provider of ['openai', 'minimax', 'volcengine']) {
    for (const gender of ['female', 'male', 'neutral', 'child'] as const) {
      const voice = defaultVoiceFor(provider, gender)
      assert.equal(catalogFor(provider).some(item => item.id === voice.id), true)
    }
  }
  assert.throws(() => defaultVoiceFor('custom', 'female'), /不支持的语音服务商/)
})

test('server library keeps one row per audio file and prefers a saved name', () => {
  const merged = mergeLibraryItems([
    { audio_url: 'static/voice-audio/demo.mp3', name: '林小雨的参考音色' },
    { audio_url: '/static/voice-audio/demo.mp3', name: 'demo' },
    { audio_url: 'https://example.com/nope.mp3', name: '远程' },
    { audio_url: 'static/uploads/take.wav' },
  ])
  assert.deepEqual(merged, [
    { audio_url: 'static/voice-audio/demo.mp3', name: '林小雨的参考音色' },
    { audio_url: 'static/uploads/take.wav', name: 'take' },
  ])
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-voice-'))
  fs.mkdirSync(path.join(root, 'voice-audio'))
  fs.mkdirSync(path.join(root, 'uploads'))
  fs.writeFileSync(path.join(root, 'voice-audio', 'keep.mp3'), 'mp3')
  fs.writeFileSync(path.join(root, 'uploads', 'note.txt'), 'no')
  fs.writeFileSync(path.join(root, 'uploads', 'clip.aac'), 'aac')
  const files = listStoredAudioFiles(root).map(item => item.audio_url).sort()
  assert.deepEqual(files, ['static/uploads/clip.aac', 'static/voice-audio/keep.mp3'])
  fs.rmSync(root, { recursive: true, force: true })
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
    model: 'volcano_tts',
  }), { voiceId: 'zh_female_shuangkuaisisi_moon_bigtts', text: '试听' })
  assert.equal(volc.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
  assert.equal(volc.headers['X-Api-Key'], 'token-1')
  assert.equal(volc.headers['X-Api-Resource-Id'], 'seed-tts-1.0')
  assert.match(volc.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/i)
  assert.equal(volc.headers.Authorization, undefined)
  assert.equal((volc.body as any).app, undefined)
  assert.equal((volc.body as any).user.uid, 'huobao-drama')
  assert.equal((volc.body as any).req_params.text, '试听')
  assert.equal((volc.body as any).req_params.speaker, 'zh_female_shuangkuaisisi_moon_bigtts')
  assert.deepEqual((volc.body as any).req_params.audio_params, { format: 'mp3', sample_rate: 24000 })

  const v2 = buildVolcengineSpeechRequest(config({
    provider: 'volcengine',
    baseUrl: 'https://openspeech.bytedance.com',
    apiKey: 'key-2',
    model: 'seed-tts-2.0',
  }), { voiceId: 'zh_female_vv_uranus_bigtts', text: '你好' })
  assert.equal(v2.headers['X-Api-Resource-Id'], 'seed-tts-2.0')
  assert.equal(v2.headers.Authorization, undefined)
  assert.equal(volcengineResourceId(''), 'seed-tts-1.0')
  assert.equal(volcengineResourceId('volcano_icl'), 'seed-icl-1.0')
  assert.equal(volcengineResourceId('seed-icl-2.0'), 'seed-icl-2.0')
})

test('vendor audio payloads decode to bytes', () => {
  const pcm = Buffer.from([0x49, 0x44, 0x33])
  assert.deepEqual(decodeAudioPayload(pcm.toString('hex')), pcm)
  assert.deepEqual(parseMinimaxAudio({ base_resp: { status_code: 0 }, data: { audio: pcm.toString('hex') } }), pcm)
  assert.throws(() => parseMinimaxAudio({ base_resp: { status_code: 1001, status_msg: 'bad key' } }), /bad key/)
  const head = Buffer.from([0x49, 0x44])
  const tail = Buffer.from([0x33])
  const stream = [
    `data: ${JSON.stringify({ code: 0, message: '', data: head.toString('base64') })}`,
    JSON.stringify({ code: 0, message: '', data: null, sentence: { text: '试' } }),
    JSON.stringify({ code: 0, message: '', data: tail.toString('base64') }),
    JSON.stringify({ code: 20000000, message: 'ok', data: null }),
  ].join('\n')
  assert.deepEqual(parseVolcengineAudio(stream), Buffer.concat([head, tail]))
  assert.throws(() => parseVolcengineAudio(JSON.stringify({ code: 45000000, message: 'speaker permission denied' })), /speaker permission denied/)
  assert.throws(() => parseVolcengineAudio(''), /没有返回音频/)
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

test('shot generation attaches the local reference audio, not the talking clip', () => {
  assert.equal(voiceAudioLimit('volcengine'), 3)
  assert.equal(voiceAudioLimit('minimax'), 3)
  assert.equal(voiceAudioLimit('aliyun'), 5)
  const audios = collectVoiceAudios([
    { id: 1, name: '林小雨', voicePreviewUrl: 'static/voice-audio/a.mp3' },
    { id: 2, name: '旁白', voicePreviewUrl: '' },
    { id: 3, name: '阿宁', voicePreviewUrl: 'static/voice-audio/b.mp3' },
    { id: 4, name: '多出来', voicePreviewUrl: 'static/voice-audio/c.mp3' },
    { id: 5, name: '再多', voicePreviewUrl: 'static/voice-audio/d.mp3' },
  ], 3)
  assert.deepEqual(audios.map(audio => audio.name), ['林小雨', '阿宁', '多出来'])
  assert.equal(audios[0].url, 'static/voice-audio/a.mp3')
  assert.equal(audios[0].index, 1)
  const prompt = appendVoiceAudioNote('开场', audios.slice(0, 1))
  assert.match(prompt, /@音频1 是林小雨的参考音色/)
  assert.doesNotMatch(prompt, /@视频/)
  assert.equal(appendVoiceAudioNote('开场', []), '开场')
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
