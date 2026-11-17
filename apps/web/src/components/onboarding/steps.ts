/**
 * 新手引导的 5 步定义（G2）。
 *
 * `selector` 必须是**已存在**的目标元素（testid 由组件维护者保证）；目标不存在时
 * 运行时跳过该步而不是报错 —— 第 3 步「新建任务」只在看板视图的「待规划」列里才有。
 * 文案只描述该元素的作用，不写操作步骤的入门教学（那是教程页的职责）。
 */
export interface OnboardingStep {
  /** 稳定 id：测试与埋点用，不随文案变 */
  id: string;
  selector: string;
  title: string;
  body: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'workspace',
    selector: '[data-testid="sidebar-workspace"]',
    title: '当前工作空间',
    body: '点这里切换工作空间。看板、知识库、日志都按工作空间隔离。',
  },
  {
    id: 'board',
    selector: '[data-testid="sidebar-entry-board"]',
    title: '任务看板',
    body: '主入口。五列从左到右：待规划、进行中、待验收、已关闭、已废弃。',
  },
  {
    id: 'create-issue',
    selector: '[data-testid="column-create-待规划"]',
    title: '新建任务',
    body: '点 + 建卡；卡建在看板后要 claim 才能开工。',
  },
  {
    id: 'chat',
    selector: '[data-testid="sidebar-entry-chat"]',
    title: '聊天',
    body: '派发任务后在这里跟进执行过程。',
  },
  {
    id: 'guide',
    selector: '[data-testid="sidebar-entry-guide"]',
    title: '教程',
    body: '完整说明书在这里；随时可以从左栏打开。',
  },
];

/** 目标元素当前是否在文档里（用于跳过缺失步） */
export function stepTarget(step: OnboardingStep): Element | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector(step.selector);
}
