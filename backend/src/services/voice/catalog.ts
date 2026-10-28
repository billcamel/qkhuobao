import type { VoiceGender, VoiceOption } from './types.js'

function voice(id: string, name: string, gender: VoiceGender, language: string, description?: string): VoiceOption {
  return { id, name, gender, language, description }
}

/**
 * 内置目录只给「根据形象照生成参考音频」在内部挑一条合成音色。
 * 用户不从这里选择远程 voice_id；角色绑定的是落在服务器上的参考音频。
 */
export const OPENAI_VOICES: VoiceOption[] = [
  voice('alloy', '合金', 'neutral', 'multi', 'OpenAI alloy，中性'),
  voice('ash', '灰调', 'male', 'multi', 'OpenAI ash'),
  voice('ballad', '叙事', 'male', 'multi', 'OpenAI ballad'),
  voice('coral', '珊瑚', 'female', 'multi', 'OpenAI coral'),
  voice('echo', '回声', 'male', 'multi', 'OpenAI echo'),
  voice('fable', '寓言', 'neutral', 'multi', 'OpenAI fable'),
  voice('nova', '新星', 'female', 'multi', 'OpenAI nova'),
  voice('onyx', '沉稳', 'male', 'multi', 'OpenAI onyx'),
  voice('sage', '智者', 'neutral', 'multi', 'OpenAI sage'),
  voice('shimmer', '微光', 'female', 'multi', 'OpenAI shimmer'),
  voice('verse', '诗韵', 'male', 'multi', 'OpenAI verse'),
]

export const MINIMAX_VOICES: VoiceOption[] = [
  voice('male-qn-qingse', '青涩青年', 'male', 'zh', 'MiniMax 系统音色'),
  voice('male-qn-jingying', '精英青年', 'male', 'zh', 'MiniMax 系统音色'),
  voice('male-qn-badao', '霸道青年', 'male', 'zh', 'MiniMax 系统音色'),
  voice('male-qn-daxuesheng', '青年大学生', 'male', 'zh', 'MiniMax 系统音色'),
  voice('female-shaonv', '少女', 'female', 'zh', 'MiniMax 系统音色'),
  voice('female-yujie', '御姐', 'female', 'zh', 'MiniMax 系统音色'),
  voice('female-chengshu', '成熟女性', 'female', 'zh', 'MiniMax 系统音色'),
  voice('female-tianmei', '甜美女性', 'female', 'zh', 'MiniMax 系统音色'),
  voice('presenter_male', '男主持人', 'male', 'zh', 'MiniMax 系统音色'),
  voice('presenter_female', '女主持人', 'female', 'zh', 'MiniMax 系统音色'),
  voice('audiobook_male_1', '男有声书', 'male', 'zh', 'MiniMax 系统音色'),
  voice('audiobook_female_1', '女有声书', 'female', 'zh', 'MiniMax 系统音色'),
  voice('junlang_nanyou', '俊朗男友', 'male', 'zh', 'MiniMax 系统音色'),
  voice('tianxin_xiaoling', '甜心小玲', 'female', 'zh', 'MiniMax 系统音色'),
  voice('wumei_yujie', '妩媚御姐', 'female', 'zh', 'MiniMax 系统音色'),
  voice('clever_boy', '聪明男童', 'child', 'zh', 'MiniMax 系统音色'),
  voice('lovely_girl', '萌萌女童', 'child', 'zh', 'MiniMax 系统音色'),
]

/**
 * 豆包语音合成 2.0（uranus_bigtts）常用 voice_type。
 * 资源 ID 用 seed-tts-2.0；2.0 资源不认 1.0 的 moon_bigtts 音色，
 * 混用会报 `resource ID is mismatched with speaker related resource`。
 * 下列音色均为实测可用（seed-tts-2.0 + 24k mp3）。
 */
