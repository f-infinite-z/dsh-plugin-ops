import type { Lang } from './i18n.js'

/** Copy for the sandbox panel, entry button, and guide capsule (zh/en). */
export interface SandboxDict {
  title: string
  subtitle: string
  subtitleDesktop: string
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
  crashReport: string
  installTitle: string
  installHint: string
  installPlaceholder: string
  installApply: string
  installOk: string
  installRecovered: string
  installFail: string
  approveBuilds: string
  approveBuildsOk: string
  approveBuildsFail: string
  lastSession: string
  fixTitle: string
  fixHint: string
  fixPlaceholder: string
  fixApply: string
  fixApplied: string
  fixFailed: string
  fixNotApplied: string
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
    subtitle: '隔离实例：用于插件配置的测试与修复。注意：它继承你的环境与文件权限（用户级 npm 凭据 ~/.npmrc、git 凭据同样可在沙箱内读到），请勿用于不可信代码',
    subtitleDesktop: '隔离的第二个桌面窗口：独立 user-data 与 DSH home，用于插件配置的测试与修复。注意：它继承你的环境与文件权限（DSH_HOME 之外不隔离——插件可读写整个用户目录，用户级 npm 凭据 ~/.npmrc、git 凭据同样可在沙箱内读到），请勿用于不可信代码',
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
    crashReport: '崩溃报告',
    installTitle: '安装插件（进沙箱）',
    installHint: '输入 npm 包名或 name@版本；装完自动回读校验注册，半注册残留自动 remove→add 修复；新装约 3 秒热加载',
    installPlaceholder: '例如 dsh-whale-widget 或 @scope/name@0.4.2',
    installApply: '安装到沙箱',
    installOk: '已安装并注册',
    installRecovered: '已安装并注册（经 remove→add 修复）',
    installFail: '未安装/未注册——详见步骤',
    approveBuilds: '批准构建脚本（之后重试安装）',
    approveBuildsOk: '构建门已解决——请再次点击安装',
    approveBuildsFail: '未能解决构建门',
    lastSession: '上次会话验证过',
    fixTitle: '修复（禁用行并重启验证）',
    fixHint: '输入要禁用的 loader 行 id（通常即包名）；沙箱会重启以证明修复有效',
    fixPlaceholder: '行 id，例如 dsh-some-plugin（多个用逗号分隔）',
    fixApply: '应用修复',
    fixApplied: '已写入：',
    fixFailed: '写入失败：',
    fixNotApplied: '未禁用任何行，沙盒未重启',
    restartHeld: '沙箱在禁用这些行后成功启动（说明它们不是唯一阻塞）',
    restartBroke: '禁用这些行后沙箱仍未启动；请查看日志与诊断，尝试其他行',
    useRow: '禁用此行',
    logs: '运行日志',
    startFirst: '先启动沙箱',
    busy: '处理中…',
    guide: '启动隔离的 2 号 dsh，在这里测试有风险的新插件',
  },
  en: {
    title: 'Sandbox instance',
    subtitle: 'Isolated instance for plugin configuration work. Note: it inherits your environment and file-system access (user-level npm credentials in ~/.npmrc and git credentials are readable from the sandbox too) — not for untrusted code',
    subtitleDesktop: 'Isolated second desktop window: its own user-data directory and DSH home, for plugin configuration work. Note: it inherits your environment and file-system access (nothing outside DSH_HOME is isolated — plugins can read/write your whole user directory, including user-level npm credentials in ~/.npmrc and git credentials) — not for untrusted code',
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
    crashReport: 'Crash report',
    installTitle: 'Install a plugin (into the sandbox)',
    installHint: 'npm spec (name or name@version); the install reads the profile back to verify registration and repairs a half-registered residue with remove + add; a new bundle hot-loads in ~3s',
    installPlaceholder: 'e.g. dsh-whale-widget or @scope/name@0.4.2',
    installApply: 'Install into sandbox',
    installOk: 'installed and registered',
    installRecovered: 'installed and registered (recovered with remove + add)',
    installFail: 'not installed/registered — see the steps',
    approveBuilds: 'Approve build scripts (then retry the install)',
    approveBuildsOk: 'the build gate is resolved — click install again',
    approveBuildsFail: 'could not resolve the build gate',
    lastSession: 'Last session verified',
    fixTitle: 'Repair (disable rows and restart to prove it)',
    fixHint: 'Enter loader row ids to disable (usually the package name); the sandbox restarts so the repair is proven',
    fixPlaceholder: 'row id, e.g. dsh-some-plugin (comma-separated for several)',
    fixApply: 'Apply repair',
    fixApplied: 'written: ',
    fixFailed: 'failed: ',
    fixNotApplied: 'no rows were disabled; the sandbox was not restarted',
    restartHeld: 'the sandbox booted with these rows disabled: they are not the sole blocker',
    restartBroke: 'the sandbox still failed with these rows disabled; check the log and diagnostics and try other rows',
    useRow: 'disable this row',
    logs: 'Runtime log',
    startFirst: 'start the sandbox first',
    busy: 'working…',
    guide: 'Start an isolated number-2 dsh to test risky plugins here',
  },
}
