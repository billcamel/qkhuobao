import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { apiKeyProblem, isOfficialProvider, parseConfigAppId, parseConfigTemperature } from '../services/ai.js'
import { volcengineResourceId } from '../services/voice/adapters.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写 */
function withParsedFields(r: any) {
  return {
    ...toSnakeCase(r),
    model: r.model ? JSON.parse(r.model) : [],
    temperature: parseConfigTemperature(r.settings),
    app_id: parseConfigAppId(r.settings),
  }
}

/** 把 temperature / app_id 合并进 settings JSON。两者都没传时返回 undefined，表示不改 settings。 */
function mergeSettings(existingRaw: string | null | undefined, body: any): string | null | undefined {
  if (!('temperature' in body) && !('app_id' in body)) return undefined
  let settings: Record<string, any> = {}
  try { settings = existingRaw ? JSON.parse(existingRaw) : {} } catch { settings = {} }
  if ('temperature' in body) {
    const temperature = normalizeTemperature(body.temperature)
    if (temperature === null) delete settings.temperature
    else settings.temperature = temperature
  }
  if ('app_id' in body) {
    const appId = typeof body.app_id === 'string' ? body.app_id.trim() : ''
    if (!appId) delete settings.app_id
    else if (!/^[\x21-\x7e]{1,64}$/.test(appId)) throw new Error('invalid app id')
    else settings.app_id = appId
  }
  return Object.keys(settings).length ? JSON.stringify(settings) : null
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    // 探针统一走 generateContent:文本运行时(AI SDK)走的就是它,官方与中转站都支持;
    // interactions 端点很多中转站未配置,探它会误报 500。
    // 用最小合法请求体而非空体——空体在部分中转站会触发上游认证失败的误报
    const modelName = m || 'gemini-3.1-pro-preview'
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      headers: geminiHeaders(apiKey, true),
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
    }
  }

  if (p === 'openai') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    if (serviceType === 'tts') {
      // 空请求体不会合成。新版控制台只带 X-Api-Key；资源 ID 选择模型族与计费商品。
      return {
        method: 'POST',
        url: joinProviderUrl(baseUrl, '/api/v3/tts', '/unidirectional'),
        headers: {
          ...(apiKey ? { 'X-Api-Key': apiKey } : {}),
          'X-Api-Resource-Id': volcengineResourceId(m),
          'Content-Type': 'application/json',
        },
        body: {},
      }
    }
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : serviceType === 'text'
        ? '/chat/completions'
        : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'minimax') {
    // MiniMax 仅提供视频服务，空请求体探测鉴权/端点连通性
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v2', '/video_generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'aliyun') {
    // Wan 3.0 仅支持异步提交；空请求体不会创建计费任务，仅用于验证地域端点与鉴权是否可达。
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      headers: {
        ...bearerHeaders(apiKey, true),
        'X-DashScope-Async': 'enable',
      },
      body: {},
    }
  }

  if (serviceType === 'tts' && p === 'openai') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (serviceType === 'tts' && p === 'minimax') {
    // 拉系统音色只校验鉴权，不合成、不计语音费用
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v1', '/get_voice'),
      headers: bearerHeaders(apiKey, true),
      body: { voice_type: 'system' },
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  let temperature: number | null = null
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }

  if (typeof body.api_key === 'string') body.api_key = body.api_key.trim()
  const keyProblem = apiKeyProblem(body.api_key)
  if (keyProblem) return badRequest(c, keyProblem)

  let settings: string | null = null
  try {
    const merged = mergeSettings(null, { temperature, ...('app_id' in body ? { app_id: body.app_id } : {}) })
    settings = merged ?? null
  } catch (err: any) {
    return badRequest(c, err?.message === 'invalid app id' ? 'App ID 含非法字符' : 'temperature 须为 0 到 2 之间的数字')
  }

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings,
    createdAt: ts,
    updatedAt: ts,
  })

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))

  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, '需要 service_type、provider 与 base_url')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  if (typeof body.api_key === 'string') body.api_key = body.api_key.trim()
  const keyProblem = apiKeyProblem(body.api_key)
  if (keyProblem) return badRequest(c, keyProblem)

  const model = Array.isArray(body.model) ? body.model[0] : body.model
  const probe = buildProbe(body.service_type, body.provider, body.base_url, model, body.api_key)
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    })
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
    const payload = {
      ok: resp.ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message: reachable
        ? (resp.ok ? '端点可访问，认证与路径基本正常' : '端点已响应，请根据状态码判断认证或路径是否正确')
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: text.slice(0, 240),
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const updates: Record<string, any> = { updatedAt: now() }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body) {
    const key = typeof body.api_key === 'string' ? body.api_key.trim() : body.api_key
    const keyProblem = apiKeyProblem(key)
    if (keyProblem) return badRequest(c, keyProblem)
    updates.apiKey = key
  }
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('temperature' in body || 'app_id' in body) {
    try {
      const settings = mergeSettings(existing.settings, body)
      if (settings !== undefined) updates.settings = settings
    } catch (err: any) {
      return badRequest(c, err?.message === 'invalid app id' ? 'App ID 含非法字符' : 'temperature 须为 0 到 2 之间的数字')
    }
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
