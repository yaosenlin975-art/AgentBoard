/**
 * 教程内容模型（GUIDE-1）。
 *
 * 章节是纯数据：每个 `chapters/*.ts` 模块导出 `chapter`，由 GuideView 用
 * `import.meta.glob` 聚合、按 `order` 升序渲染。新增章节只需加文件，不改组件。
 * 文案里的按钮名必须来自真实组件（以代码为准），不编造不存在的入口。
 */
import type { NavView } from '../../state/navStore';

export type GuideBlock =
  /** 有序步骤：`do` 是操作，`result` 是操作后应看到的现象 */
  | { kind: 'steps'; items: Array<{ do: string; result?: string }> }
  /** 提示块：info 普通说明 / warn 需要注意的坑 */
  | { kind: 'note'; tone?: 'info' | 'warn'; text: string }
  /** 代码块：CLI / 配置等逐行文本 */
  | { kind: 'code'; lines: string[] };

export interface GuideChapter {
  /** 稳定标识，用于目录锚点与测试断言 */
  id: string;
  /** 章节序号（0 为「五分钟上手」），目录与正文都按它排序 */
  order: number;
  title: string;
  /** 一句话说明本章教什么 */
  intro: string;
  blocks: GuideBlock[];
  /** 章末跳转按钮：切到对应视图（不新增路由） */
  goTo?: { view: NavView; label: string };
}
