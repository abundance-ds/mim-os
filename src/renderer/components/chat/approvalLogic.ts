// Presentation helpers for the inline approval card. The card answers one
// question for a non-engineer steering an agent: "is this the action I meant,
// and is it nothing catastrophic?" So the copy is plain, the routine stays calm,
// and only genuinely irreversible actions are set apart.
//
// Only AI actions ever reach this surface. The gate auto-allows direct user and
// app actions, so there is no app/permission/risk-jargon UI here.

export interface ApprovalPreviewLike {
  kind: 'edit' | 'write' | 'create' | 'delete'
  oldText?: string
  newText?: string
  content?: string
}

export interface SavedBrowserSessionApprovalLike {
  domain: string
  granted?: boolean
}

export interface ApprovalLike {
  toolName: string
  category?: string
  risk?: string
  reason?: string
  target?: string
  pathKind?: string
  // Human-readable action label from the resolved tool policy (package tools).
  label?: string
  sessionId?: string
  params?: Record<string, unknown>
  preview?: ApprovalPreviewLike
  savedBrowserSession?: SavedBrowserSessionApprovalLike
}

export function formatToolName(name: string): string {
  return name.replace(/_/g, '.')
}

// Plain, lowercase phrase that completes "Allow Mim to ___?".
const ACTION_PHRASES: Record<string, string> = {
  'fs.create': 'create a file',
  'fs.write': 'write a file',
  'fs.edit': 'edit a file',
  'fs.delete': 'delete a file',
  'fs.rename': 'rename a file',
  'fs.mkdir': 'create a folder',
  'terminal.run': 'run a terminal command',
  'terminal.spawn': 'open a terminal',
  'terminal.write': 'send input to the terminal',
  'package.create': 'create an app',
  'package.edit': 'edit an app file',
  'package.delete': 'delete an app',
  'slack.send': 'send a Slack message',
  'gmail.send': 'send an email',
  'calendar.create': 'add a calendar event',
  'settings.set': 'change a setting',
  'ai.setKey': 'save an API key',
  'app.enable': 'turn on an app',
  'app.disable': 'turn off an app',
  'web.read': 'read a web page',
  'code.run': 'run a script',
  'shell.run': 'run a shell command',
}

const CATEGORY_PHRASES: Record<string, string> = {
  write: 'change a file',
  network: 'contact an outside service',
  secrets: 'change stored credentials',
  system: 'run a system action',
  settings: 'change a setting',
}

export function actionPhrase(approval: ApprovalLike): string {
  return ACTION_PHRASES[approval.toolName]
    ?? (approval.label ? `use ${approval.label}` : undefined)
    ?? (approval.category ? CATEGORY_PHRASES[approval.category] : undefined)
    ?? `use ${formatToolName(approval.toolName)}`
}

export function approvalQuestion(approval: ApprovalLike): string {
  const domain = approval.savedBrowserSession?.domain
  if ((approval.toolName === 'web.read' || approval.toolName === 'web.live.open') && domain) {
    return `Allow Mim to use your access to ${domain}?`
  }
  return `Allow Mim to ${actionPhrase(approval)}?`
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  return value == null ? '' : String(value)
}

// The single concrete thing worth verifying: a file path, a command, a
// recipient. For file tools we prefer the workspace-relative path the agent
// passed over the resolved absolute path.
export function targetDisplay(approval: ApprovalLike): string {
  const params = approval.params ?? {}
  if (approval.toolName === 'web.read' || approval.toolName === 'web.live.open') return asString(params.url) || asString(approval.target)
  if (approval.toolName === 'shell.run') {
    const cmd = asString(params.command)
    if (cmd) return cmd
    // terminal mode fallback
    return asString(approval.target)
  }
  if (approval.toolName === 'code.run') {
    const argv = params.argv
    if (Array.isArray(argv) && argv.length > 0) return argv.join(' ')
    return asString(approval.target)
  }
  if (approval.toolName === 'fs.rename') {
    const from = asString(params.old_path)
    const to = asString(params.new_path)
    if (from && to) return `${from} → ${to}`
    return from || to || asString(approval.target)
  }
  if (approval.toolName === 'terminal.run') return asString(params.command) || asString(approval.target)
  if (approval.toolName === 'terminal.write') return asString(params.data) || asString(approval.target)
  const pathLike = asString(params.path) || asString(params.old_path) || asString(params.file)
  return pathLike || asString(approval.target)
}

