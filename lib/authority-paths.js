/** Resolve only host-owned anchors; caller-selected descendants retain native no-follow checks. */
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

export function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function canonicalAnchor(root) {
  try { return fs.realpathSync.native(root) } catch { return path.resolve(root) }
}

/** Never realpath a model-selected parent or leaf, even if it already exists. */
export function anchoredPath(target, anchors) {
  const anchor = anchors.filter(root => inside(root, target)).sort((a, b) => b.length - a.length)[0]
  return anchor ? path.join(canonicalAnchor(anchor), path.relative(anchor, target)) : target
}

export function sessionAnchors(policy, cwd) {
  return [policy.workspaceRoot, ...(cwd ? [cwd] : []), tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]
}
