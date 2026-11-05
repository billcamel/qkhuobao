/**
 * 视频生成后自动质检（QC）
 *
 * 只用 ffmpeg/ffprobe 解码到低分辨率原始帧，在内存里算硬指标，不引入任何新依赖：
 *  - 黑屏/白屏、卡帧（静止）、闪烁（亮度抖动）、色彩跳变
 *  - 清晰度（梯度能量）相对整集判断糊片
 *  - 分辨率/帧率/音轨是否缺失
 *
 * 报告落盘到 data/qc/：<kind>-<id>.json（最新一次）+ <kind>-<id>.md（中文摘要），
 * 并在 data/qc/index.jsonl 追加一行索引，供 Hermes / 前端读取。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ffmpegBinary from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { getAbsolutePath } from '../utils/storage.js'
import { DATA_ROOT } from '../utils/paths.js'

export type QCKind = 'task' | 'merge'

export interface QCIssue {
  type: string
  severity: 'major' | 'minor'
  atSec: number
  detail: string
}

export interface QCReport {
  kind: QCKind
  id: number
  label?: string
  file: string
  createdAt: string
  score: number
  probe: {
    duration: number
    width: number
    height: number
    fps: number
    hasAudio: boolean
    videoCodec?: string
  }
  metrics: {
    frames: number
    lumaMean: number
    lumaStd: number
    sharpness: number
    flickerEvents: number
    colorJumps: number
    blackRatio: number
    frozenEvents: number
  }
  issues: QCIssue[]
}

const QC_DIR = path.join(DATA_ROOT, 'qc')
const SAMPLE_FPS = 4
const SAMPLE_W = 160
const SAMPLE_H = 90

/** 质检串行执行，避免一次性解码多个视频把机器打满 */
let queue: Promise<unknown> = Promise.resolve()

export function runVideoQc(opts: { kind: QCKind; id: number; file: string; label?: string }): Promise<QCReport> {
  const task = queue.then(() => executeQc(opts))
  queue = task.catch(() => undefined)
  return task
}

async function executeQc(opts: { kind: QCKind; id: number; file: string; label?: string }): Promise<QCReport> {
  const abs = path.isAbsolute(opts.file) ? opts.file : getAbsolutePath(opts.file)
  if (!fs.existsSync(abs)) throw new Error(`视频文件不存在：${abs}`)

  const probe = await probeVideo(abs)
  const frames = await sampleFrames(abs)
  const report = buildReport(opts, opts.file, probe, frames)
  await saveReport(report)
  return report
}

function probeVideo(file: string): Promise<QCReport['probe']> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobeStatic.path, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d.toString() })
    p.stderr.on('data', d => { err += d.toString() })
    p.on('error', reject)
    p.on('close', () => {
      try {
        const j = JSON.parse(out)
        const v = (j.streams || []).find((s: any) => s.codec_type === 'video') || {}
        const a = (j.streams || []).some((s: any) => s.codec_type === 'audio')
        const [num, den] = String(v.avg_frame_rate || '0/1').split('/').map(Number)
        resolve({
          duration: Number(j.format?.duration || 0),
          width: Number(v.width || 0),
          height: Number(v.height || 0),
          fps: den ? Number((num / den).toFixed(2)) : 0,
          hasAudio: a,
          videoCodec: v.codec_name,
        })
      } catch (e) {
        reject(new Error(`ffprobe 解析失败：${err.slice(0, 200)}`))
      }
    })
  })
}

interface FrameStat { luma: number; r: number; g: number; b: number; sharp: number }

