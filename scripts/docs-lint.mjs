#!/usr/bin/env node
// Claim lint for the Mim manual.
// Validates that factual references in manual pages are correct:
//   (a) backticked tool names exist in the tool registry
//   (b) <kbd> combos match a shortcut from the shortcuts source
//   (c) "Settings > X" references match a settings section
//   (d) internal link targets resolve to existing manual page ids
//   (e) TODO(verify) occurrences are reported as warnings
//
// Exits 0 if only warnings; exits 1 if any errors found.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, resolve, join, sep } from 'path'
import { fileURLToPath } from 'url'
import { loadToolList, loadGateModule } from './docs-gen/toolCatalog.mjs'
import { parseShortcutsFromVue, extractAllKbdCombos } from './docs-gen/shortcuts.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Load all registered tool names from the headless kernel plus
 * workspace-only tools from gate.ts policies, which are registered only after
 * a Project opens.
 */
export function loadToolNames() {
  const names = new Set()
  try {
    const tools = loadToolList()
    for (const t of tools) names.add(t.name)
  } catch {
    console.warn('docs-lint: could not load tool registry (is the project built?)')
  }
  // Supplement with tools from gate.ts TOOL_POLICIES — these include
  // workspace-only tools that are not in the headless registry.
  try {
    const gate = loadGateModule()
    // gate.getToolPolicy returns a fallback for unknown tools, so we cannot
    // enumerate from it. Instead, re-parse the gate source directly.
    const gatePath = resolve(ROOT, 'src/main/security/gate.ts')
    const source = readFileSync(gatePath, 'utf-8')
    const policyRegex = /'([a-zA-Z][a-zA-Z0-9.]+)':\s*\{\s*category:/g
    let m
    while ((m = policyRegex.exec(source)) !== null) {
      names.add(m[1])
    }
  } catch {
    // gate.ts parsing is supplementary; proceed with what we have
  }
  return names
}

/**
 * Load valid kbd combos from ShortcutsDialog.vue.
 */
export function loadKbdCombos() {
  const vuePath = resolve(ROOT, 'src/renderer/components/ShortcutsDialog.vue')
  const source = readFileSync(vuePath, 'utf-8')
  const sections = parseShortcutsFromVue(source)
  return extractAllKbdCombos(sections)
}

/**
 * Load settings section ids and labels from sections.ts.
 */
export function loadSettingsSections() {
  const sectionsPath = resolve(ROOT, 'src/renderer/components/settings/sections.ts')
  const source = readFileSync(sectionsPath, 'utf-8')

  // Extract labels from the SETTINGS_NAV_GROUPS definition.
  const labels = new Map()
  const labelRegex = /id:\s*'([^']+)',\s*label:\s*'([^']+)'/g
  let m
  while ((m = labelRegex.exec(source)) !== null) {
    labels.set(m[2], m[1]) // label -> id
    labels.set(m[2].toLowerCase(), m[1]) // lowercase too
  }
  return labels
}

/**
 * Collect all manual page ids from frontmatter.
 */
export function collectPageIds() {
  const ids = new Set()
  const dirs = ['manual', 'manual/develop']

  for (const dir of dirs) {
    const fullDir = resolve(ROOT, dir)
    if (!existsSync(fullDir)) continue
    const files = readdirSync(fullDir).filter(f => f.endsWith('.md') && !f.startsWith('_'))
    for (const file of files) {
      const content = readFileSync(join(fullDir, file), 'utf-8')
      const idMatch = content.match(/^id:\s*(.+)$/m)
      if (idMatch) ids.add(idMatch[1].trim())
    }
  }

  return ids
}

/**
 * Normalize a kbd combo to canonical macOS modifier order:
 * Ctrl, Option, Shift, Cmd, then the base key.
 */
export function normalizeKbdCombo(combo) {
  const parts = combo.split('+')
  const modOrder = ['Ctrl', 'Option', 'Shift', 'Cmd']
  const mods = parts.filter(p => modOrder.includes(p))
  const rest = parts.filter(p => !modOrder.includes(p))
  return [
    ...modOrder.filter(m => mods.includes(m)),
    ...rest,
  ].join('+')
}

/**
 * Lint a single markdown file. Returns { errors: [], warnings: [] }.
 * appToolNames is an optional Set of app-provided tool names to accept.
 */
export function lintFile(filePath, toolNames, kbdCombos, settingsLabels, pageIds, appToolNames = new Set()) {
  const content = readFileSync(filePath, 'utf-8')
  const errors = []
  const warnings = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip frontmatter
    if (i === 0 && line.trim() === '---') {
      const endIdx = content.indexOf('\n---', 4)
      if (endIdx > 0) {
        const fmLines = content.slice(0, endIdx).split('\n').length
        i = fmLines // skip to end of frontmatter
        continue
      }
    }

    // (a) Backticked tool names: look for `word.word` patterns.
    // Manual chapters only — develop pages legitimately use dotted
    // non-tool identifiers (SDK surfaces, settings keys, code symbols).
    const toolRegex = /`([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.]*)`/g
    let tm
    while (!filePath.includes(`manual${sep}develop`) && (tm = toolRegex.exec(line)) !== null) {
      const toolName = tm[1]
      // Skip things that are clearly not tool names
      if (toolName.includes('/')) continue
      if (toolName.match(/\.(md|ts|tsx|js|vue|json|yaml|yml|mjs|css|html|mim|env|exe|com|org|net|io|rs|sh|bat|cmd|txt|csv|pdf|docx|xlsx|bib|bak|lock|toml|cfg|ini|log|xml|svg|png|jpg|gif|wasm|rb|py|r|R|rmd|qmd)$/i)) continue
      if (toolName.match(/^(e\.g|i\.e|etc|vs|a\.k\.a)\b/i)) continue
      // Skip version numbers like 0.1.5
      if (toolName.match(/^\d/)) continue

      if (toolNames.size > 0 && !toolNames.has(toolName) && !appToolNames.has(toolName)) {
        errors.push({ line: lineNum, message: `unknown tool name: \`${toolName}\`` })
      }
    }

    // (b) <kbd> combos
    const kbdRegex = /<kbd>([^<]+)<\/kbd>/g
    let km
    while ((km = kbdRegex.exec(line)) !== null) {
      const combo = km[1]
      if (kbdCombos.size > 0 && !kbdCombos.has(combo)) {
        // Allow single keys (no + separator)
        const isSingleKey = !combo.includes('+')
        if (isSingleKey) continue
        // Normalize modifier order before comparing (macOS canonical order:
        // Ctrl, Option, Shift, Cmd, then the base key)
        const normalized = normalizeKbdCombo(combo)
        if (!kbdCombos.has(normalized)) {
          errors.push({ line: lineNum, message: `unknown shortcut: <kbd>${combo}</kbd>` })
        }
      }
    }

    // (c) "Settings > X" references
    // Match "Settings > Label" where label is 1-3 capitalized words possibly
    // joined by & (e.g. "AI & Models"). Stop at lowercase words.
    const settingsRegex = /Settings\s*>\s*([A-Z][a-zA-Z]*(?:\s*&\s*[a-zA-Z]+)*)/g
    let sm
    while ((sm = settingsRegex.exec(line)) !== null) {
      const section = sm[1].trim()
      if (!settingsLabels.has(section) && !settingsLabels.has(section.toLowerCase())) {
        errors.push({ line: lineNum, message: `unknown settings section: Settings > ${section}` })
      }
    }

    // (d) Internal link targets
    // Match markdown links: [text](target) where target is relative
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g
    let lm
    while ((lm = linkRegex.exec(line)) !== null) {
      const target = lm[2]
      // Skip external links
      if (target.startsWith('http') || target.startsWith('mailto:')) continue
      // Skip anchors
      if (target.startsWith('#')) continue
      // Skip file paths (contain . extension)
      if (target.match(/\.[a-zA-Z]+$/)) continue

      // Relative page id references like (running-code) or (/develop/tools)
      const cleanTarget = target.replace(/^\/develop\//, '').replace(/^\//, '')
      if (cleanTarget && pageIds.size > 0 && !pageIds.has(cleanTarget)) {
        errors.push({ line: lineNum, message: `unresolved link target: (${target})` })
      }
    }

    // (e) TODO(verify) warnings
    const todoRegex = /TODO\(verify/g
    let tdm
    while ((tdm = todoRegex.exec(line)) !== null) {
      warnings.push({ line: lineNum, message: `TODO(verify) found` })
    }
  }

  return { errors, warnings }
}

/**
 * Collect all markdown files to lint.
 */
export function collectManualFiles() {
  const files = []
  const dirs = ['manual', 'manual/develop']

  for (const dir of dirs) {
    const fullDir = resolve(ROOT, dir)
    if (!existsSync(fullDir)) continue
    const entries = readdirSync(fullDir).filter(f => f.endsWith('.md') && !f.startsWith('_'))
    for (const f of entries) {
      files.push(join(fullDir, f))
    }
  }

  return files
}

/**
 * Main lint entry point.
 */
export function runLint() {
  const toolNames = loadToolNames()
  const appToolNames = new Set()
  const kbdCombos = loadKbdCombos()
  const settingsLabels = loadSettingsSections()
  const pageIds = collectPageIds()
  const files = collectManualFiles()

  let totalErrors = 0
  let totalWarnings = 0

  for (const file of files) {
    const relPath = file.replace(ROOT + '/', '')
    const { errors, warnings } = lintFile(file, toolNames, kbdCombos, settingsLabels, pageIds, appToolNames)

    for (const e of errors) {
      console.error(`ERROR ${relPath}:${e.line} — ${e.message}`)
      totalErrors++
    }
    for (const w of warnings) {
      console.warn(`WARN  ${relPath}:${w.line} — ${w.message}`)
      totalWarnings++
    }
  }

  console.log('')
  console.log(`docs-lint: ${files.length} files, ${totalErrors} errors, ${totalWarnings} warnings`)

  return { totalErrors, totalWarnings, fileCount: files.length }
}

// CLI entry
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { totalErrors } = runLint()
  process.exit(totalErrors > 0 ? 1 : 0)
}
