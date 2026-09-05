import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import config from '../electron-builder.config.mjs'

describe('electron-builder updater configuration', () => {
  it('uses GitHub publish config for built-in updater metadata', () => {
    expect(config.publish).toEqual({
      provider: 'github',
      owner: 'abundance-ds',
      repo: 'mim-os',
    })
    expect(config.afterPack).toBeUndefined()
  })

  it('builds mac ZIPs and keeps deb out of updater metadata', () => {
    expect(config.mac.target).toContainEqual({ target: 'zip', arch: ['arm64', 'x64'] })
    expect(config.deb.publish).toBeNull()
  })

  it('builds Linux installers for x64 and arm64', () => {
    expect(config.linux.target).toEqual(['AppImage', 'deb', 'tar.gz'])
  })

  it('uses a GitHub-safe Windows artifact name that matches updater metadata', () => {
    expect(config.nsis.artifactName).toBe('${productName}-Setup-${version}.${ext}')
  })

  it('packages app iframe SDK assets', () => {
    expect(config.files).toContain('sdk/**/*')
    expect(config.files).toContain('!sdk/**/*.test.*')
  })

  it('unpacks the Pi extension so the external CLI can load it', () => {
    expect(config.asarUnpack).toContain('resources/pi/**')
  })

  it('keeps CI manual-publish only while uploading builder metadata', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8')

    expect(workflow).toContain('--publish never')
    expect(workflow).toContain('dist-installers/latest*.yml')
    expect(workflow).toContain('node scripts/build-docx-worker.mjs osx-arm64')
    expect(workflow).toContain('node scripts/build-docx-worker.mjs osx-x64')
    expect(workflow).toContain('os: ubuntu-24.04-arm')
    expect(workflow).toContain("build_args: '--x64'")
    expect(workflow).toContain("build_args: '--arm64'")
    expect(workflow).toContain('label: Linux ARM64')
    expect(workflow).toContain('actions/checkout@v5')
    expect(workflow).toContain('actions/setup-node@v5')
    expect(workflow).toContain('actions/setup-dotnet@v5')
    expect(workflow).toContain('actions/upload-artifact@v6')
    expect(workflow).toContain('node scripts/verify-update-artifacts.mjs dist-installers "$UPDATE_MANIFEST"')
    expect(workflow).toContain("update_manifest: 'latest-linux-arm64.yml'")
    expect(workflow).toContain('label: macOS')
    expect(workflow).not.toContain('label: macOS ARM')
    expect(workflow).not.toContain('label: macOS Intel')
    expect(workflow).not.toContain('generate-update-manifests')
  })
})
