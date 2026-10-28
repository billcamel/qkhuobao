/**
 * 把角色定妆图和一段音色合成可播放的 mp4。
 * 视频模型不收纯音频作为角色声音参考：Seedance / MiniMax / Wan 都把参考视频
 * （video_url role=reference_video，或 Wan 的 media.type=reference_video）当作携带声音的素材。
 * 这段短片每帧都是定妆图，音轨是所选音色，后续镜头直接把它放进 reference_video。
 */
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import { ffmpeg, checkFfmpegSuite } from '../../utils/ffmpeg.js'
import { DATA_ROOT, STORAGE_ROOT } from '../../utils/paths.js'
import { downloadFile, getAbsolutePath } from '../../utils/storage.js'

export const SPEAKING_CLIP_DIR = 'voice-clips'

export function speakingClipFilter() {
  // yuv420p 要求宽高为偶数
  return 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
}

export async function renderSpeakingClip(imageRef: string, audioRelativePath: string): Promise<string> {
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg) throw new Error('本机 ffmpeg 不可用，无法生成说话视频')

  const imageAbs = await resolveImageFile(imageRef)
  const audioAbs = getAbsolutePath(audioRelativePath)
  if (!fs.existsSync(audioAbs)) throw new Error('试听音频没有写到本地')

  const dir = path.join(STORAGE_ROOT, SPEAKING_CLIP_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${uuid()}.mp4`
  const output = path.join(dir, filename)

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(imageAbs)
      .inputOptions(['-loop', '1'])
      .input(audioAbs)
      .videoFilters(speakingClipFilter())
      .outputOptions([
        '-c:v', 'libx264',
        '-tune', 'stillimage',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
      ])
      .output(output)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run()
  })

  if (!fs.existsSync(output) || fs.statSync(output).size < 128) {
    throw new Error('说话视频生成失败')
  }
  return `static/${SPEAKING_CLIP_DIR}/${filename}`
}

async function resolveImageFile(raw: string): Promise<string> {
  const value = String(raw || '').trim()
  if (!value) throw new Error('请先生成角色形象，再生成说话视频')
  if (path.isAbsolute(value) && fs.existsSync(value)) return value
  if (/^https?:\/\//i.test(value)) {
    const saved = await downloadFile(value, 'temp')
    return path.join(DATA_ROOT, saved)
  }
  const relative = value.replace(/^\//, '')
  const abs = getAbsolutePath(relative)
  if (!fs.existsSync(abs)) throw new Error('角色形象文件不存在，请重新生成形象')
  return abs
}
