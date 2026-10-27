import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('extraction service runs per-target async tasks', () => {
  const svc = read('src/services/extraction.ts')

  // 三类资产目标
  assert.match(svc, /'characters' \| 'scenes' \| 'props'/)
  assert.match(svc, /EXTRACT_TARGETS.*characters.*scenes.*props/s)
  assert.match(svc, /status: 'running' \| 'done' \| 'error'/)
  // 落库任务表：按 集×类型（kind=extract, target）跟踪，运行中不重复启动
  assert.match(svc, /startAgentTask\(\s*\{ kind: 'extract', agentType: 'extractor', target/)
  assert.match(svc, /latestAgentTask\(episodeId, 'extract', target\)/)
  // 每类资产限定只提取该类型
  assert.match(svc, /本次只提取角色/)
  assert.match(svc, /本次只提取场景/)
  assert.match(svc, /本次只提取道具/)
  // 以是否调用保存工具判定成败；逐步日志
  assert.match(svc, /runAgent\('extractor'/)
  assert.match(svc, /calledTools\(result\)\.includes\(SAVE_TOOL\[target\]\)/)
  assert.match(svc, /logScope: 'Extract'/)
  assert.match(read('src/services/agent-runner.ts'), /onStepFinish/)
})

test('extraction tools dedupe by normalized name so near-names reuse existing assets', () => {
  const tools = read('src/agents/tools/extract-tools.ts')

  // 归一化：括号定位/别名后缀去除 + 空白/大小写统一
  assert.match(tools, /normalizeName\(name: string\)/)
  assert.match(tools, /replace\(\/\[（\(]/) // 中/英文括号字符类
  assert.match(tools, /replace\(\/\[\\s/) // 空白字符类
  assert.match(tools, /\.toLowerCase\(\)/)
  // 角色保存：精确匹配优先，归一化近名兜底，命中即复用不重复创建
  assert.match(tools, /normalizeName\(c\.name\) === normName/)
  assert.match(tools, /matchedViaNorm/)
  assert.match(tools, /save-characters-reuse/)
  // 道具同样按归一化名字复用
  assert.match(tools, /normalizeName\(p\.name\) === normName/)
  assert.match(tools, /save-props-reuse/)
  // 场景按 地点+时间 匹配，地点仅做空白/大小写归一化（不删括号）
  assert.match(tools, /normalizeLocation\(loc: string\)/)
  assert.match(tools, /normalizeLocation\(s\.location\) === normLocation/)
  // read_existing_* 返回归一化字段供 Agent 判断复用
  assert.match(tools, /normalized_name: normalizeName/)
  assert.match(tools, /normalized_location: normalizeLocation/)
})

test('episodes route exposes async extract endpoints', () => {
  const route = read('src/routes/episodes.ts')

  assert.match(route, /app\.post\('\/:id\/extract'/)
  assert.match(route, /app\.get\('\/:id\/extract-status'/)
  assert.match(route, /target 必须是 characters \/ scenes \/ props/)
  assert.match(route, /await startExtraction\(ep\.id, ep\.dramaId, target, \{ model: body\.model/)
  // 顶栏文本模型覆盖透传到提取 Agent
  assert.match(read('src/services/agent-runner.ts'), /modelOverride: opts\.model/)
  assert.match(route, /await getExtractionStatus\(id\)/)
})
