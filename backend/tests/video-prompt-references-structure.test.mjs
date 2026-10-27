import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('prompt_generator video prompt format uses @name references instead of XML tags', () => {
  const skill = read('workspace/skills/prompt-generator/video-prompt/SKILL.md')
  const skills = read('src/agents/skills.ts')
  const breaker = read('workspace/prompts/storyboard_breaker.md')
  const generator = read('workspace/prompts/prompt_generator.md')

  // video_prompt 规范只在 video-prompt 技能中维护：@名字 引用 + 替换为参考图标记
  assert.match(skill, /@场景名/)
  assert.match(skill, /@角色名/)
  assert.match(skill, /@小明.*@图片1小明/)
  assert.doesNotMatch(skill, /<location>/)
  assert.doesNotMatch(skill, /<role>/)

  // 故事板设计不再写 video_prompt（由故事板推导），提示词 Agent 引用技能、不复制规则
  assert.match(skills, /storyboard_breaker: \['storyboard-breaker'\]/)
  assert.match(breaker, /不要写 video_prompt 和 description/)
  assert.match(generator, /video-prompt 技能/)
  for (const prompt of [breaker, generator]) assert.doesNotMatch(prompt, /按 3 秒为一段/)
  // 有故事板时按镜的真实起止时间分段
  assert.match(skill, /有故事板时/)
})
