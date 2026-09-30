export type Lang = 'zh' | 'en'

export interface Dict {
  title: string
  subtitle: string
  feedback: string
  refresh: string
  scan: string
  scanning: string
  fix: string
  fixing: string
  clean: string
  fatal: string
  warn: string
  info: string
  findings: string
  rows: string
  filterAll: string
  filterFatal: string
  filterWarn: string
  filterOk: string
  disable: string
  enable: string
  protectedTag: string
  disabledTag: string
  prev: string
  next: string
  pageOf: string
  timeline: string
  emptyTimeline: string
  chat: string
  chatHint: string
  chatWelcome: string
  chatPlaceholder: string
  chatSend: string
  chatThinking: string
  chatNoChannel: string
  ragToggle: string
  btnDeposit: string
  depositOk: string
  depositFail: string
  depositNoChat: string
  knowledge: string
  knowledgeHint: string
  knowledgePlaceholder: string
  search: string
  showAll: string
  knowledgeEmpty: string
  knowledgeSearchEmpty: string
  delete: string
  times: string
  loadFail: string
  profile: string
  home: string
  adapt: string
  adaptHint: string
  adaptPlaceholder: string
  adaptCheck: string
  adaptWorking: string
  adaptInstalled: string
  adaptRefused: string
  adaptPeers: string
  adaptRiskNarrow: string
  adaptRiskCross: string
  adaptWarning: string
  adaptConfirm: string
  adaptCancel: string
  adaptDone: string
  adaptDetail: string
  exemptions: string
  exemptionsEmpty: string
  revoke: string
  uninstallCleanup: string
}