// Commands render as a wrapping code block; everything else as a single line.
export function targetIsCommand(approval: ApprovalLike): boolean {
  return approval.toolName === 'terminal.run'
    || approval.toolName === 'terminal.write'
    || approval.toolName === 'terminal.spawn'
    || approval.toolName === 'code.run'
    || approval.toolName === 'shell.run'
}

// For actions with no diff but a payload worth seeing — chiefly outbound sends —
// a second line shows what is actually going out. Keeps the long tail of tools
// from being a bare verb + recipient.
export function targetDetail(approval: ApprovalLike): string {
  const params = approval.params ?? {}
  if (approval.toolName === 'slack.send') return asString(params.text)
  if (approval.toolName === 'gmail.send') {
    return [asString(params.subject), asString(params.body)].filter(Boolean).join(' — ')
  }
  if (approval.toolName === 'calendar.create') {
    return [asString(params.start), asString(params.end)].filter(Boolean).join(' → ')
  }
  return ''
}

export interface DetailRow {
  key: string
  value: string
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// The exact call behind the request, for a "Show details" disclosure. Params are
// already gate-redacted (no file contents, keys, or tokens); this is the
// transparency floor for every tool, especially the ones with no diff.
export function detailRows(approval: ApprovalLike): DetailRow[] {
  const params = approval.params ?? {}
  const rows: DetailRow[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    rows.push({ key, value: truncate(stringifyValue(value), 300) })
  }
  return rows
}

// 'caution' for irreversible or out-of-the-ordinary actions. Keeping routine
// edits 'normal' is what makes a delete or an outside-the-workspace write
// actually stand out.
export function approvalTone(approval: ApprovalLike): 'normal' | 'caution' {
  if (approval.pathKind === 'sensitive' || approval.pathKind === 'outside-workspace') return 'caution'
  if (approval.risk === 'high') return 'caution'
  return 'normal'
}

// A short heads-up, shown only when the target itself is unusual. Empty for
// ordinary in-workspace changes.
export function approvalNote(approval: ApprovalLike): string {
  if (approval.savedBrowserSession?.domain) {
    const domain = approval.savedBrowserSession.domain
    if (approval.savedBrowserSession.granted) {
      return `This can use sign-in, consent, and cookies already set up for ${domain}.`
    }
    return `Approving lets Mim use sign-in, consent, and cookies already set up for ${domain}.`
  }
  if (approval.pathKind === 'sensitive') return 'This file is in a sensitive location. Check it before allowing.'
  if (approval.pathKind === 'outside-workspace') return 'This is outside your workspace folder.'
  if (approval.pathKind === 'team') return 'This writes to your Team.'
  return ''
}

// Only file mutations carry a reviewable before/after. Other actions are judged
// from the action and target shown on the card.
export function canReviewChange(approval: ApprovalLike): boolean {
  return Boolean(approval.preview)
}

export function canRemember(approval: ApprovalLike): boolean {
  if (approval.savedBrowserSession && approval.savedBrowserSession.granted !== true) return false
  return typeof approval.sessionId === 'string' && approval.sessionId.length > 0
}

// The gate remembers per tool, scoped to the session. The copy is grouped by
// action kind so it reads naturally; it errs toward asking again for a different
// kind of action rather than over-trusting.
export function rememberLabel(approval: ApprovalLike): string {
  const tool = approval.toolName
  if (tool.startsWith('fs.') || approval.category === 'write') return 'Always allow file changes in this chat'
  if (tool.startsWith('terminal.')) return 'Always allow terminal commands in this chat'
  if (tool === 'shell.run') return 'Always allow shell commands in this chat'
  if (approval.category === 'network') return 'Always allow outside requests in this chat'
  return 'Always allow this action in this chat'
}
