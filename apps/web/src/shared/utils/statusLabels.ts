// Run status → Chinese display label (single source of truth).
// Previously duplicated in useConversation.ts, DetailHistoryPanel.tsx, diagnostics.ts, derivedState.ts, detailSummaryModel.ts.

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_approval: '待审批',
  clarification_needed: '待澄清',
  requires_action: '需处理',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

export function formatRunStatus(status?: string): string {
  if (!status) return '准备就绪'
  return STATUS_LABELS[status] ?? status
}

