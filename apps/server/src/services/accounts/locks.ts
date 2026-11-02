import { ValidationError } from '../../errors.js';
const locks = new Map<string, Promise<void>>();

function assertScope(scope: string, key: string): string {
  if (!scope || !key || scope.includes('\0') || key.includes('\0') || scope.length > 100 || key.length > 500) throw new ValidationError('操作锁范围不合法');
  return `${scope}\0${key}`;
}

export async function withAccountLock<T>(scope: string, key: string, run: () => Promise<T>): Promise<T> {
  const id = assertScope(scope, key);
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; }); locks.set(id, current);
  await previous;
  try { return await run(); } finally { release(); if (locks.get(id) === current) locks.delete(id); }
}

/** 非阻塞版本：同 key 已被占用时立即返回 null，不排队（批量签到逐账号记录 ACCOUNT_BUSY 用） */
export async function tryWithAccountLock<T>(scope: string, key: string, run: () => Promise<T>): Promise<T | null> {
  const id = assertScope(scope, key);
  if (locks.has(id)) return null;
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; }); locks.set(id, current);
  try { return await run(); } finally { release(); if (locks.get(id) === current) locks.delete(id); }
}
