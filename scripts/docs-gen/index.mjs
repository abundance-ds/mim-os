#!/usr/bin/env node
// docs-gen orchestrator.
// Runs all documentation generators in sequence and reports results.
// Requires `npm run build` first (the tool catalog generator uses the
// built headless kernel).

import { generateToolCatalog } from './toolCatalog.mjs'
import { generateShortcuts } from './shortcuts.mjs'
import { generateModels } from './models.mjs'

async function main() {
  const results = []
  let exitCode = 0

  // 1. Shortcuts (no build dependency — reads .vue source directly)
  try {
    const r = generateShortcuts()
    results.push({ name: 'shortcuts', ...r })
    console.log(`  shortcuts: ${r.sectionCount} sections, ${r.shortcutCount} shortcuts -> ${r.path}`)
  } catch (err) {
    console.error(`  shortcuts: FAILED — ${err.message}`)
    exitCode = 1
  }

  // 2. Models (reads resources/ai-models.json directly)
  try {
    const r = generateModels()
    results.push({ name: 'models', ...r })
    console.log(`  models: ${r.modelCount} models -> ${r.path}`)
  } catch (err) {
    console.error(`  models: FAILED — ${err.message}`)
    exitCode = 1
  }

  // 3. Tool catalog (requires built headless kernel)
  try {
    const r = generateToolCatalog()
    results.push({ name: 'tools', ...r })
    console.log(`  tools: ${r.toolCount} tools -> ${r.path}`)
  } catch (err) {
    console.error(`  tools: FAILED — ${err.message}`)
    console.error('    Ensure `npm run build` has been run first.')
    exitCode = 1
  }

  console.log('')
  if (exitCode === 0) {
    console.log('docs-gen: all generators completed.')
  } else {
    console.log('docs-gen: some generators failed.')
  }

  process.exit(exitCode)
}

main()
