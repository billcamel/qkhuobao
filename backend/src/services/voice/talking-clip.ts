/**
 * 角色口型试听：把定妆图和所选音色的一句台词交给当前视频模型。
 *
 * - Seedance：reference_image + reference_audio（role=reference_audio），有参考音频时必须同时有图或视频
 * - MiniMax H3：首帧定妆图 + audio_url，提示词必填
 * - Wan 3.0：reference_image + reference_audio，不能和 first_frame 混用
 *
 * 参考音频是本地 static 文件，提交时走现有 PUBLIC_BASE_URL 解析，和镜头参考音视频一样。
 * 生成出的 mp4 才是资产页播放、以及后续镜头 reference_video 使用的片段。
 */
export const TALKING_CLIP_SECONDS = 5

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

export function talkingClipRequest(provider: string, imageUrl: string, audioUrl: string, prompt: string): TalkingClipRequest {
  const base: TalkingClipRequest = {
    prompt,
    referenceAudioUrls: [audioUrl],
    duration: TALKING_CLIP_SECONDS,
    aspectRatio: '16:9',
    generateAudio: true,
    referenceMode: 'reference',
    purpose: 'voice_clip',
  }
  if (provider.toLowerCase() === 'minimax') {
    return { ...base, imageUrl, firstFrameUrl: imageUrl }
  }
  return { ...base, referenceImageUrls: [imageUrl] }
}
