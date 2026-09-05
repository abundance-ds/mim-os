import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  normalizeTelemetryPlatform,
  resolveTelemetryConfig,
} from './config.js'

function writeConfig(home: string, text: string): void {
  mkdirSync(join(home, '.mim'), { recursive: true })
  writeFileSync(join(home, '.mim', 'config.yaml'), text)
}

describe('telemetry config', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mim-telemetry-config-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('uses the Abundance Decision Systems endpoint by default', () => {
    expect(DEFAULT_TELEMETRY_ENDPOINT).toBe('https://mim.abundanceds.com/api/v1/telemetry/events')
  })

  it('resolves endpoint precedence from env, config, then default', () => {
    writeConfig(home, 'telemetry:\n  endpoint: https://config.example/events\n')

    expect(resolveTelemetryConfig({
      home,
      env: { MIM_TELEMETRY_ENDPOINT: 'https://env.example/events' },
      nodeEnv: 'production',
    }).endpoint).toBe('https://env.example/events')

    expect(resolveTelemetryConfig({
      home,
      env: {},
      nodeEnv: 'production',
    }).endpoint).toBe('https://config.example/events')

    rmSync(join(home, '.mim', 'config.yaml'))
    expect(resolveTelemetryConfig({
      home,
      env: {},
      nodeEnv: 'production',
    }).endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT)
  })

  it('ignores malformed or non-http endpoints', () => {
    writeConfig(home, 'telemetry:\n  endpoint: file:///tmp/leak\n')

    expect(resolveTelemetryConfig({
      home,
      env: {},
      nodeEnv: 'production',
    }).endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT)
  })

  it('honors env and test kill switches', () => {
    expect(resolveTelemetryConfig({
      home,
      env: { MIM_TELEMETRY_DISABLED: '1' },
      nodeEnv: 'production',
    })).toMatchObject({ disabled: true, locked: true, disabledReason: 'env' })

    expect(resolveTelemetryConfig({
      home,
      env: {},
      nodeEnv: 'test',
    })).toMatchObject({ disabled: true, locked: true, disabledReason: 'test' })

    expect(resolveTelemetryConfig({
      home,
      env: {},
      nodeEnv: 'test',
      allowInTests: true,
    })).toMatchObject({ disabled: false, locked: false })
  })

  it('normalizes supported platforms', () => {
    expect(normalizeTelemetryPlatform('darwin')).toBe('macos')
    expect(normalizeTelemetryPlatform('win32')).toBe('windows')
    expect(normalizeTelemetryPlatform('linux')).toBe('linux')
    expect(normalizeTelemetryPlatform('freebsd')).toBe('linux')
  })
})
