export type Lang = 'zh' | 'en'

export interface Dict {
  title: string
  subtitle: string
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
  loadFail: string
  profile: string
  home: string
}

export const DICTS: Record<Lang, Dict> = {
  zh: {
    title: '健康检查',
    subtitle: 'dsh-ops 内嵌面板：扫描当前 profile 的插件健康状态',
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
    loadFail: '加载失败：',
    profile: 'Profile',
    home: 'DSH_HOME',
  },
  en: {
    title: 'Health Check',
    subtitle: 'Embedded dsh-ops panel: plugin health of the current profile',
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
    loadFail: 'Load failed: ',
    profile: 'Profile',
    home: 'DSH_HOME',
  },
}

export function detectLang(): Lang {
  const nav = typeof navigator === 'undefined' ? '' : navigator.language
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}
