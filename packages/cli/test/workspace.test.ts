import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '@agentboard/shared';
import { matchCurrentWorkspace } from '../src/workspace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-workspace-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const workspace = (id: string, path: string): Workspace => ({ id, name: id, path, created_at: 1 });

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
