import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('video prompt batch service runs per-shot async agent loop', () => {
  const svc = read('src/services/video-prompts.ts')

  // 默认只处理缺少 video_prompt 的分镜；指定 storyboardIds 时只处理所选（已有提示词也重新生成）
  assert.match(svc, /filter\(sb => !\(sb\.videoPrompt \|\| ''\)\.trim\(\)\)/)
  assert.match(svc, /storyboardIds\?\.length/)
  assert.match(svc, /storyboardIds\.includes\(sb\.id\)/)
  // 落库任务表；运行中不重复启动
  assert.match(svc, /kind: 'video_prompts'/)
  assert.match(svc, /if \(!started\) return \{ started: false, total: -1 \}/)
  // 逐个分镜调用 prompt_generator（精简上下文 + 只写 video_prompt），以落库结果判定成败
  assert.match(svc, /runAgent\('prompt_generator'/)
  assert.match(svc, /read_storyboard_detail/)
  assert.match(svc, /save_video_prompt/)
  assert.match(svc, /fresh\?\.videoPrompt/)
  // 有限并发 + 进度跟踪
  assert.match(svc, /VIDEO_PROMPT_CONCURRENCY/)
  assert.match(svc, /current_storyboard_id/)
})

test('episodes route exposes video prompt batch endpoints', () => {
  const route = read('src/routes/episodes.ts')

  assert.match(route, /app\.post\('\/:id\/generate-video-prompts'/)
  assert.match(route, /app\.get\('\/:id\/video-prompts-status'/)
  assert.match(route, /startVideoPromptBatch\(ep\.id, ep\.dramaId/)
  assert.match(route, /body\.storyboard_ids/)
  assert.match(route, /already_running/)
})
