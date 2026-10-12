import type { SandboxManager, SandboxStatus } from './sandbox.js'

/**
 * Agent tools over the sandbox manager: the "number 1 dsh controls the
 * number 2 dsh" channel. A registered tool lets the running agent start and
 * stop the isolated instance, read its output and diagnostics, scan its
 * profile, and apply disable-row fixes with a restart as proof. Tool
 * definitions are plain objects (no official runtime import): the shape is
 * `name`/`description`/`parameters` (JSON Schema) plus `output` (schema and a
 * text renderer) and `execute`, which is what the tools registry consumes.
 */

/** The minimal view of the official tools service this module registers into. */
export interface ToolRuntimeLike {
  register(tool: unknown): () => void
}

interface ToolTextBlock {
  type: 'text'
  text: string
}

interface SandboxTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => ToolTextBlock[]
  }
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<unknown>
}

function text(value: string): ToolTextBlock[] {
  return [{ type: 'text', text: value }]
}

/** The sandbox URL carries its launch token; tool output (model context and session log) only needs the address. */
function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/i, '$1***')
}

function statusLine(status: SandboxStatus): string {
  const parts = [`state: ${status.state}`]
  if (status.url !== null) parts.push(`url: ${redactToken(status.url)}`)
  if (status.home !== null) parts.push(`home: ${status.home}`)
  if (status.startedAt !== null) parts.push(`started: ${status.startedAt}`)
  if (status.problem !== null) parts.push(`problem: ${status.problem}`)
  if (status.lastExit !== null) parts.push(`last exit: ${status.lastExit.code ?? 'signal'} at ${status.lastExit.at}`)
  return parts.join('\n')
}

function startTool(manager: SandboxManager): SandboxTool {
  return {
    name: 'dsh_ops_sandbox_start',
    description: manager.kind === 'desktop'
      ? 'Start the isolated DeepSeek Harness desktop sandbox: a second desktop window of this installation, isolated through its own user-data directory and temporary DSH home. Installing or repairing plugins there cannot affect this instance. This is configuration-level isolation, not a security boundary: the sandbox inherits this process environment and your file-system access — do not use it to run untrusted plugin code.'
      : 'Start the isolated DeepSeek Harness sandbox (a temporary DSH home used for plugin configuration work). Returns the sandbox state and address. Installing or repairing plugins there cannot affect this instance. This is configuration-level isolation, not a security boundary: the sandbox inherits this process environment and your file-system access — do not use it to run untrusted plugin code.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(statusLine(value as SandboxStatus)),
    },
    async execute() {
      return manager.start()
    },
  }
}

function stopTool(manager: SandboxManager): SandboxTool {
  return {
    name: 'dsh_ops_sandbox_stop',
    description: 'Stop the isolated sandbox and remove its temporary home (the sandbox does not persist between runs).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(statusLine(value as SandboxStatus)),
    },
    async execute() {
      return manager.stop()
    },
  }
}

