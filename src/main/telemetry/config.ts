import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { normalizePlatform } from './events.js'
import { userHomeDir } from '@main/platform.js'

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://mim.abundanceds.com/api/v1/telemetry/events'

export type TelemetryPlatform = 'macos' | 'windows' | 'linux'
export type TelemetryRuntime = 'electron' | 'headless'

export interface TelemetryConfig {
  endpoint: string | null
  disabled: boolean
  locked: boolean
  disabledReason?: 'env' | 'test'
  platform: TelemetryPlatform
}

export interface ResolveTelemetryConfigOptions {
  home?: string
  env?: Record<string, string | undefined>
  nodeEnv?: string
  platform?: string
  allowInTests?: boolean
}

export function resolveTelemetryConfig(options: ResolveTelemetryConfigOptions = {}): TelemetryConfig {
  const env = options.env ?? process.env
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV
  const envDisabled = isTruthy(env.MIM_TELEMETRY_DISABLED)
  const testDisabled = nodeEnv === 'test' && options.allowInTests !== true
  const disabled = envDisabled || testDisabled
  const endpoint = endpointFromEnv(env) ?? endpointFromConfig(options.home) ?? DEFAULT_TELEMETRY_ENDPOINT

  return {
    endpoint,
    disabled,
    locked: disabled,
    ...(envDisabled ? { disabledReason: 'env' as const } : testDisabled ? { disabledReason: 'test' as const } : {}),
    platform: normalizeTelemetryPlatform(options.platform ?? process.platform),
  }
}

export function normalizeTelemetryPlatform(value: string): TelemetryPlatform {
  return normalizePlatform(value)
}

function endpointFromEnv(env: Record<string, string | undefined>): string | null {
  return normalizeEndpoint(env.MIM_TELEMETRY_ENDPOINT)
}

function endpointFromConfig(home?: string): string | null {
  try {
    const path = join(home ?? userHomeDir(), '.mim', 'config.yaml')
    if (!existsSync(path)) return null
    const raw = parseYaml(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const telemetry = (raw as Record<string, unknown>).telemetry
    if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) return null
    return normalizeEndpoint((telemetry as Record<string, unknown>).endpoint)
  } catch {
    return null
  }
}

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

function isTruthy(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value === '1' || value.toLowerCase() === 'true'
}
