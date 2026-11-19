#!/usr/bin/env node
/**
 * Agent 上下文预算门禁：真实读取 MCP tools/list，并检查技能入口与按需参考文件的体积。
 *
 * 用法：
 *   node scripts/check-agent-context.mjs
 *   node scripts/check-agent-context.mjs --self-test
 *
 * 默认不依赖 tokenizer；UTF-8 bytes / JS chars 是稳定的回归代理。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');
const BASELINE_PATH = join(ROOT, 'scripts', 'agent-context-baseline.json');
const ENTRY_MAX_CHARS = 12_000;
const REFERENCE_MAX_CHARS = 20_000;
const MCP_LIST_MAX_BYTES = 140_000;
const selfTest = process.argv.includes('--self-test');

function compareIssues(items, key, label, max) {
  return items
    .filter((item) => item[key] > max)
    .map((item) => `${label}超限：${item.path} ${item[key]} > ${max}`);
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : entry.isFile() ? [full] : [];
  });
}

function readSkillSnapshot(root) {
  const skillsRoot = join(root, 'skills');
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const skillDir = join(skillsRoot, entry.name);
      const skillPath = join(skillDir, 'SKILL.md');
      const text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
      const references = walkFiles(join(skillDir, 'references'))
        .filter((file) => file.endsWith('.md'))
        .map((file) => {
          const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
          return {
            path: relative(root, file).split('\\').join('/'),
            chars: content.length,
            bytes: Buffer.byteLength(content),
          };
        });
      return {
        name: entry.name,
        path: relative(root, skillPath).split('\\').join('/'),
        chars: text.length,
        bytes: Buffer.byteLength(text),
        references,
      };
    });
}

function routeReferences(root, skill) {
  const text = readFileSync(join(root, skill.path), 'utf8');
  return [...new Set(text.match(/(?:\.\.\/[A-Za-z0-9._-]+\/)?references\/[A-Za-z0-9._/-]+\.md/g) ?? [])];
}

function checkSkills(root, baseline) {
  const skills = readSkillSnapshot(root);
  const issues = [];
  const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));

  issues.push(...compareIssues(skills, 'chars', '技能入口', ENTRY_MAX_CHARS));
  issues.push(...skills.flatMap((skill) => compareIssues(skill.references, 'chars', '参考文件', REFERENCE_MAX_CHARS)));

  for (const skill of skills) {
    for (const ref of routeReferences(root, skill)) {
      if (!existsSync(resolve(root, dirname(skill.path), ref))) issues.push(`引用缺失：${skill.path} -> ${ref}`);
    }
  }

  const using = byName['using-agentboard'];
  if (using && using.chars > Math.floor(baseline.skills['using-agentboard'] * 0.4)) {
    issues.push(`using-agentboard 降幅不足：${using.chars} > ${Math.floor(baseline.skills['using-agentboard'] * 0.4)}`);
  }
  const executing = byName['executing-task'];
  if (using && executing) {
    const comboMax = Math.floor((baseline.skills['using-agentboard'] + baseline.skills['executing-task']) * 0.5);
    if (using.chars + executing.chars > comboMax) {
      issues.push(`高频技能组合降幅不足：${using.chars + executing.chars} > ${comboMax}`);
    }
  }
  return { skills, issues };
}

function collectMcpToolsList(root) {
  const entry = join(root, 'apps', 'mcp', 'dist', 'index.js');
  if (!existsSync(entry)) throw new Error(`MCP 构建缺失：${entry}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pending = new Map();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP tools/list 超时（60000ms）'));
    }, 60_000);
    let nextId = 1;
    let buffer = '';
    let stderr = '';
    const finish = (error, value) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolvePromise(value);
    };
    const request = (method, params) => new Promise((resolveRequest) => {
      const id = nextId++;
      pending.set(id, resolveRequest);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`MCP stdout 非 JSON-RPC：${line.slice(0, 200)}`));
          return;
        }
        const done = pending.get(message.id);
        if (done) {
          pending.delete(message.id);
          done(message);
        }
      }
    });
    child.on('exit', (code) => {
      if (pending.size > 0) finish(new Error(`MCP 提前退出（code=${code}）${stderr ? `：${stderr.trim()}` : ''}`));
    });
    (async () => {
      const init = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agentboard-context-budget', version: '1.0.0' },
      });
      if (init.error) throw new Error(`MCP initialize 失败：${JSON.stringify(init.error)}`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      const listed = await request('tools/list', {});
      if (listed.error) throw new Error(`MCP tools/list 失败：${JSON.stringify(listed.error)}`);
      const json = JSON.stringify(listed.result);
      finish(null, {
        bytes: Buffer.byteLength(json),
        chars: json.length,
        tools: listed.result?.tools?.length ?? 0,
        primary: (listed.result?.tools ?? []).filter((tool) => !String(tool.name).startsWith('agentboard_')).length,
      });
    })().catch((error) => finish(error));
  });
}

function runSelfTest() {
  const fixture = mkdtempSync(join(tmpdir(), 'agentboard-context-'));
  try {
    const skillDir = join(fixture, 'skills', 'oversized');
    const linkedDir = join(fixture, 'skills', 'linked');
    const referenceDir = join(fixture, 'skills', 'base', 'references');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(linkedDir, { recursive: true });
    mkdirSync(referenceDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'x'.repeat(ENTRY_MAX_CHARS + 1), { encoding: 'utf8', flag: 'w' });
    writeFileSync(join(linkedDir, 'SKILL.md'), '[base](../base/references/shared.md)\n', 'utf8');
    writeFileSync(join(referenceDir, 'shared.md'), '# shared\n', 'utf8');
    const issues = compareIssues(readSkillSnapshot(fixture), 'chars', '技能入口', ENTRY_MAX_CHARS);
    if (issues.length === 0) throw new Error('self-test 未识别超限 fixture');
    const linked = readSkillSnapshot(fixture).find((skill) => skill.name === 'linked');
    const [ref] = routeReferences(fixture, linked);
    if (!ref || !existsSync(resolve(fixture, dirname(linked.path), ref))) throw new Error('self-test 跨技能引用解析失败');
    console.log(JSON.stringify({ ok: true, self_test: ['oversized-entry-detected', 'cross-skill-reference-resolved'], issues }, null, 2));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (selfTest) {
  try {
    runSelfTest();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  try {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const { skills, issues } = checkSkills(ROOT, baseline);
    const mcp = await collectMcpToolsList(ROOT);
    if (mcp.bytes > MCP_LIST_MAX_BYTES) issues.push(`MCP tools/list 超限：${mcp.bytes} > ${MCP_LIST_MAX_BYTES}`);
    const totalEntryChars = skills.reduce((sum, skill) => sum + skill.chars, 0);
    const report = { ok: issues.length === 0, limits: { entryChars: ENTRY_MAX_CHARS, referenceChars: REFERENCE_MAX_CHARS, mcpListBytes: MCP_LIST_MAX_BYTES }, totalEntryChars, skills, mcp, issues };
    console.log(JSON.stringify(report, null, 2));
    if (issues.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
