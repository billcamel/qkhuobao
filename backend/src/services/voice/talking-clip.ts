/**
 * 角色口型试听：把定妆图和已保存的参考音频交给当前视频模型。
 *
 * - Seedance：reference_image + reference_audio（role=reference_audio），有参考音频时必须同时有图或视频
 * - MiniMax H3：首帧定妆图 + audio_url，提示词必填
 * - Wan 3.0：reference_image + reference_audio，不能和 first_frame 混用
 *
 * 参考音频是本地 static 文件，提交时走现有 PUBLIC_BASE_URL 解析。
 * 生成出的 mp4 只在资产页试听。镜头生成另用同一条本地参考音频作为 reference_audio，不把这段视频当声音参考。
 */
export const TALKING_CLIP_SECONDS = 5

/** 试听片段跟随项目画幅：短剧基本是竖屏，兜底 9:16 而不是 16:9 */
const DEFAULT_TALKING_CLIP_ASPECT = '9:16'

function normalizeAspect(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  return /^\d{1,2}:\d{1,2}$/.test(raw) ? raw : DEFAULT_TALKING_CLIP_ASPECT
}

export function talkingClipPrompt(name: string, line: string) {
  const who = name.trim() || '角色'
  return `${who}正面半身面对镜头自然说话，口型与参考音频一致，只说这一句：「${line}」。固定机位，不要切镜，不要字幕，不要其他人物。`
}

export interface TalkingClipRequest {
  prompt: string
  referenceImageUrls?: string[]
  referenceAudioUrls: string[]
  imageUrl?: string
  firstFrameUrl?: string
  duration: number
  aspectRatio: string
  generateAudio: boolean
  referenceMode: 'reference'
  purpose: 'voice_clip'
}

export function talkingClipRequest(
  provider: string,
  imageUrl: string,
  audioUrl: string | null | undefined,
  prompt: string,
  aspectRatio?: string | null,
): TalkingClipRequest {
  // 有参考音频就用它锁音色；没有就交给视频模型按提示词自己出声，不阻塞
  const audios = audioUrl ? [audioUrl] : []
  const base: TalkingClipRequest = {
    prompt,
    referenceAudioUrls: audios,
    duration: TALKING_CLIP_SECONDS,
    aspectRatio: normalizeAspect(aspectRatio),
    generateAudio: true,
    referenceMode: 'reference',
    purpose: 'voice_clip',
  }
  if (provider.toLowerCase() === 'minimax') {
    return { ...base, imageUrl, firstFrameUrl: imageUrl }
  }
  return { ...base, referenceImageUrls: [imageUrl] }
}
