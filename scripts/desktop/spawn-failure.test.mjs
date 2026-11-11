import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnFailure } from './spawn-failure.mjs';

test('ENOENT 时提示命令不在 PATH，而不是退出码 null', () => {
  assert.equal(spawnFailure('pnpm', { error: { code: 'ENOENT' }, status: null }), 'pnpm 不在 PATH（ENOENT）');
});

test('其它 spawn error 透出 code，不吞真因', () => {
  assert.equal(spawnFailure('pnpm', { error: { code: 'EACCES', message: 'permission denied' }, status: null }), 'pnpm 启动失败：EACCES');
});

test('无 error 且非零退出码保持原有文案', () => {
  assert.equal(spawnFailure('pnpm', { error: null, status: 1 }), 'pnpm 退出码 1');
});

test('成功返回 null，不误报失败', () => {
  assert.equal(spawnFailure('pnpm', { error: null, status: 0 }), null);
});
