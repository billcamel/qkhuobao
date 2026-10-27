/**
 * 从 git 历史收集 workspace 技能文件每个已提交版本的 sha256
 * 返回 { 'skills/<相对路径>': [hash, ...] }；无 git 时只含当前文件哈希
 */
import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')]
  })
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })
}

export function collectShippedHashes(repo, workspaceRel, subdir) {
  const out = {}
  const workspaceDir = path.join(repo, workspaceRel)
  for (const rel of listFiles(path.join(workspaceDir, subdir)).map(f => `${subdir}/${f}`)) {
    const hashes = new Set([sha256(fs.readFileSync(path.join(workspaceDir, rel)))])
    const repoPath = `${workspaceRel}/${rel}`
    try {
      const commits = git(repo, ['log', '--format=%H', '--', repoPath]).toString().split('\n').filter(Boolean)
      for (const commit of commits) {
        try { hashes.add(sha256(git(repo, ['show', `${commit}:${repoPath}`]))) } catch { /* 该提交中文件被删除 */ }
      }
    } catch { /* 非 git 环境：只含当前版本 */ }
    out[rel] = [...hashes]
  }
  return out
}