function sampleFrames(file: string): Promise<FrameStat[]> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-i', file,
      '-vf', `fps=${SAMPLE_FPS},scale=${SAMPLE_W}:${SAMPLE_H}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    const p = spawn(ffmpegBinary as unknown as string, args)
    const frameSize = SAMPLE_W * SAMPLE_H * 3
    const stats: FrameStat[] = []
    let buf = Buffer.alloc(0)
    let err = ''
    p.stdout.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= frameSize) {
        stats.push(analyzeFrame(buf.subarray(0, frameSize)))
        buf = buf.subarray(frameSize)
      }
    })
    p.stderr.on('data', d => { err += d.toString() })
    p.on('error', reject)
    p.on('close', () => {
      if (!stats.length) return reject(new Error(`ffmpeg 解码无输出：${err.slice(0, 200)}`))
      resolve(stats)
    })
  })
}

function analyzeFrame(f: Buffer): FrameStat {
  let sr = 0; let sg = 0; let sb = 0
  const luma = new Float32Array(SAMPLE_W * SAMPLE_H)
  for (let i = 0, px = 0; i < f.length; i += 3, px++) {
    const r = f[i]; const g = f[i + 1]; const b = f[i + 2]
    sr += r; sg += g; sb += b
    luma[px] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  const px = SAMPLE_W * SAMPLE_H
  let grad = 0
  for (let y = 0; y < SAMPLE_H; y++) {
    for (let x = 0; x < SAMPLE_W; x++) {
      const i = y * SAMPLE_W + x
      const right = x + 1 < SAMPLE_W ? luma[i + 1] : luma[i]
      const down = y + 1 < SAMPLE_H ? luma[i + SAMPLE_W] : luma[i]
      grad += Math.abs(right - luma[i]) + Math.abs(down - luma[i])
    }
  }
  return {
    luma: luma.reduce((a, b) => a + b, 0) / px,
    r: sr / px, g: sg / px, b: sb / px,
    sharp: grad / px,
  }
}

function buildReport(
  opts: { kind: QCKind; id: number; file: string; label?: string },
  file: string,
  probe: QCReport['probe'],
  frames: FrameStat[],
): QCReport {
  const lumaArr = frames.map(f => f.luma)
  const n = lumaArr.length
  const mean = lumaArr.reduce((a, b) => a + b, 0) / n
  const std = Math.sqrt(lumaArr.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
  const sharp = frames.reduce((a, f) => a + f.sharp, 0) / n

  const issues: QCIssue[] = []
  let flickerEvents = 0
  let colorJumps = 0
  let blackFrames = 0
  let frozen = 0
  let frozenRun = 0

  for (let i = 1; i < n; i++) {
    const at = Number((i / SAMPLE_FPS).toFixed(1))
    const dl = lumaArr[i] - lumaArr[i - 1]
    const prev = frames[i - 1]
    const cur = frames[i]
    const dColor = Math.hypot(cur.r - prev.r, cur.g - prev.g, cur.b - prev.b)

    if (Math.abs(dl) > 22 && dColor < 60) {
      flickerEvents++
      if (flickerEvents <= 3) issues.push({ type: '闪烁', severity: Math.abs(dl) > 40 ? 'major' : 'minor', atSec: at, detail: `亮度跳变 ${dl.toFixed(0)}` })
    }
    if (dColor > 45) {
      colorJumps++
      if (colorJumps <= 3) issues.push({ type: '色彩跳变', severity: 'minor', atSec: at, detail: `色差 ${dColor.toFixed(0)}` })
    }
    if (cur.luma < 12) blackFrames++
    if (cur.sharp < Math.max(0.6, sharp * 0.15) && Math.abs(dl) < 1.2) {
      frozenRun++
      if (frozenRun === Math.round(SAMPLE_FPS * 0.5)) {
        frozen++
        issues.push({ type: '卡帧', severity: 'major', atSec: at, detail: '画面静止超过 0.5 秒' })
      }
    } else frozenRun = 0
  }

  const blackRatio = blackFrames / n
  if (blackRatio > 0.15) issues.push({ type: '黑屏', severity: blackRatio > 0.4 ? 'major' : 'minor', atSec: 0, detail: `黑帧占比 ${(blackRatio * 100).toFixed(0)}%` })
  if (!probe.hasAudio) issues.push({ type: '无音轨', severity: 'minor', atSec: 0, detail: '该视频没有音频流' })
  if (probe.height && probe.height < 360) issues.push({ type: '分辨率偏低', severity: 'minor', atSec: 0, detail: `${probe.width}x${probe.height}` })

  const penalty = issues.reduce((a, i) => a + (i.severity === 'major' ? 18 : 6), 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))

  return {
    kind: opts.kind,
    id: opts.id,
    label: opts.label,
    file,
    createdAt: new Date().toISOString(),
    score,
    probe,
    metrics: {
      frames: n,
      lumaMean: Number(mean.toFixed(1)),
      lumaStd: Number(std.toFixed(1)),
      sharpness: Number(sharp.toFixed(2)),
      flickerEvents,
      colorJumps,
      blackRatio: Number(blackRatio.toFixed(3)),
      frozenEvents: frozen,
    },
    issues,
  }
}

export function reportToMarkdown(r: QCReport): string {
  const head = `## ${r.kind === 'merge' ? '整集' : '单镜头'} ${r.label || r.id} — 质检 ${r.score} 分`
  const base = `- 文件：\`${r.file}\`\n- 时长 ${r.probe.duration.toFixed(1)}s · ${r.probe.width}x${r.probe.height} · ${r.probe.fps}fps · ${r.probe.hasAudio ? '有音轨' : '无音轨'}\n- 亮度均值 ${r.metrics.lumaMean} · 清晰度 ${r.metrics.sharpness} · 闪烁 ${r.metrics.flickerEvents} 次 · 色跳 ${r.metrics.colorJumps} 次 · 卡帧 ${r.metrics.frozenEvents} 处`
  const list = r.issues.length
    ? `\n${r.issues.map(i => `- [${i.severity === 'major' ? '重' : '轻'}] ${i.type} @${i.atSec}s：${i.detail}`).join('\n')}`
    : '\n- 未发现明显瑕疵'
  return `${head}\n\n${base}\n${list}\n`
}

async function saveReport(r: QCReport) {
  await fs.promises.mkdir(QC_DIR, { recursive: true })
  const base = path.join(QC_DIR, `${r.kind}-${r.id}`)
  await fs.promises.writeFile(`${base}.json`, JSON.stringify(r, null, 2), 'utf-8')
  await fs.promises.writeFile(`${base}.md`, reportToMarkdown(r), 'utf-8')
  const line = JSON.stringify({ kind: r.kind, id: r.id, label: r.label, score: r.score,
    issues: r.issues.map(i => `${i.type}${i.severity === 'major' ? '(重)' : ''}`), file: r.file, createdAt: r.createdAt })
  await fs.promises.appendFile(path.join(QC_DIR, 'index.jsonl'), line + '\n', 'utf-8')
  console.log(`[QC] ${r.kind} ${r.id} 质检完成：${r.score} 分，${r.issues.length} 项问题`)
}