function statusTool(manager: SandboxManager): SandboxTool {
  return {
    name: 'dsh_ops_sandbox_status',
    description: 'Report the sandbox state, its recent output tail, and the plugin failures visible from outside (official startup diagnostics plus error-looking log lines).',
    parameters: {
      type: 'object',
      properties: {
        logs: { type: 'boolean', description: 'include the recent output tail (default true)' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        const payload = value as { status: SandboxStatus; logTail: string[]; inactiveEntries: { id: string; module: string; required: boolean }[]; errorLines: string[] }
        const sections = [statusLine(payload.status)]
        if (payload.inactiveEntries.length > 0) {
          sections.push(`failed plugin entries:\n${payload.inactiveEntries.map((entry) => `  [${entry.required ? 'required' : 'optional'}] ${entry.id} — ${entry.module}`).join('\n')}`)
        }
        if (payload.errorLines.length > 0) {
          sections.push(`error lines:\n${payload.errorLines.map((line) => `  ${line}`).join('\n')}`)
        }
        const includeLogs = (args as { logs?: boolean } | null)?.logs !== false
        if (includeLogs && payload.logTail.length > 0) {
          sections.push(`output tail:\n${payload.logTail.map((line) => `  ${line}`).join('\n')}`)
        }
        return text(sections.join('\n\n'))
      },
    },
    async execute(args) {
      const includeLogs = (args as { logs?: boolean } | null)?.logs !== false
      const diagnosis = manager.diagnose()
      return {
        status: manager.status(),
        // The web shape reports failures through the startup diagnostics; the
        // desktop shape through its crash report — either way the failed
        // loader entries end up in the same field.
        inactiveEntries: diagnosis.startup?.entries ?? diagnosis.crash?.entries ?? [],
        errorLines: diagnosis.errorLines,
        logTail: includeLogs ? manager.logsAfter(0).lines.slice(-40).map((entry) => entry.line) : [],
      }
    },
  }
}

function scanTool(manager: SandboxManager): SandboxTool {
  return {
    name: 'dsh_ops_sandbox_scan',
    description: 'Scan the sandbox profile with the dsh-ops rules and report findings (fatal/warn/info). Read-only; works whether or not the sandbox is running, as long as its home exists.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const payload = value as { ok: boolean; findings: { ruleId: string; severity: string; packageName?: string; message: string }[]; note: string | null }
        if (!payload.ok && payload.note !== null) return text(payload.note)
        if (payload.findings.length === 0) return text('scan: no findings')
        return text(payload.findings.map((finding) =>
          `[${finding.severity}] ${finding.ruleId}: ${finding.message}${finding.packageName === undefined ? '' : ` (${finding.packageName})`}`,
        ).join('\n'))
      },
    },
    async execute() {
      const report = await manager.scan()
      if (report === null) {
        return { ok: false, note: 'no sandbox home exists; start the sandbox first', findings: [] }
      }
      return { ok: true, note: null, findings: report.findings }
    },
  }
}

function fixTool(manager: SandboxManager): SandboxTool {
  return {
    name: 'dsh_ops_sandbox_fix',
    description: 'Disable one or more loader rows inside the sandbox profile and restart the sandbox with those rows disabled. Use the row ids named by the scan findings or the sandbox boot log. A successful boot reports that these rows are not the sole blocker of the failure — it does not prove they caused it.',
    parameters: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: { type: 'string' },
          description: 'loader row ids to disable in the sandbox profile (must be visible rows)',
        },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const payload = value as { applied: { row: string; ok: boolean; detail: string }[]; restarted: boolean; status: SandboxStatus }
        const lines = payload.applied.map((entry) => `${entry.ok ? 'disabled' : 'FAILED'} ${entry.row}: ${entry.detail}`)
        lines.push('', `restart result:\n${statusLine(payload.status)}`)
        if (!payload.restarted) {
          lines.push('no rows were disabled and the sandbox was not restarted')
        } else {
          lines.push(payload.status.state === 'running'
            ? 'the sandbox booted with these rows disabled: they are not the sole blocker'
            : 'the sandbox did not boot with these rows disabled; inspect the log and diagnostics before trying more rows')
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const rows = (args as { rows?: unknown }).rows
      if (!Array.isArray(rows) || rows.some((row) => typeof row !== 'string' || row.trim() === '')) {
        throw new Error('rows must be a non-empty array of row ids')
      }
      return manager.fix(rows.map((row) => (row as string).trim()))
    },
  }
}

/**
 * Register the sandbox tools into the official tools service.
 * @param tools - the tools registry (`ctx.get('tools')`).
 * @param manager - the sandbox manager the tools drive.
 * @returns one disposer per registered tool.
 */
export function registerSandboxTools(tools: ToolRuntimeLike, manager: SandboxManager): (() => void)[] {
  return [
    startTool(manager),
    stopTool(manager),
    statusTool(manager),
    scanTool(manager),
    fixTool(manager),
  ].map((tool) => tools.register(tool))
}
