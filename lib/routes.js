/**
 * Unified routes facade (#389).
 * Decomposed into domain modules under lib/routes/ (security, board, task, task-worktree, task-actions).
 * Re-exports all functions to maintain 100% backward compatibility with existing tests and imports.
 * Zero Cyrillic in lib/ according to Issue #366.
 */

export {
  MAX_BODY_BYTES,
  isLoopbackAddress,
  isLanAddress,
  isTrustedHost,
  normalizeIp,
  cookieNameForAuthority,
  isLoopbackCookieName,
  hasClientCredentials,
  getClientIp,
  getRejectionStatus,
  isTrustedRequest,
  rejectUntrustedRequest,
} from './routes/security.js'

export {
  withPlan,
  buildBoard,
  boardMetrics,
  exportBoard,
  importBoard,
  exportTasksCsv,
} from './routes/board.js'

export {
  parseTaskPath,
  applyMove,
  createTask,
  updateTask,
  confirmPermission,
  appendNote,
  setArchived,
  listArchive,
  assignTask,
  deleteTask,
  canRevive,
  taskBody,
  taskLog,
  taskBySession,
} from './routes/task.js'

export {
  handleCleanupWorktree,
  handleTaskDiff,
  handleTaskDiscard,
  handleTaskCommits,
  handleTaskMerge,
  handleTaskWorktreeStatus,
} from './routes/task-worktree.js'

export {
  handleTaskChecklist,
  handleTaskReport,
  handleGetTaskComments,
  handleAddTaskComment,
  handleAcceptTask,
  handleRejectTask,
  handleProgressDump,
  handleTriageTask,
  handleGetSubtasks,
  handleCreateSubtask,
  handleToggleChecklistItem,
  handleCreateTaskPr,
  handleTaskNudge,
} from './routes/task-actions.js'
