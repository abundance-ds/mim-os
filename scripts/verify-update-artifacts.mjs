import { access, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

function artifactName(reference) {
  const pathname = new URL(reference, 'https://updates.invalid/').pathname
  return basename(decodeURIComponent(pathname))
}

export async function verifyUpdateArtifacts(directory, manifestName) {
  const manifestPath = join(directory, manifestName)
  let manifest

  try {
    manifest = parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Missing update manifest: ${manifestName}`)
    throw error
  }

  const references = [
    ...(Array.isArray(manifest?.files) ? manifest.files.map(file => file?.url) : []),
    manifest?.path,
  ].filter(reference => typeof reference === 'string' && reference.length > 0)

  const names = [...new Set(references.map(artifactName))]
  if (names.length === 0) throw new Error(`${manifestName} does not reference any artifacts`)

  for (const name of names) {
    try {
      await access(join(directory, name))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`${manifestName} references missing artifact: ${name}`)
      }
      throw error
    }
  }

  return names
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const [directory, manifestName] = process.argv.slice(2)
  if (!directory || !manifestName) {
    console.error('Usage: node scripts/verify-update-artifacts.mjs <directory> <manifest>')
    process.exitCode = 1
  } else {
    verifyUpdateArtifacts(directory, manifestName)
      .then(names => console.log(`${manifestName}: verified ${names.join(', ')}`))
      .catch(error => {
        console.error(error.message)
        process.exitCode = 1
      })
  }
}
