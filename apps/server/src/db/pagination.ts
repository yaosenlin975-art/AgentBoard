import { textWindow as sharedTextWindow, type PageResult, type TextWindow } from '@agentboard/shared';
import { ValidationError } from '../errors.js';
export function validatePage(limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new ValidationError('分页参数不合法');
}
export function pageResult<T>(rows: T[], limit: number, offset: number): PageResult<T> {
  return { items: rows.slice(0, limit), next_offset: rows.length > limit ? offset + limit : null };
}
export function textWindow(text: string, offset = 0, max = 12000): TextWindow {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 1 || max > 40000) throw new ValidationError('正文窗口参数不合法');
  return sharedTextWindow(text, offset, max);
}
