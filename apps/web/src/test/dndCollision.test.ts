/**
 * DND-SEARCH-BUG 回归：检索态「已关闭」列被过滤空后，指针落在该列上必须解析为列投放（改状态），
 * 不能被 closestCorners 的四角均分反向判给源列里的卡片（那样只会提交 sort_order）。
 * 夹具数值取自真实浏览器实测（1440×900，检索 DNDFIX）：
 * 空列 droppable 824..1064 × 168..838；源列卡片 560..792 × 249..319；指针 (944, 210)。
 */
import { describe, expect, it } from 'vitest';
import { closestCorners, getFirstCollision, pointerWithin, type CollisionDetection } from '@dnd-kit/core';
import { columnDroppableId, detectDropCollision } from '../lib/dnd';

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left, top, right, bottom, width: right - left, height: bottom - top,
});

type CollisionArgs = Parameters<CollisionDetection>[0];

/** 构造 dnd-kit 碰撞检测入参（只填碰撞函数真正读取的字段） */
function makeArgs(input: {
  activeId: string;
  collisionRect: Box;
  droppables: Array<{ id: string; rect: Box }>;
  pointer: { x: number; y: number } | null;
}): CollisionArgs {
  const rects = new Map(input.droppables.map((item) => [item.id, item.rect]));
  return {
    active: { id: input.activeId, data: { current: undefined }, rect: { current: undefined } },
    collisionRect: input.collisionRect,
    droppableRects: rects,
    droppableContainers: input.droppables.map((item) => ({
      id: item.id,
      data: { current: undefined },
      disabled: false,
      node: { current: null },
      rect: { current: item.rect },
    })),
    pointerCoordinates: input.pointer,
  } as unknown as CollisionArgs;
}

const emptyClosedColumnDrop = makeArgs({
  activeId: 'card-x',
  // 抓卡片中心 (676,284) 拖到 (944,210) 后的浮层位置
  collisionRect: box(828, 175, 1060, 245),
  droppables: [
    { id: columnDroppableId('待规划'), rect: box(20, 168, 260, 838) },
    { id: columnDroppableId('进行中'), rect: box(288, 168, 528, 838) },
    { id: columnDroppableId('待验收'), rect: box(556, 168, 796, 838) },
    { id: columnDroppableId('已关闭'), rect: box(824, 168, 1064, 838) },
    { id: 'card-x', rect: box(560, 249, 792, 319) },
    { id: 'card-z', rect: box(560, 327, 792, 396) },
  ],
  pointer: { x: 944, y: 210 },
});

describe('detectDropCollision（检索态空列投放）', () => {
  it('先证伪：纯 closestCorners 在空列顶部会把投放判给源列卡片', () => {
    const winner = getFirstCollision(closestCorners(emptyClosedColumnDrop), 'id');
    expect(String(winner)).not.toBe(columnDroppableId('已关闭'));
  });

  it('指针落在空的「已关闭」列上 → 解析为列投放（改状态），不是同列排序', () => {
    const winner = getFirstCollision(detectDropCollision(emptyClosedColumnDrop), 'id');
    expect(String(winner)).toBe(columnDroppableId('已关闭'));
    // 与 pointerWithin 结论一致：指针确实在该列内
    expect(pointerWithin(emptyClosedColumnDrop).map((c) => String(c.id)))
      .toContain(columnDroppableId('已关闭'));
  });

  it('指针落在卡片上（卡片也在列内）→ 卡片优先，列内排序语义不变', () => {
    const overCard = makeArgs({
      activeId: 'card-x',
      collisionRect: box(560, 340, 792, 410),
      droppables: [
        { id: columnDroppableId('待验收'), rect: box(556, 168, 796, 838) },
        { id: 'card-x', rect: box(560, 249, 792, 319) },
        { id: 'card-z', rect: box(560, 327, 792, 396) },
      ],
      pointer: { x: 676, y: 375 },
    });
    expect(String(getFirstCollision(detectDropCollision(overCard), 'id'))).toBe('card-z');
  });

  it('被拖拽卡片自身不参与碰撞（否则 over 永远是自己）', () => {
    const overSelf = makeArgs({
      activeId: 'card-x',
      collisionRect: box(560, 249, 792, 319),
      droppables: [
        { id: columnDroppableId('待验收'), rect: box(556, 168, 796, 838) },
        { id: 'card-x', rect: box(560, 249, 792, 319) },
      ],
      pointer: { x: 676, y: 284 },
    });
    expect(String(getFirstCollision(detectDropCollision(overSelf), 'id'))).not.toBe('card-x');
  });

  it('指针不可用（键盘拖拽无 pointerCoordinates）→ 回落 closestCorners', () => {
    const keyboard = makeArgs({
      activeId: 'card-x',
      collisionRect: box(560, 340, 792, 410),
      droppables: [
        { id: columnDroppableId('已关闭'), rect: box(824, 168, 1064, 838) },
        { id: 'card-z', rect: box(560, 327, 792, 396) },
      ],
      pointer: null,
    });
    expect(detectDropCollision(keyboard)).toEqual(closestCorners(keyboard));
  });
});
