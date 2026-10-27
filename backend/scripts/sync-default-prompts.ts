/**
 * 由 workspace/prompts/<type>.md（中文基础版）生成 src/agents/default-prompts.generated.ts
 * DEFAULT_PROMPTS 仅作 prompt 文件缺失（如设置页「恢复默认」删除文件）时的兜底，
 * 内容必须与 prompt 文件一致——修改 prompt 文件后运行：npm run sync-prompts
 * 加 --check 只校验不写入（不一致时退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePromptFile } from '../src/agents/prompts.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENT_TYPES = ['script_rewriter', 'extractor', 'storyboard_breaker', 'prompt_generator']
const outFile = path.join(root, 'src/agents/default-prompts.generated.ts')

const entries = AGENT_TYPES.map((type) => {
  const raw = fs.readFileSync(path.join(root, 'workspace/prompts', `${type}.md`), 'utf8')
  const { name, instructions } = parsePromptFile(raw)
  return `  ${type}: {\n    name: ${JSON.stringify(name)},\n    instructions: ${JSON.stringify(instructions)},\n  },`
})

const content = `// 自动生成，勿手改：由 scripts/sync-default-prompts.ts 从 workspace/prompts/<type>.md 生成
export const GENERATED_DEFAULT_PROMPTS: Record<string, { name: string; instructions: string }> = {
${entries.join('\n')}
}
`

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  if (current !== content) {
    console.error('default-prompts.generated.ts 与 workspace/prompts 不一致，请运行 npm run sync-prompts')
    process.exit(1)
  }
  console.log('default prompts in sync')
} else {
  fs.writeFileSync(outFile, content)
  console.log(`wrote ${path.relative(root, outFile)}`)
}