export const VOLCENGINE_VOICES: VoiceOption[] = [
  voice('zh_female_shuangkuaisisi_uranus_bigtts', '爽快思思', 'female', 'zh', '豆包语音 2.0'),
  voice('zh_male_wennuanahu_uranus_bigtts', '温暖阿虎', 'male', 'zh', '豆包语音 2.0'),
  voice('zh_male_shaonianzixin_uranus_bigtts', '少年梓辛', 'male', 'zh', '豆包语音 2.0'),
  voice('zh_female_tianmeixiaoyuan_uranus_bigtts', '甜美小源', 'female', 'zh', '豆包语音 2.0'),
  voice('zh_female_vv_uranus_bigtts', 'Vv 女声', 'female', 'zh', '豆包语音 2.0'),
  voice('zh_female_xiaohe_uranus_bigtts', '小何', 'female', 'zh', '豆包语音 2.0'),
  voice('zh_male_ruyayichen_uranus_bigtts', '儒雅逸辰', 'male', 'zh', '豆包语音 2.0'),
  voice('zh_male_baqiqingshu_uranus_bigtts', '霸气青叔', 'male', 'zh', '豆包语音 2.0'),
  voice('zh_male_yangguangqingnian_uranus_bigtts', '阳光青年', 'male', 'zh', '豆包语音 2.0'),
  voice('zh_female_wenrouxiaoya_uranus_bigtts', '温柔小雅', 'female', 'zh', '豆包语音 2.0'),
]

export function inferGender(id: string, name: string): VoiceGender {
  const text = `${id} ${name}`.toLowerCase()
  if (/child|boy|girl|童|kid/.test(text)) return 'child'
  if (/female|woman|girl|女|shaonv|yujie|xiaoling|xiaohe|xiaoyuan|xiaoya/.test(text)) return 'female'
  if (/male|man|男|qingse|jingying|badao|nanyou|ahu|zixin/.test(text)) return 'male'
  return 'neutral'
}

export function catalogFor(provider: string): VoiceOption[] {
  switch ((provider || '').toLowerCase()) {
    case 'openai': return OPENAI_VOICES
    case 'minimax': return MINIMAX_VOICES
    case 'volcengine': return VOLCENGINE_VOICES
    default: return []
  }
}

/** 从角色文案推断性别。只用于形象照生成时在内部合成，不展示成音色列表。 */
export function inferCharacterGender(text: string): VoiceGender {
  const raw = String(text || '')
  if (/女孩|男孩|男童|女童|儿童|小孩|幼童|童声|萝莉|正太|\bchild\b|\bkid\b|\bgirl\b|\bboy\b/i.test(raw)) return 'child'
  if (/女|少女|御姐|女士|\bwoman\b|\bfemale\b/i.test(raw)) return 'female'
  if (/男|少年|大叔|先生|\bman\b|\bmale\b/i.test(raw)) return 'male'
  return 'neutral'
}

/** 形象照生成时内部使用的合成音色。调用方不传入远程 voice_id。 */
const PORTRAIT_VOICE_ID: Record<string, Record<VoiceGender, string>> = {
  openai: { female: 'nova', male: 'onyx', child: 'shimmer', neutral: 'alloy' },
  minimax: { female: 'female-shaonv', male: 'male-qn-qingse', child: 'lovely_girl', neutral: 'female-chengshu' },
  // 统一走 2.0（seed-tts-2.0 + uranus_bigtts），与已开通资源一致
  volcengine: {
    female: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
    male: 'zh_male_yangguangqingnian_uranus_bigtts',
    child: 'zh_female_vv_uranus_bigtts',
    neutral: 'zh_female_wenrouxiaoya_uranus_bigtts',
  },
}

export function defaultVoiceFor(provider: string, gender: VoiceGender): VoiceOption {
  const list = catalogFor(provider)
  if (!list.length) throw new Error('不支持的语音服务商')
  const id = PORTRAIT_VOICE_ID[provider.toLowerCase()]?.[gender]
  return list.find(voice => voice.id === id) || list.find(voice => voice.gender === gender) || list[0]
}
