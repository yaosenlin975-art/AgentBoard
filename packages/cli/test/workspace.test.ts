import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '@agentboard/shared';
import { describeError } from '../src/errors.js';
import { matchCurrentWorkspace, matchWorkspace } from '../src/workspace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-workspace-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const workspace = (id: string, path: string): Workspace => ({ id, name: id, path, created_at: 1 });

describe('matchWorkspace（CLI-WS-REF：id / 名称 / ≥8 位唯一前缀）', () => {
  const frontend = workspace('e41eb0fb-c367-43cf-a99d-6dc5239a5694', 'D:/ws/frontend');
  const backend = workspace('ae0e673c-91da-4fbc-8d96-bbd56aa58573', 'D:/ws/backend');

  it('完整 id / 名称 / ≥8 位唯一前缀都能命中', () => {
    expect(matchWorkspace([frontend, backend], frontend.id).id).toBe(frontend.id);
    expect(matchWorkspace([frontend, backend], 'e41eb0fb').id).toBe(frontend.id);
    expect(matchWorkspace([frontend, backend], 'E41EB0FB').id).toBe(frontend.id);
    expect(matchWorkspace([frontend, backend], 'ae0e673c-91da').id).toBe(backend.id);
  });

  it('前缀多命中 → exit 2 并列出全部候选', () => {
    const twin = workspace('e41eb0fb-0000-4000-8000-000000000000', 'D:/ws/twin');
    let caught: unknown;
    try {
      matchWorkspace([frontend, twin], 'e41eb0fb');
    } catch (error) {
      caught = error;
    }
    const described = describeError(caught);
    expect(described.exitCode).toBe(2);
    expect(described.code).toBe('AMBIGUOUS_WORKSPACE_REF');
    expect(described.message).toContain(frontend.id);
    expect(described.message).toContain(twin.id);
  });

  it('不足 8 位或不存在 → exit 1，文案含可用形式与现有候选', () => {
    let shortError: unknown;
    try {
      matchWorkspace([frontend, backend], 'e41eb0f');
    } catch (error) {
      shortError = error;
    }
    expect(describeError(shortError).exitCode).toBe(1);
    expect((shortError as Error).message).toContain('可用完整 id');
    expect((shortError as Error).message).toContain('不足 8 位');

    let missingError: unknown;
    try {
      matchWorkspace([frontend, backend], 'ffffffff');
    } catch (error) {
      missingError = error;
    }
    expect(describeError(missingError).exitCode).toBe(1);
    expect((missingError as Error).message).toContain('可用完整 id');
    expect((missingError as Error).message).toContain('现有工作空间：e41eb0fb');
  });
});

describe('matchCurrentWorkspace', () => {
  it('prefers one exact root and resolves one path-segment descendant', () => {
    const parent = join(root, 'project');
    const child = join(parent, 'nested');
    mkdirSync(child, { recursive: true });
    const parentSpace = workspace('parent', parent);
    const childSpace = workspace('child', child);

    expect(matchCurrentWorkspace([parentSpace, childSpace], child)).toBe(childSpace);
    expect(matchCurrentWorkspace([parentSpace], join(parent, 'nested'))).toBe(parentSpace);
  });

  it('rejects multiple nested or duplicate-root matches', () => {
    const parent = join(root, 'project');
    const child = join(parent, 'nested');
    const below = join(child, 'src');
    mkdirSync(below, { recursive: true });

    expect(() => matchCurrentWorkspace([workspace('parent', parent), workspace('child', child)], below))
      .toThrow('当前目录匹配多个工作区');
    expect(() => matchCurrentWorkspace([workspace('one', parent), workspace('two', parent)], parent))
      .toThrow('当前目录匹配多个工作区');
  });

  it('does not match a sibling that only shares a string prefix', () => {
    const project = join(root, 'app');
    const sibling = join(root, 'application');
    mkdirSync(project);
    mkdirSync(sibling);

    expect(() => matchCurrentWorkspace([workspace('app', project)], sibling)).toThrow('--workspace');
  });

  it('requires --workspace when no registered root has a comparable local path', () => {
    mkdirSync(join(root, 'cwd'));
    expect(() => matchCurrentWorkspace([workspace('remote', 'Z:/remote/project')], join(root, 'cwd')))
      .toThrow('--workspace');
    expect(() => matchCurrentWorkspace([workspace('missing-cwd', root)], join(root, 'missing')))
      .toThrow('--workspace');
  });

  it.skipIf(process.platform !== 'win32')('resolves Windows case and separator variants', () => {
    const project = join(root, 'project');
    mkdirSync(project);
    const variant = project.replace(/\\/g, '/').toUpperCase();
    expect(matchCurrentWorkspace([workspace('project', project)], variant).id).toBe('project');
  });
});
