import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { listLocalReferenceAudios } from '../services/voice/service.js'

const app = new Hono()

// GET /voices — 服务器上已有的参考音频，供角色直接选用
app.get('/', async (c) => {
  try {
    return success(c, await listLocalReferenceAudios())
  } catch (err: any) {
    return badRequest(c, err?.message || '读取参考音频失败')
  }
})

export default app
