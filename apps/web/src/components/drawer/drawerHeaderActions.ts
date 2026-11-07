/**
 * ACC-UI-TOPBAR：drawer 标题栏操作区宿主。
 *
 * DrawerPanel 在标题栏（账号管理 … 关闭 一行）的关闭按钮左侧渲染一个空槽 `<div data-testid="drawer-header-actions">`，
 * 并把槽的 DOM 节点经本 Context 下发。面板（AccountsPanel）把顶栏按钮（添加 / 一键签到 / 刷新）
 * Portal 进该槽；独立渲染面板（单测、无 drawer 宿主）时 Context 默认 null，面板回退为面板内内联操作行。
 *
 * 单独成文件避免 DrawerPanel ↔ AccountsPanel 循环 import。
 */
import { createContext } from 'react';

export const DrawerHeaderActionsContext = createContext<HTMLElement | null>(null);
