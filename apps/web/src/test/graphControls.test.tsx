/**
 * KB-GRAPH-P4 控件面板（文档 B.2）：四个折叠区默认收起、可开合、四个滑杆回调、reset/close。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FORCE_SLIDER_DEFAULTS, GraphControls, type GraphControlsProps } from '../components/knowledge/GraphControls';

function mount(overrides: Partial<GraphControlsProps> = {}): GraphControlsProps {
  const props: GraphControlsProps = {
    localMode: false,
    localJumps: 1,
    forelinks: true,
    backlinks: true,
    interlinks: true,
    hideOrphans: false,
    showIsolated: true,
    forces: FORCE_SLIDER_DEFAULTS,
    onLocalMode: vi.fn(),
    onLocalJumps: vi.fn(),
    onForelinks: vi.fn(),
    onBacklinks: vi.fn(),
    onInterlinks: vi.fn(),
    onHideOrphans: vi.fn(),
    onShowIsolated: vi.fn(),
    onForces: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  render(<GraphControls {...props} />);
  return props;
}

describe('控件面板结构（B.2：四个折叠区默认收起）', () => {
  it('四个区都在，且默认 closed', () => {
    mount();
    for (const id of ['filter', 'color-groups', 'display', 'forces']) {
      const section = screen.getByTestId(`graph-section-${id}`) as HTMLDetailsElement;
      expect(section).toBeInTheDocument();
      expect(section.open).toBe(false);
    }
  });

  it('点击区头标题可展开/收起', () => {
    mount();
    const filter = screen.getByTestId('graph-section-filter') as HTMLDetailsElement;
    fireEvent.click(filter.querySelector('summary')!);
    expect(filter.open).toBe(true);
  });

  it('面板 240px / 右上角样式由 CSS 变量驱动（组件不带写死色值）', () => {
    mount();
    const panel = screen.getByTestId('graph-controls');
    expect(panel.className).toContain('ab-graph-controls');
    expect(panel.getAttribute('data-state')).toBe('open');
  });

  it('close 收起成窄条、⚙ 再打开', () => {
    mount();
    fireEvent.click(screen.getByTestId('graph-controls-close'));
    const closed = screen.getByTestId('graph-controls');
    expect(closed.getAttribute('data-state')).toBe('closed');
    expect(closed.className).toContain('is-close');
    fireEvent.click(screen.getByTestId('graph-controls-toggle'));
    expect(screen.getByTestId('graph-controls').getAttribute('data-state')).toBe('open');
  });

  it('魔棒（时间轴动画）标注未实现：disabled', () => {
    mount();
    const animate = screen.getByTestId('graph-controls-animate') as HTMLButtonElement;
    expect(animate.disabled).toBe(true);
    expect(animate.getAttribute('title')).toContain('未实现');
  });
});

describe('力滑杆与局部图开关', () => {
  it('拖动中心力滑杆 → onForces({centerStrength})', () => {
    const props = mount();
    fireEvent.change(screen.getByTestId('graph-forces-centerStrength'), { target: { value: '0.5' } });
    expect(props.onForces).toHaveBeenCalledWith({ centerStrength: 0.5 });
  });

  it('四个滑杆默认值 = 文档 A4（0.1 / 1000 / 1 / 250）', () => {
    mount();
    expect((screen.getByTestId('graph-forces-centerStrength') as HTMLInputElement).value).toBe('0.1');
    expect((screen.getByTestId('graph-forces-repelStrength') as HTMLInputElement).value).toBe('1000');
    expect((screen.getByTestId('graph-forces-linkStrength') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('graph-forces-linkDistance') as HTMLInputElement).value).toBe('250');
  });

  it('四个局部图开关未开局部图时禁用；开局部图后可用并各自回调', () => {
    const props = mount();
    expect((screen.getByTestId('graph-local-jumps') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId('graph-local-forelinks') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('graph-local-mode'));
    expect(props.onLocalMode).toHaveBeenCalledWith(true);
  });

  it('reset 触发恢复默认', () => {
    const props = mount({ localMode: true });
    fireEvent.click(screen.getByTestId('graph-controls-reset'));
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });
});
