export function joinProviderUrl(baseUrl: string, requiredPrefix: string, path: string) {
  const normalizedBase = (baseUrl || '').replace(/\/+$/, '')
  const normalizedPrefix = normalizeSegment(requiredPrefix)
  const normalizedPath = normalizeSegment(path)

  if (!normalizedBase) {
    return `${normalizedPrefix}${normalizedPath}`
  }

  try {
    const url = new URL(normalizedBase)
    const currentPath = url.pathname.replace(/\/+$/, '')
    const mergedPrefix = currentPath.endsWith(normalizedPrefix)
      ? currentPath
      : `${currentPath}${normalizedPrefix}`

    url.pathname = `${mergedPrefix}${normalizedPath}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    const basePath = normalizedBase.endsWith(normalizedPrefix)
      ? normalizedBase
      : `${normalizedBase}${normalizedPrefix}`
    return `${basePath}${normalizedPath}`
  }
}

/**
 * 火山方舟（Ark）端点：标准在线推理 /api/v3；订阅包用专属前缀，如 Agent Plan /api/plan/v3、Coding Plan /api/coding/v3。
 * baseUrl 已带 /api/<套餐>/v3 时原样使用，否则补 /api/v3（订阅包走专属前缀才会消耗套餐额度）。
 */
const ARK_PREFIX_RE = /\/api(\/[A-Za-z0-9_-]+)?\/v3$/

// 用户常把完整接口地址（…/api/plan/v3/images/generations）直接粘进 Base URL，这里先剥掉接口路径
const ARK_ENDPOINT_TAIL_RE = /\/(images\/generations|contents\/generations\/tasks|chat\/completions)(\/[^/]*)?\/*$/

export function joinArkUrl(baseUrl: string, path: string) {
  const base = (baseUrl || '').replace(/\/+$/, '').replace(ARK_ENDPOINT_TAIL_RE, '')
  let pathname = ''
  try { pathname = new URL(base).pathname.replace(/\/+$/, '') } catch {}
  const prefix = ARK_PREFIX_RE.exec(pathname)?.[0] || '/api/v3'
  return joinProviderUrl(base, prefix, path)
}

function normalizeSegment(segment: string) {
  if (!segment) return ''
  return segment.startsWith('/') ? segment : `/${segment}`
}
