import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

test('backend removes the voice assignment agent and tools', () => {
  const agents = read('src/agents/index.ts')
  const skills = read('src/agents/skills.ts')

  assert.doesNotMatch(agents, /voice_assigner/)
  assert.doesNotMatch(agents, /createVoiceTools/)
  assert.doesNotMatch(skills, /voice_assigner/)
  assert.equal(exists('src/agents/tools/voice-tools.ts'), false)
  assert.equal(exists('workspace/skills/voice_assigner/SKILL.md'), false)
})

test('backend removes audio service providers, TTS adapters, and voice routes', () => {
  const index = read('src/index.ts')
  const ai = read('src/services/ai.ts')
  const registry = read('src/services/adapters/registry.ts')
  const types = read('src/services/adapters/types.ts')

  assert.doesNotMatch(index, /aiVoices/)
  assert.doesNotMatch(ai, /audio/)
  assert.doesNotMatch(ai, /getAudioConfig/)
  assert.doesNotMatch(registry, /TTS/)
  assert.doesNotMatch(registry, /minimax-tts/)
  assert.doesNotMatch(types, /TTSProviderAdapter/)
  assert.equal(exists('src/routes/aiVoices.ts'), false)
  assert.equal(exists('src/services/tts-generation.ts'), false)
  assert.equal(exists('src/services/adapters/minimax-tts.ts'), false)
  assert.match(read('src/services/adapters/volcengine-video.ts'), /generate_audio:\s*record\.generateAudio/)
  assert.doesNotMatch(read('src/services/adapters/volcengine-video.ts'), /generate_audio:\s*false/)
})

test('backend keeps storyboard TTS removed and stores voice on the character', () => {
  const episodes = read('src/routes/episodes.ts')
  const storyboards = read('src/routes/storyboards.ts')
  const characters = read('src/routes/characters.ts')
  const schema = read('src/db/schema.ts')
  const sqliteSchema = read('src/db/sqlite-schema.ts')

  assert.doesNotMatch(episodes, /audio_config_id/)
  assert.doesNotMatch(episodes, /assign_voices/)
  assert.doesNotMatch(episodes, /generate_voice_samples/)
  assert.match(episodes, /dubbing-cast/)
  assert.doesNotMatch(storyboards, /generate-tts/)
  assert.doesNotMatch(storyboards, /ttsAudioUrl/)
  assert.doesNotMatch(characters, /generate-voice-sample/)
  assert.doesNotMatch(characters, /voiceStyle/)
  assert.match(characters, /\/voice\/preview/)
  assert.doesNotMatch(schema, /audioConfigId/)
  assert.doesNotMatch(schema, /voiceStyle/)
  assert.doesNotMatch(schema, /voiceSampleUrl/)
  assert.match(schema, /voiceProvider/)
  assert.match(schema, /voicePreviewUrl/)
  assert.doesNotMatch(schema, /ttsAudioUrl/)
  assert.doesNotMatch(schema, /aiVoices/)
  assert.match(sqliteSchema, /voice_provider TEXT/)
  assert.match(sqliteSchema, /voice_preview_url TEXT/)
  assert.doesNotMatch(sqliteSchema, /audio_config_id/)
  assert.doesNotMatch(sqliteSchema, /voice_style/)
  assert.doesNotMatch(sqliteSchema, /tts_audio_url/)
  assert.doesNotMatch(sqliteSchema, /CREATE TABLE IF NOT EXISTS ai_voices/)
  assert.equal(exists('src/services/voice/dubbing-cast.ts'), true)
})
