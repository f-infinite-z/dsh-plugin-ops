import type { Lang } from './i18n.js'

/** Copy for the sandbox panel, entry button, and guide capsule (zh/en). */
export interface SandboxDict {
  title: string
  subtitle: string
  start: string
  stop: string
  restart: string
  open: string
  scan: string
  diagnose: string
  refresh: string
  stateStopped: string
  stateStarting: string
  stateRunning: string
  stateStopping: string
  url: string
  home: string
  problem: string
  noProblem: string
  findings: string
  noFindings: string
  errorLines: string
  fixTitle: string
  fixHint: string
  fixPlaceholder: string
  fixApply: string
  fixApplied: string
  fixFailed: string
  restartHeld: string
  restartBroke: string
  useRow: string
  logs: string
  startFirst: string
  busy: string
  guide: string
}

export const SANDBOX_DICTS: Record<Lang, SandboxDict> = {
  zh: {
    title: '沙箱实例',
    subtitle: '在隔离的 2 号 dsh 中测试与修复插件；出问题不会影响当前实例',
    start: '启动沙箱',
    stop: '停止并清理',
    restart: '重启（保留现场）',
    open: '打开沙箱',
    scan: '扫描沙箱',
    diagnose: '读取诊断',
    refresh: '刷新',
    stateStopped: '已停止',
    stateStarting: '启动中',
    stateRunning: '运行中',
    stateStopping: '停止中',
    url: '地址',
    home: '沙箱 home',
    problem: '问题',
    noProblem: '无',
    findings: '扫描发现',
    noFindings: '未发现问题',
    errorLines: '错误输出',
    fixTitle: '修复（禁用行并重启验证）',
    fixHint: '输入要禁用的 loader 行 id（通常即包名）；沙箱会重启以证明修复有效',
    fixPlaceholder: '行 id，例如 dsh-some-plugin（多个用逗号分隔）',
    fixApply: '应用修复',
    fixApplied: '已写入：',
    fixFailed: '写入失败：',
    restartHeld: '修复有效：沙箱在禁用这些行后成功启动',
    restartBroke: '禁用这些行后沙箱仍未启动；请查看日志与诊断，尝试其他行',
    useRow: '禁用此行',
    logs: '运行日志',
    startFirst: '先启动沙箱',
    busy: '处理中…',
    guide: '启动隔离的 2 号 dsh，在这里测试有风险的新插件',
  },
  en: {
    title: 'Sandbox instance',
    subtitle: 'Test and repair plugins inside an isolated number-2 dsh; failures cannot touch this instance',
    start: 'Start sandbox',
    stop: 'Stop and clean up',
    restart: 'Restart (keep state)',
    open: 'Open sandbox',
    scan: 'Scan sandbox',
    diagnose: 'Read diagnostics',
    refresh: 'Refresh',
    stateStopped: 'stopped',
    stateStarting: 'starting',
    stateRunning: 'running',
    stateStopping: 'stopping',
    url: 'URL',
    home: 'sandbox home',
    problem: 'problem',
    noProblem: 'none',
    findings: 'Scan findings',
    noFindings: 'no findings',
    errorLines: 'Error output',
    fixTitle: 'Repair (disable rows and restart to prove it)',
    fixHint: 'Enter loader row ids to disable (usually the package name); the sandbox restarts so the repair is proven',
    fixPlaceholder: 'row id, e.g. dsh-some-plugin (comma-separated for several)',
    fixApply: 'Apply repair',
    fixApplied: 'written: ',
    fixFailed: 'failed: ',
    restartHeld: 'repair held: the sandbox booted with these rows disabled',
    restartBroke: 'the sandbox still failed with these rows disabled; check the log and diagnostics and try other rows',
    useRow: 'disable this row',
    logs: 'Runtime log',
    startFirst: 'start the sandbox first',
    busy: 'working…',
    guide: 'Start an isolated number-2 dsh to test risky plugins here',
  },
}
