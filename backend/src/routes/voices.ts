import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { listAvailableVoices } from '../services/voice/service.js'

const app = new Hono()

// GET /voices — 已启用的语音合成配置及其音色（实时列表失败时回退内置目录）
app.get('/', async (c) => {
  try {
    return success(c, await listAvailableVoices())
  } catch (err: any) {
    return badRequest(c, err?.message || '读取音色失败')
  }
})

export default app
