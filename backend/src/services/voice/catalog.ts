import type { VoiceGender, VoiceOption } from './types.js'

function voice(id: string, name: string, gender: VoiceGender, language: string, description?: string): VoiceOption {
  return { id, name, gender, language, description }
}

/**
 * 内置目录是离线兜底。MiniMax 配置了密钥时会优先用实时列表覆盖。
 * 不在目录里的 voice_id（复刻音色）仍允许绑定。
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

/** 豆包语音合成大模型常用 voice_type。cluster 用配置里的模型名，默认 volcano_tts。 */
export const VOLCENGINE_VOICES: VoiceOption[] = [
  voice('zh_female_shuangkuaisisi_moon_bigtts', '爽快思思', 'female', 'zh', '豆包语音 moon'),
  voice('zh_male_wennuanahu_moon_bigtts', '温暖阿虎', 'male', 'zh', '豆包语音 moon'),
  voice('zh_male_shaonianzixin_moon_bigtts', '少年梓辛', 'male', 'zh', '豆包语音 moon'),
  voice('zh_female_tianmeixiaoyuan_moon_bigtts', '甜美小源', 'female', 'zh', '豆包语音 moon'),
  voice('zh_female_gaolengyujie_moon_bigtts', '高冷御姐', 'female', 'zh', '豆包语音 moon'),
  voice('zh_male_aojiaobazong_moon_bigtts', '傲娇霸总', 'male', 'zh', '豆包语音 moon'),
  voice('zh_female_wanwanxiaohe_moon_bigtts', '湾湾小何', 'female', 'zh', '豆包语音 moon'),
  voice('zh_female_linjianvhai_moon_bigtts', '邻家女孩', 'female', 'zh', '豆包语音 moon'),
  voice('zh_male_yangguangqingnian_moon_bigtts', '阳光青年', 'male', 'zh', '豆包语音 moon'),
  voice('zh_male_jingqiangkanye_moon_bigtts', '京腔侃爷', 'male', 'zh', '豆包语音 moon'),
  voice('zh_female_wenrouxiaoya_moon_bigtts', '温柔小雅', 'female', 'zh', '豆包语音 moon'),
  voice('zh_male_yuanboxiaoshu_moon_bigtts', '渊博小叔', 'male', 'zh', '豆包语音 moon'),
]

export function inferGender(id: string, name: string): VoiceGender {
  const text = `${id} ${name}`.toLowerCase()
  if (/child|boy|girl|童|kid/.test(text)) return 'child'
  if (/female|woman|girl|女|shaonv|yujie|xiaoling|xiaohe|xiaoyuan|xiaoya/.test(text)) return 'female'
  if (/male|man|男|qingse|jingying|badao|nanyou|ahu|zixin/.test(text)) return 'male'
  return 'neutral'
}
