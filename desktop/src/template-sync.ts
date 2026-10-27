/**
 * workspace 模板同步（纯 fs，便于单测）
 *
 * - 目标无版本标记（首启动）或版本较旧 → 补缺失文件
 * - prompts/ 随版本升级强制覆盖（与代码内 DEFAULT_PROMPTS 同源迭代，设置页可「恢复默认」）
 * - skills/ 默认不覆盖用户编辑；但若用户目录中的文件与「某个曾经发布过的版本」字节一致
 *   （即用户从未改过），则升级为当前版本——否则技能修正永远到不了老用户
 *   发布过的版本哈希由 prepare-resources 从 git 历史生成到 SHIPPED_HASHES_FILE
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const SHIPPED_HASHES_FILE = '.shipped-hashes.json'
const MARKER_FILE = '.template-version'

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function readShippedHashes(templateDir: string): Record<string, string[]> {
  try {
    const raw = fs.readFileSync(path.join(templateDir, SHIPPED_HASHES_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 把用户未改动过的技能文件升级为模板当前版本；返回被升级的相对路径 */
export function upgradeUnmodifiedSkills(templateDir: string, destDir: string): string[] {
  const shipped = readShippedHashes(templateDir)
  const upgraded: string[] = []
  for (const rel of listFiles(path.join(templateDir, 'skills')).map(f => `skills/${f}`)) {
    const dest = path.join(destDir, rel)
    if (!fs.existsSync(dest)) continue
    const current = fs.readFileSync(path.join(templateDir, rel))
    const existingHash = sha256(fs.readFileSync(dest))
    if (existingHash === sha256(current)) continue
    if (!(shipped[rel] || []).includes(existingHash)) continue // 用户改过：保留
    fs.writeFileSync(dest, current)
    upgraded.push(rel)
  }
  return upgraded
}

export function syncWorkspaceTemplate(templateDir: string, destDir: string, version: string): string[] {
  const marker = path.join(destDir, MARKER_FILE)
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === version) return []
  const notMeta = (src: string) => path.basename(src) !== SHIPPED_HASHES_FILE
  fs.cpSync(templateDir, destDir, { recursive: true, force: false, errorOnExist: false, filter: notMeta })
  fs.cpSync(path.join(templateDir, 'prompts'), path.join(destDir, 'prompts'), { recursive: true, force: true })
  const upgraded = upgradeUnmodifiedSkills(templateDir, destDir)
  fs.writeFileSync(marker, version)
  return upgraded
}
