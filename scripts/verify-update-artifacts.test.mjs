import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyUpdateArtifacts } from './verify-update-artifacts.mjs'

const cleanup = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mim-update-artifacts-'))
  cleanup.push(directory)
  return directory
}

describe('verifyUpdateArtifacts', () => {
  it('accepts metadata when every referenced artifact exists', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'Mim-Setup-0.1.2.exe'), '')
    await writeFile(join(directory, 'latest.yml'), [
      'version: 0.1.2',
      'files:',
      '  - url: Mim-Setup-0.1.2.exe',
      'path: Mim-Setup-0.1.2.exe',
      '',
    ].join('\n'))

    await expect(verifyUpdateArtifacts(directory, 'latest.yml'))
      .resolves.toEqual(['Mim-Setup-0.1.2.exe'])
  })

  it('rejects metadata that points to a missing artifact', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'latest.yml'), [
      'version: 0.1.2',
      'files:',
      '  - url: Mim-Setup-0.1.2.exe',
      'path: Mim-Setup-0.1.2.exe',
      '',
    ].join('\n'))

    await expect(verifyUpdateArtifacts(directory, 'latest.yml'))
      .rejects.toThrow('latest.yml references missing artifact: Mim-Setup-0.1.2.exe')
  })

  it('requires the architecture-specific manifest selected by CI', async () => {
    const directory = await fixture()

    await expect(verifyUpdateArtifacts(directory, 'latest-linux-arm64.yml'))
      .rejects.toThrow('Missing update manifest: latest-linux-arm64.yml')
  })
})
