import { describe, expect, it } from 'vitest';
import { parseDue } from '../src/commands/createIssue.js';

/** DUE-DATE：`kb create-issue --due` 的解析（YYYY-MM-DD / YYYY-MM-DDTHH:mm） */
describe('parseDue（--due 解析）', () => {
  it('只有日期：YYYY-MM-DD → { due_date }', () => {
    expect(parseDue('2026-11-10')).toEqual({ due_date: '2026-11-10' });
    expect(parseDue(' 2026-11-10 ')).toEqual({ due_date: '2026-11-10' });
  });

  it('日期+时间：YYYY-MM-DDTHH:mm → { due_date, due_time }', () => {
    expect(parseDue('2026-11-10T14:30')).toEqual({ due_date: '2026-11-10', due_time: '14:30' });
    expect(parseDue('2026-01-02T00:00')).toEqual({ due_date: '2026-01-02', due_time: '00:00' });
    expect(parseDue('2026-01-02T23:59')).toEqual({ due_date: '2026-01-02', due_time: '23:59' });
  });

  it('非法格式与无效日期直接报错（不发请求）', () => {
    expect(() => parseDue('2026/11/10')).toThrow(/YYYY-MM-DD/);
    expect(() => parseDue('2026-11-10 14:30')).toThrow(/YYYY-MM-DD/);
    expect(() => parseDue('2026-11-10T14')).toThrow(/YYYY-MM-DD/);
    expect(() => parseDue('2026-02-30')).toThrow(/有效日期/);
    expect(() => parseDue('2026-11-10T24:00')).toThrow(/有效日期/);
    expect(() => parseDue('')).toThrow(/YYYY-MM-DD/);
  });
});
