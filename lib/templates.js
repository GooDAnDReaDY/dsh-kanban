// Task templates for rapid standard work decomposition (#220, #304).

export const TASK_TEMPLATES = [
  {
    id: 'feature',
    title: 'New Feature',
    promptTemplate: 'Implement new feature:\n- Goal:\n- Requirements:\n- Scope of changes:',
    checklist: [
      { id: '1', text: 'Architecture plan and design contract agreed', required: true, completed: false },
      { id: '2', text: 'Code adheres to project guidelines and standards', required: true, completed: false },
      { id: '3', text: 'Unit and integration tests added and passing', required: true, completed: false },
      { id: '4', text: 'Documentation updated (README, docs/)', required: true, completed: false },
    ],
    priority: 'medium',
  },
  {
    id: 'bugfix',
    title: 'Bug Fix',
    promptTemplate: 'Localize and resolve defect:\n- Reproduction steps:\n- Expected behavior:\n- Actual behavior:',
    checklist: [
      { id: '1', text: 'Defect reproduced with isolated test case', required: true, completed: false },
      { id: '2', text: 'Root cause fixed without regressions', required: true, completed: false },
      { id: '3', text: 'Regression test added to test suite', required: true, completed: false },
    ],
    priority: 'high',
  },
  {
    id: 'refactor',
    title: 'Refactoring & Optimization',
    promptTemplate: 'Refactor module preserving external behavior:\n- Target module:\n- Architectural issue:\n- Completion criteria:',
    checklist: [
      { id: '1', text: 'Covered by existing tests (100% green)', required: true, completed: false },
      { id: '2', text: 'Structure simplified and technical debt eliminated', required: true, completed: false },
      { id: '3', text: 'Performance verified (no degradation)', required: true, completed: false },
    ],
    priority: 'low',
  },
  {
    id: 'security',
    title: 'Security & Dependency Audit',
    promptTemplate: 'Verify security and dependency vulnerabilities:\n- Audit scope:\n- Dependency revision:',
    checklist: [
      { id: '1', text: 'Supply-chain and dependency licenses verified', required: true, completed: false },
      { id: '2', text: 'Known CVEs mitigated or resolved', required: true, completed: false },
      { id: '3', text: 'Secrets and credentials verified clean of leaks', required: true, completed: false },
    ],
    priority: 'high',
  },
  {
    id: 'release',
    title: 'Release Preparation',
    promptTemplate: 'Prepare package release:\n- Version:\n- Changelog summary:\n- Pre-release verification:',
    checklist: [
      { id: '1', text: 'All repository tests pass (npm test)', required: true, completed: false },
      { id: '2', text: 'Core compatibility confirmed (npm run compat)', required: true, completed: false },
      { id: '3', text: 'Package archive size verified (< 256 KiB)', required: true, completed: false },
      { id: '4', text: 'Documentation and changelog updated', required: true, completed: false },
    ],
    priority: 'medium',
  },
]

export function getTemplateById(id) {
  return TASK_TEMPLATES.find((t) => t.id === id)
}