export const DICTS: Record<Lang, Dict> = {
  zh: {
    title: '健康检查',
    subtitle: 'dsh-ops 内嵌面板：扫描当前 profile 的插件健康状态',
    feedback: '反馈',
    refresh: '刷新',
    scan: '扫描',
    scanning: '扫描中…',
    fix: '修复',
    fixing: '修复中…',
    clean: '未发现问题',
    fatal: '致命',
    warn: '警告',
    info: '信息',
    findings: '扫描结果',
    rows: '插件行管理',
    filterAll: '全部',
    filterFatal: '致命',
    filterWarn: '警告',
    filterOk: '正常',
    disable: '禁用',
    enable: '启用',
    protectedTag: '官方保护',
    disabledTag: '已禁用',
    prev: '上一页',
    next: '下一页',
    pageOf: '第 {cur} / {total} 页',
    timeline: '故障时间线',
    emptyTimeline: '暂无记录',
    chat: '诊断对话',
    chatHint: '基于当前 profile 的实时扫描结果；建议的修复请用上方白名单按钮执行',
    chatWelcome: '我是诊断助手。已载入当前 profile 的扫描结果，想问什么？',
    chatPlaceholder: '问：这些警告是什么意思？该怎么处理？',
    chatSend: '发送',
    chatThinking: '思考中…',
    chatNoChannel: '未找到可用模型通道（dsh 未提供 llm 服务且未配置 API key）',
    ragToggle: '增强检索（知识库）',
    btnDeposit: '沉淀为知识',
    depositOk: '已沉淀为知识条目',
    depositFail: '沉淀失败：',
    depositNoChat: '先进行一轮对话再沉淀',
    knowledge: '知识库（插件排障经验）',
    knowledgeHint: 'bug 与修复经验沉淀为 md；开关开启时诊断对话自动检索命中条目',
    knowledgePlaceholder: '搜索：错误信息 / 包名 / 规则…',
    search: '搜索',
    showAll: '全部',
    knowledgeEmpty: '暂无知识条目（修复成功或对话沉淀后自动积累）',
    knowledgeSearchEmpty: '无命中条目',
    delete: '删除',
    times: '出现 {n} 次',
    loadFail: '加载失败：',
    profile: 'Profile',
    home: 'DSH_HOME',
    adapt: '安装适配',
    adaptHint: '对官方门禁拒绝的插件做豁免安装；隔离 canary 验证在 CLI 版（dsh-ops adapt）',
    adaptPlaceholder: 'npm 包名（如 dsh-aimail@0.1.30）',
    adaptCheck: '检查并安装',
    adaptWorking: '处理中…',
    adaptInstalled: '安装完成',
    adaptRefused: '官方门禁拒绝：与当前 dsh 不兼容',
    adaptPeers: '不兼容的 peer',
    adaptRiskNarrow: '风险：窄范围',
    adaptRiskCross: '风险：跨 breaking 边界',
    adaptWarning: '豁免 = 明确接受崩溃/数据丢失风险（官方原文）；面板版不做隔离 canary，安装失败会自动撤销豁免',
    adaptConfirm: '豁免并安装',
    adaptCancel: '取消',
    adaptDone: '已豁免安装；重启 dsh 生效',
    adaptDetail: '安装详情',
    exemptions: '豁免清单',
    exemptionsEmpty: '暂无豁免',
    revoke: '撤销',
    uninstallCleanup: '卸载并清理',
  },
  en: {
    title: 'Health Check',
    subtitle: 'Embedded dsh-ops panel: plugin health of the current profile',
    feedback: 'Feedback',
    refresh: 'Refresh',
    scan: 'Scan',
    scanning: 'Scanning…',
    fix: 'Fix',
    fixing: 'Fixing…',
    clean: 'No findings',
    fatal: 'Fatal',
    warn: 'Warn',
    info: 'Info',
    findings: 'Scan results',
    rows: 'Plugin rows',
    filterAll: 'All',
    filterFatal: 'Fatal',
    filterWarn: 'Warn',
    filterOk: 'OK',
    disable: 'Disable',
    enable: 'Enable',
    protectedTag: 'official',
    disabledTag: 'disabled',
    prev: 'Prev',
    next: 'Next',
    pageOf: 'Page {cur} / {total}',
    timeline: 'Fault timeline',
    emptyTimeline: 'No records',
    chat: 'Diagnosis chat',
    chatHint: 'Based on a live scan of the current profile; use the whitelisted buttons above to apply suggested fixes',
    chatWelcome: 'Diagnosis assistant here. The current profile scan is loaded — what would you like to know?',
    chatPlaceholder: 'Ask: what do these warnings mean? How do I fix them?',
    chatSend: 'Send',
    chatThinking: 'Thinking…',
    chatNoChannel: 'No model channel available (dsh exposes no llm service and no API key is configured)',
    ragToggle: 'Enhanced retrieval (knowledge base)',
    btnDeposit: 'Deposit as knowledge',
    depositOk: 'Deposited as a knowledge entry',
    depositFail: 'Deposit failed: ',
    depositNoChat: 'Chat once before depositing',
    knowledge: 'Knowledge base (plugin troubleshooting)',
    knowledgeHint: 'Bugs and fixes deposit as Markdown; the toggle retrieves matching entries for the chat',
    knowledgePlaceholder: 'Search: error text / package / rule…',
    search: 'Search',
    showAll: 'All',
    knowledgeEmpty: 'No entries yet (fixes and deposits accumulate here)',
    knowledgeSearchEmpty: 'No matches',
    delete: 'Delete',
    times: 'seen {n}×',
    loadFail: 'Load failed: ',
    profile: 'Profile',
    home: 'DSH_HOME',
    adapt: 'Installation adaptation',
    adaptHint: 'exempt-install a plugin the official gate rejects; the isolated canary lives in the CLI (dsh-ops adapt)',
    adaptPlaceholder: 'npm package (e.g. dsh-aimail@0.1.30)',
    adaptCheck: 'Check & install',
    adaptWorking: 'Working…',
    adaptInstalled: 'Installed',
    adaptRefused: 'Refused by the official gate: incompatible with this dsh',
    adaptPeers: 'Incompatible peers',
    adaptRiskNarrow: 'Risk: narrow',
    adaptRiskCross: 'Risk: cross-breaking',
    adaptWarning: 'An exemption explicitly accepts crash/data-loss risk (official wording); the panel skips the isolated canary and revokes the exemption automatically when the install fails',
    adaptConfirm: 'Exempt & install',
    adaptCancel: 'Cancel',
    adaptDone: 'Installed with an exemption; restart dsh to activate',
    adaptDetail: 'Install details',
    exemptions: 'Exemptions',
    exemptionsEmpty: 'No exemptions',
    revoke: 'Revoke',
    uninstallCleanup: 'Uninstall & clean',
  },
}

export function detectLang(): Lang {
  const nav = typeof navigator === 'undefined' ? '' : navigator.language
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}
