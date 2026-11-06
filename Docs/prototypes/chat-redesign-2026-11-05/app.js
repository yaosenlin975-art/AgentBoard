/*
 * AgentBoard 聊天界面改造原型 · 交互脚本（纯 vanilla，无构建依赖）
 *
 * 演示范围：
 * ① 计划条（一轮一条、常驻、可展开步骤）
 * ② 工具结果卡（输出摘要/成功失败/耗时 + 按文件折叠的 diff + 在 git 里看）
 * ③ 危险操作三档确认（仅本次 / 本任务 / 本工作区）
 * ④ 长任务阻塞态（awaiting_input，回答后继续同一轮）
 * ⑤ 会话侧栏（搜索 / 重命名 / 归档 / 分叉），保留 AUDIT-3 的两行条目结构
 * 另含：单步重试、草稿持久化、token/费用/上下文脚注。
 *
 * 为了便于 jsdom 断言，状态与动作挂在 window.__proto 上（仅原型，不进产品）。
 */
(() => {
  'use strict';

  const STORE_KEY = 'ab.chat.redesign.v1';

  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const STEP_TITLES = [
    '读取会话历史与工作区状态',
    '定位消息渲染与事件聚合代码',
    '修改 MessageList：计划条与工具卡',
    '运行前端测试（chat.test.tsx）',
    '汇总改动并给出验收说明',
  ];

  const DONE_TURN = () => {
    const turn = freshTurn();
    turn.plan.forEach((step) => { step.state = 'done'; });
    turn.current = turn.plan.length;
    turn.state = 'done';
    turn.executed = turn.plan.map((s) => s.id);
    turn.attemptedS4 = true;
    turn.tools = [cloneCard(DIFF_CARD), cloneCard(TEST_OK_CARD)];
    turn.usage = { tokens: 18600, cost: 0.027, context: 41 };
    return turn;
  };

  const DIFF_CARD = {
    id: 'tool-diff',
    tool: 'Edit',
    status: 'ok',
    duration: '2.4s',
    summary: '更新 3 处：新增计划条、工具结果分组、默认折叠；未推翻既有消息结构',
    open: false,
    output: [],
    files: [
      {
        path: 'apps/web/src/components/chat/MessageList.tsx',
        add: 18,
        del: 4,
        open: false,
        lines: [
          { t: 'ctx', text: '@@ -1,6 +1,9 @@' },
          { t: 'del', text: "-import { useEffect, useRef } from 'react';" },
          { t: 'add', text: "+import { useEffect, useRef, useState } from 'react';" },
          { t: 'add', text: "+import { PlanBar } from './PlanBar';" },
          { t: 'ctx', text: ' export function MessageList({ messages, streaming, running, onRetry, ... }) {' },
          { t: 'add', text: '+  <PlanBar steps={turn.plan} state={turn.state} current={turn.current} />' },
          { t: 'ctx', text: '   const rows = [];' },
          { t: 'add', text: '+  <ToolResultCards items={turn.tools} onRetryStep={onRetryStep} />' },
          { t: 'del', text: '-  tools.map((m) => <EventBlock key={m.id} message={m} />)' },
          { t: 'add', text: '+  <EventGroup messages={folded} defaultOpen={false} />' },
        ],
      },
      {
        path: 'apps/web/src/components/chat/ChatPanel.tsx',
        add: 6,
        del: 2,
        open: false,
        lines: [
          { t: 'ctx', text: '@@ -104,7 +106,11 @@' },
          { t: 'add', text: '+  // awaiting_input 仍属同一轮：session.status 保持「运行中」，停止按钮继续可见' },
          { t: 'add', text: '+  const turnState = useTurnState(session.id);' },
          { t: 'del', text: "-  const running = session.status === '运行中';" },
          { t: 'add', text: "+  const running = session.status === '运行中' || turnState !== null;" },
          { t: 'ctx', text: '   <MessageList … />' },
        ],
      },
    ],
  };

  const TEST_OK_CARD = {
    id: 'tool-test',
    tool: 'Bash',
    status: 'ok',
    duration: '6.1s',
    summary: 'vitest run chat.test.tsx · 18 passed（仅重跑第 4 步）',
    open: false,
    files: [],
    output: ['Test Files  1 passed (1)', 'Tests       18 passed (18)', 'Duration    6.10s'],
  };

  function cloneCard(card) {
    return JSON.parse(JSON.stringify(card));
  }

  const SEED_SESSIONS = [
    { id: 's1', title: 'STORE-1 会话存储下沉', issue: '#20f6e87d', cli: 'dsh', model: 'DeepSeek-V4', status: '运行中', unread: 0, ago: '4 分钟前', archived: false, forkedFrom: null },
    { id: 's2', title: '批量退回待规划 · 前端卡', issue: '#c3e6cff8', cli: 'dsh', model: 'DeepSeek-V4', status: '已结束', unread: 3, ago: '1 小时前', archived: false, forkedFrom: null },
    { id: 's3', title: '自由会话 · dsh · DeepSeek', issue: null, cli: 'dsh', model: 'DeepSeek-V4', status: '已结束', unread: 0, ago: '昨天 18:20', archived: false, forkedFrom: null },
    { id: 's4', title: '证据核对：GLM 401', issue: '#5ab1d11a', cli: 'dsh', model: 'GLM-4.6', status: '失败', unread: 0, ago: '2 天前', archived: false, forkedFrom: null },
    { id: 's5', title: '知识库分类回填讨论', issue: null, cli: 'dsh', model: 'DeepSeek-V4', status: '已结束', unread: 0, ago: '3 天前', archived: true, forkedFrom: null },
    { id: 's6', title: '账号面板视觉评审', issue: '#6549eb8d', cli: 'dsh', model: 'GLM-4.6', status: '已结束', unread: 0, ago: '4 天前', archived: true, forkedFrom: null },
  ];

  function freshTurn() {
    return {
      id: 'turn-' + Date.now(),
      owner: 's1',
      state: 'running',
      current: 0,
      plan: STEP_TITLES.map((title, i) => ({ id: 's' + (i + 1), title, state: i === 0 ? 'running' : 'pending' })),
      executed: [],
      tools: [],
      question: null,
      approvals: [],
      attemptedS4: false,
      usage: { tokens: 4200, cost: 0.006, context: 16 },
    };
  }

  function defaultState() {
    return {
      theme: 'light',
      sessions: SEED_SESSIONS.map((s) => ({ ...s })),
      activeId: 's1',
      search: '',
      archivedOpen: false,
      menuId: null,
      headMenuOpen: false,
      renamingId: null,
      confirmDeleteId: null,
      draft: '',
      userMessage: '把聊天面板的计划条、工具结果和危险操作确认改造一下，别推翻现有消息结构。',
      turn: DONE_TURN(),
      planOpen: false,
      foldOpen: false,
      approval: null,
      autoArchived: false,
    };
  }

  let state = defaultState();

  /* ── 持久化（模拟刷新只恢复草稿与会话列表，与真实实现一致：草稿 localStorage） ── */
  function persist() {
    try {
      const payload = {
        sessions: state.sessions,
        activeId: state.activeId,
        draft: state.draft,
        userMessage: state.userMessage,
        theme: state.theme,
        turn: state.turn,
        planOpen: state.planOpen,
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch {
      /* 隐私模式等：忽略 */
    }
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /* ── 渲染 ─────────────────────────────────────────────── */
  const rail = document.getElementById('rail');

  function activeSession() {
    return state.sessions.find((s) => s.id === state.activeId) ?? null;
  }

  function matchesSearch(session) {
    const q = state.search.trim().toLowerCase();
    if (q === '') return true;
    const haystack = [session.title, session.issue ?? '', session.model, session.cli, session.forkedFrom ?? ''].join(' ').toLowerCase();
    return haystack.includes(q);
  }

  function sessionRow(session, archivedView) {
    const active = session.id === state.activeId;
    const renaming = state.renamingId === session.id;
    const confirming = state.confirmDeleteId === session.id;
    const metaParts = [];
    if (session.issue !== null) metaParts.push(session.issue);
    else metaParts.push('自由会话');
    if (session.forkedFrom !== null) metaParts.push('分叉自 ' + session.forkedFrom);
    metaParts.push(session.ago);

    if (renaming) {
      return `
        <li class="srow${active ? ' active' : ''}" data-testid="session-row-${esc(session.id)}">
          <div class="rename-box">
            <input data-role="rename-input" data-id="${esc(session.id)}" aria-label="会话标题" value="${esc(session.title)}" />
            <button type="button" data-act="rename-commit" data-id="${esc(session.id)}">保存</button>
            <button type="button" data-act="rename-cancel" data-id="${esc(session.id)}">取消</button>
          </div>
        </li>`;
    }

    if (confirming) {
      return `
        <li class="srow${active ? ' active' : ''}" data-testid="session-row-${esc(session.id)}">
          <div class="confirm-box">
            <span class="smeta">删除该会话及其消息？</span>
            <button type="button" class="danger" data-act="delete-confirm" data-id="${esc(session.id)}">确认删除</button>
            <button type="button" data-act="delete-cancel" data-id="${esc(session.id)}">取消</button>
          </div>
        </li>`;
    }

    const menuOpen = state.menuId === session.id;
    return `
      <li class="srow${active ? ' active' : ''}" data-testid="session-row-${esc(session.id)}">
        <button type="button" class="srow-main" data-act="session-select" data-id="${esc(session.id)}" ${active ? 'aria-current="true"' : ''}>
          <span class="stitle">
            <span class="label" title="${esc(session.title)}">${esc(session.title)}</span>
            ${session.status === '运行中' ? '<span class="dot running" title="运行中" aria-label="运行中"></span>' : ''}
            ${session.status === '失败' ? '<span class="dot failed" title="失败" aria-label="失败"></span>' : ''}
            ${session.unread > 0 ? `<span class="unread" title="${session.unread} 条新消息">${session.unread}</span>` : ''}
          </span>
          <span class="smeta" data-testid="session-meta-${esc(session.id)}">
            ${session.forkedFrom !== null ? '<span class="fork">⎇</span> ' : ''}${esc(metaParts.join(' · '))}
          </span>
        </button>
        <button type="button" class="row-more" data-act="session-menu" data-id="${esc(session.id)}"
          aria-label="会话操作" aria-haspopup="menu" aria-expanded="${menuOpen}">⋯</button>
        ${menuOpen ? `
          <div class="row-menu" role="menu" data-testid="session-menu-${esc(session.id)}">
            <button type="button" role="menuitem" data-act="rename" data-id="${esc(session.id)}">重命名</button>
            <button type="button" role="menuitem" data-act="fork" data-id="${esc(session.id)}">分叉会话</button>
            <button type="button" role="menuitem" data-act="${archivedView ? 'unarchive' : 'archive'}" data-id="${esc(session.id)}">
              ${archivedView ? '取消归档' : '归档'}
            </button>
            <button type="button" role="menuitem" class="danger" data-act="delete" data-id="${esc(session.id)}">删除</button>
          </div>` : ''}
      </li>`;
  }

  function renderRailList() {
    const list = document.getElementById('railList');
    if (list === null) return;
    const visible = state.sessions.filter(matchesSearch);
    const activeSessions = visible.filter((s) => !s.archived);
    const archivedSessions = visible.filter((s) => s.archived);
    const taskGroup = activeSessions.filter((s) => s.issue !== null);
    const freeGroup = activeSessions.filter((s) => s.issue === null);

    let html = '';
    if (activeSessions.length === 0 && archivedSessions.length === 0) {
      html = `<div class="thread-empty" data-testid="session-search-empty">没有匹配的会话</div>`;
    } else {
      html += `<div class="group-label">任务看板</div>`;
      html += `<ul role="list">${taskGroup.map((s) => sessionRow(s, false)).join('')}</ul>`;
      if (freeGroup.length > 0) {
        html += `<div class="group-label">无任务会话</div>`;
        html += `<ul role="list">${freeGroup.map((s) => sessionRow(s, false)).join('')}</ul>`;
      }
      if (archivedSessions.length > 0) {
        html += `
          <div class="group-label">
            <button type="button" data-act="toggle-archived" data-testid="archived-toggle" aria-expanded="${state.archivedOpen}">
              已归档 ${archivedSessions.length} ${state.archivedOpen ? '▾' : '▸'}
            </button>
          </div>`;
        if (state.archivedOpen) {
          html += `<ul role="list" data-testid="archived-list">${archivedSessions.map((s) => sessionRow(s, true)).join('')}</ul>`;
        }
      }
    }
    list.innerHTML = html;
    const count = document.getElementById('railCount');
    if (count !== null) {
      const shown = activeSessions.length;
      const total = state.sessions.filter((s) => !s.archived).length;
      count.textContent = state.search.trim() === '' ? `${total} 个会话` : `${shown} / ${total}`;
    }
  }

  function renderRail() {
    rail.innerHTML = `
      <div class="rail-head">
        <div class="rail-title-row">
          <span class="rail-title">会话</span>
          <span class="rail-count" id="railCount"></span>
        </div>
        <input class="search-input" type="search" data-role="session-search" data-testid="session-search"
          aria-label="搜索会话" placeholder="搜索标题、任务号或模型" value="${esc(state.search)}" />
        <button type="button" class="new-btn" data-act="new-session" data-testid="new-session">＋ 新建会话</button>
      </div>
      <div class="rail-list" id="railList"></div>`;
    renderRailList();
  }

  function usageText(usage) {
    const tokens = usage.tokens >= 1000 ? (usage.tokens / 1000).toFixed(1) + 'k' : String(usage.tokens);
    return `本轮 ${tokens} tokens · 估算 ¥${usage.cost.toFixed(3)} · 上下文 ${usage.context}%`;
  }

  function renderHead() {
    const head = document.getElementById('chatHead');
    const session = activeSession();
    if (session === null) {
      head.innerHTML = '';
      return;
    }
    const turn = state.turn !== null && state.turn.owner === session.id ? state.turn : null;
    const busy = turn !== null && ['running', 'awaiting_input', 'awaiting_approval', 'failed'].includes(turn.state);
    head.innerHTML = `
      <div class="head-line">
        <span class="head-title" data-testid="chat-session-title" title="${esc(session.title)}">${esc(session.title)}</span>
        ${session.forkedFrom !== null ? `<span class="chip fork" data-testid="fork-badge">⎇ 分叉自 ${esc(session.forkedFrom)}</span>` : ''}
        <span class="head-spacer">
          ${busy ? `<button type="button" class="icon-btn danger" data-act="stop" data-testid="stop-btn">停止</button>` : ''}
          <button type="button" class="more-btn" data-act="head-menu" aria-label="会话操作" aria-haspopup="menu"
            aria-expanded="${state.headMenuOpen}">⋯</button>
        </span>
      </div>
      <div class="head-meta">
        <span class="chip neutral">任务看板</span>
        ${session.issue !== null ? `<span>${esc(session.issue)}</span>` : '<span>自由会话</span>'}
        <span class="chip neutral">${esc(session.cli)} · ${esc(session.model)}</span>
        <span>${esc(session.ago)}</span>
      </div>
      ${state.headMenuOpen ? `
        <div class="head-menu" role="menu" data-testid="head-menu">
          <button type="button" role="menuitem" data-act="approval-rules">审批规则（工作区 2 条）</button>
          <button type="button" role="menuitem" data-act="head-fork" data-id="${esc(session.id)}">分叉此会话</button>
          <button type="button" role="menuitem" data-act="head-rename" data-id="${esc(session.id)}">重命名</button>
          <button type="button" role="menuitem" data-act="archive" data-id="${esc(session.id)}">归档</button>
        </div>` : ''}`;
  }

  function planChip(turnState) {
    const map = {
      running: ['运行中', 'accent'],
      awaiting_input: ['等待回答', 'accent'],
      awaiting_approval: ['等待授权', 'accent'],
      failed: ['已失败', 'danger'],
      done: ['已完成', 'neutral'],
      stopped: ['已停止', 'neutral'],
    };
    const [label, cls] = map[turnState] ?? ['进行中', 'neutral'];
    return `<span class="chip ${cls}" data-testid="plan-status">${label}</span>`;
  }

  function stepMark(stepState) {
    return { done: '✓', running: '●', failed: '✕', awaiting: '‖', pending: '○' }[stepState] ?? '○';
  }

  function renderPlanBar(turn) {
    const done = turn.plan.filter((s) => s.state === 'done').length;
    const current = turn.plan[Math.min(turn.current, turn.plan.length - 1)] ?? null;
    let what = '';
    if (turn.state === 'done') what = '全部步骤已完成 · 可复制验收结论';
    else if (turn.state === 'failed') what = `失败于第 ${turn.current + 1} 步 · ${current?.title ?? ''}`;
    else if (turn.state === 'awaiting_input') what = `等待你的回答 · ${current?.title ?? ''}`;
    else if (turn.state === 'awaiting_approval') what = `等待危险操作授权 · ${current?.title ?? ''}`;
    else if (turn.state === 'stopped') what = '已停止 · 已完成步骤保留';
    else what = `正在执行：${current?.title ?? '准备中'}`;

    const dots = turn.plan
      .map((s) => `<span class="plan-dot ${s.state}"></span>`)
      .join('');

    return `
      <button type="button" class="planbar" data-act="toggle-plan" data-testid="plan-bar"
        aria-expanded="${state.planOpen}" aria-label="本轮计划进度">
        <span class="plan-dots" aria-hidden="true">${dots}</span>
        <span class="plan-count" data-testid="plan-count">${done}/${turn.plan.length}</span>
        <span class="plan-what" data-testid="plan-what">${esc(what)}</span>
        ${planChip(turn.state)}
        <span class="plan-chev" aria-hidden="true">${state.planOpen ? '▴' : '▾'}</span>
      </button>
      ${state.planOpen ? `
        <div class="plan-steps" data-testid="plan-steps" role="list" aria-label="计划步骤">
          ${turn.plan.map((step, i) => `
            <div class="plan-step ${i === turn.current ? 'current' : ''}" role="listitem">
              <span class="mark ${step.state}" aria-hidden="true">${stepMark(step.state)}</span>
              <span>第 ${i + 1} 步 · ${esc(step.title)}</span>
              <span class="plan-chev">${step.state === 'done' ? '已完成' : step.state === 'failed' ? '失败' : step.state === 'awaiting' ? '等待回答' : step.state === 'running' ? '执行中' : '待执行'}</span>
            </div>`).join('')}
        </div>` : ''}`;
  }

  function renderFoldGroup(turn) {
    const toolCount = turn.tools.length + (turn.plan.some((s) => s.state === 'failed') ? 1 : 0);
    return `
      <div class="fold">
        <button type="button" class="fold-head" data-act="toggle-fold" data-testid="fold-head" aria-expanded="${state.foldOpen}">
          ${state.foldOpen ? '▾' : '▸'} 思考 8 段 · 工具 ${Math.max(toolCount, 12)} 次 · 明细默认折叠
        </button>
        ${state.foldOpen ? `
          <div class="fold-body" data-testid="fold-body">
            <div class="fold-row">思考 · 计划条一轮一条，避免全局计划跨会话污染</div>
            <div class="fold-row">工具 Read · apps/web/src/components/chat/MessageList.tsx</div>
            <div class="fold-row">工具 Grep · \"turn\" / \"plan\"（仅展示计数，不铺时间线）</div>
          </div>` : ''}
      </div>`;
  }

  function renderToolCard(card) {
    const mark = card.status === 'ok' ? '✓' : '✕';
    const bodyOpen = card.open;
    return `
      <div class="tool-card${card.status === 'ok' ? '' : ' failed'}" data-testid="tool-card-${esc(card.id)}">
        <button type="button" class="tool-head" data-act="toggle-tool" data-id="${esc(card.id)}" aria-expanded="${bodyOpen}">
          <span class="tool-mark ${card.status}" aria-hidden="true">${mark}</span>
          <span class="tool-name">${esc(card.tool)}</span>
          <span class="tool-dur">${esc(card.duration)}</span>
          <span class="tool-sum" data-testid="tool-summary-${esc(card.id)}">${esc(card.summary)}</span>
          <span class="tool-chev" aria-hidden="true">${bodyOpen ? '▴' : '▾'}</span>
        </button>
        ${bodyOpen ? `
          <div class="tool-body" data-testid="tool-body-${esc(card.id)}">
            ${card.output.length > 0 ? `<pre class="diff">${card.output.map((line) => `<span class="ln ctx">${esc(line)}</span>`).join('')}</pre>` : ''}
            ${card.files.map((file, index) => `
              <div class="file" data-file="${esc(file.path)}">
                <button type="button" class="file-head" data-act="toggle-file" data-card="${esc(card.id)}" data-index="${index}" aria-expanded="${file.open}">
                  <span class="file-path" title="${esc(file.path)}">${esc(file.path)}</span>
                  <span class="stat-add">+${file.add}</span>
                  <span class="stat-del">−${file.del}</span>
                  <span class="tool-chev" aria-hidden="true">${file.open ? '▴' : '▾'}</span>
                </button>
                ${file.open ? `<pre class="diff" data-testid="diff-${esc(card.id)}-${index}">${file.lines.map((line) => `<span class="ln ${line.t}">${esc(line.text)}</span>`).join('')}</pre>` : ''}
              </div>`).join('')}
            <div class="tool-foot">
              <span>输出摘要：${esc(card.summary)}</span>
              <button type="button" class="link-btn" data-act="git-open" data-path="${esc(card.files[0]?.path ?? '')}">在 git 里看 ↗</button>
            </div>
          </div>` : ''}
      </div>`;
  }

  function renderFailBlock(turn) {
    return `
      <div class="fail-block" data-testid="fail-block">
        <div class="fail-line">
          <span class="fail-tag">失败</span>
          <strong>第 ${turn.current + 1} 步 · ${esc(turn.plan[turn.current]?.title ?? '')}</strong>
          <span class="tool-dur">8.2s · 退出码 1</span>
        </div>
        <div class="fail-body">2 个用例未通过 · chat.test.tsx › 计划条 aria-live 播报缺失</div>
        <div class="fail-actions">
          <button type="button" class="btn primary" data-act="retry-step" data-testid="retry-step">重试此步</button>
          <button type="button" class="btn" data-act="view-log">查看完整日志</button>
        </div>
      </div>`;
  }

  function renderQuestion(turn) {
    const q = turn.question;
    if (q === null) return '';
    if (q.answered !== '') {
      return `<div class="answered" data-testid="answered-note">已继续同一轮 · 选择：${esc(q.answered)}</div>`;
    }
    return `
      <div class="await-card" data-testid="await-card">
        <div class="await-title"><span class="dot running" aria-hidden="true"></span>Agent 在等你回答</div>
        <div class="await-q">${esc(q.text)}</div>
        <div class="await-opts" role="group" aria-label="回答选项">
          ${q.options.map((opt) => `<button type="button" class="opt-btn" data-act="answer" data-opt="${esc(opt.id)}" data-testid="answer-${esc(opt.id)}">${esc(opt.label)}</button>`).join('')}
        </div>
        <div class="await-foot">回答后继续同一轮；计划与已完成步骤不会重放。也可以直接在下方输入回答。</div>
      </div>`;
  }

  function renderThread() {
    const thread = document.getElementById('thread');
    const session = activeSession();
    if (session === null) {
      thread.innerHTML = `<div class="thread-empty">在左侧选择一个会话</div>`;
      return;
    }
    const turn = state.turn !== null && state.turn.owner === session.id ? state.turn : null;
    if (turn === null) {
      thread.innerHTML = `<div class="thread-empty" data-testid="thread-empty">该会话暂无演示内容 · 点击顶部「① 开始长任务」回到演示会话</div>`;
      return;
    }
    const approvals = turn.approvals
      .map((a) => `<div class="approval-note" data-testid="approval-note">已授权 · ${esc(a.label)}范围 · ${esc(a.tool)} · 可在 ⋯ → 审批规则 中撤销</div>`)
      .join('');

    thread.innerHTML = `
      <div class="user-msg"><div class="bubble" data-testid="user-bubble">${esc(state.userMessage)}</div></div>
      <section class="turn" data-testid="turn">
        ${renderPlanBar(turn)}
        ${renderFoldGroup(turn)}
        ${turn.tools.map((card) => renderToolCard(card)).join('')}
        ${turn.state === 'failed' ? renderFailBlock(turn) : ''}
        ${renderQuestion(turn)}
        ${approvals}
      </section>`;
  }

  function renderComposer() {
    const hint = document.getElementById('composerHint');
    const flag = document.getElementById('draftFlag');
    const usage = document.getElementById('usageLine');
    const turn = state.turn !== null && activeSession() !== null && state.turn.owner === state.activeId ? state.turn : null;
    const awaiting = turn !== null && turn.state === 'awaiting_input' && turn.question !== null && turn.question.answered === '';
    hint.hidden = !awaiting;
    hint.textContent = awaiting ? 'Agent 在等你回答 · 回答后继续同一轮（停止会丢弃本轮计划）' : '';
    flag.textContent = state.draft.trim() === '' ? '草稿保存在本机' : `草稿已保存 · ${state.draft.trim().length} 字`;
    flag.classList.toggle('saved', state.draft.trim() !== '');
    usage.textContent = usageText(turn !== null ? turn.usage : { tokens: 0, cost: 0, context: 0 });
  }

  function renderModal() {
    const root = document.getElementById('modalRoot');
    if (state.approval === null) {
      root.innerHTML = '';
      return;
    }
    const scopes = [
      { id: 'once', title: '仅本次', desc: '只批准这一次调用；同一工具下次仍会再次询问。不写入任何规则。' },
      { id: 'task', title: '本任务', desc: '批准当前任务下该工具的后续调用，直到任务结束或会话结束。' },
      { id: 'workspace', title: '本工作区', desc: '批准该工作区内所有会话的同类工具调用；跨会话生效，需要撤销入口与审计。' },
    ];
    root.innerHTML = `
      <div class="modal" data-testid="approval-modal">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgTitle" aria-describedby="dlgRisk" data-testid="approval-dialog">
          <div class="dlg-head">
            <span class="chip danger">危险操作</span>
            <h2 id="dlgTitle">需要你确认才能继续</h2>
          </div>
          <p class="dlg-risk" id="dlgRisk">
            工具 <b>Bash</b> 将在工作区执行 <code>git clean -fdx apps/web/dist</code>，
            会删除未跟踪文件且无法撤销。授权范围决定这条规则生效到哪一层。
          </p>
          <div class="scope-list" role="radiogroup" aria-label="授权范围">
            ${scopes.map((scope) => `
              <div class="scope" role="radio" tabindex="0" aria-checked="${state.approval.scope === scope.id}"
                data-act="scope" data-scope="${scope.id}" data-testid="scope-${scope.id}">
                <span class="scope-mark" aria-hidden="true"></span>
                <div><strong>${scope.title}</strong><p>${scope.desc}</p></div>
              </div>`).join('')}
          </div>
          <p class="scope-note">
            本工作区档会写入工作区级审批规则：需要额外的撤销入口、审计记录与跨会话失效策略；
            若本轮只做最小可用，可先上线「仅本次 / 本任务」，把本工作区档置灰并提示原因。
          </p>
          <div class="dlg-foot">
            <button type="button" class="btn" data-act="approve-cancel" data-testid="approve-cancel">拒绝并停止</button>
            <button type="button" class="btn primary" data-act="approve-confirm" data-testid="approve-confirm">允许并继续</button>
          </div>
        </div>
      </div>`;
    const selected = root.querySelector(`[data-scope="${state.approval.scope}"]`);
    if (selected !== null) selected.focus();
  }

  function updateDemoBar() {
    const btn = document.getElementById('demoTurnBtn');
    const turn = state.turn;
    const ownerActive = turn !== null && turn.owner === state.activeId;
    if (ownerActive && turn.state === 'done') btn.textContent = '① 开始长任务';
    else if (ownerActive && turn.state === 'running') btn.textContent = '① 推进下一步';
    else if (ownerActive && turn.state === 'failed') btn.textContent = '① 继续（需先重试）';
    else btn.textContent = '① 开始长任务';
    document.body.dataset.theme = state.theme;
    document.querySelector('[data-act="theme"]').textContent = state.theme === 'light' ? '暗色' : '亮色';
  }

  function renderAll() {
    renderRail();
    renderHead();
    renderThread();
    renderModal();
    renderComposer();
    updateDemoBar();
  }

  function announce(message) {
    const live = document.getElementById('live');
    live.textContent = '';
    window.setTimeout(() => { live.textContent = message; }, 20);
  }

  let toastTimer = 0;
  function toast(message) {
    const root = document.getElementById('toastRoot');
    const node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('data-testid', 'toast');
    node.textContent = message;
    root.appendChild(node);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { node.remove(); }, 2800);
  }

  /* ── 演示动作 ─────────────────────────────────────────── */
  function focusDemoSession() {
    if (state.activeId !== 's1') {
      state.activeId = 's1';
      state.menuId = null;
      state.headMenuOpen = false;
    }
    const s1 = state.sessions.find((s) => s.id === 's1');
    if (s1 !== undefined && s1.archived) s1.archived = false;
  }

  function advanceTurn() {
    focusDemoSession();
    if (state.turn === null) {
      state.turn = freshTurn();
      persist();
      renderAll();
      toast('新一轮开始：第 1 步执行中');
      announce('计划第 1 步，共 5 步');
      return;
    }
    const turn = state.turn;
    if (turn.state === 'done') {
      state.turn = freshTurn();
      state.turn.owner = state.activeId;
      persist();
      renderAll();
      toast('新一轮开始：第 1 步执行中');
      return;
    }
    if (turn.state === 'awaiting_input') { toast('请先回答上方的提问'); return; }
    if (turn.state === 'awaiting_approval') { toast('请先在弹窗中确认危险操作'); return; }
    if (turn.state === 'failed') { toast('第 4 步失败：点「重试此步」只重跑该步，不会整轮重发'); return; }

    const step = turn.plan[turn.current];
    if (step === undefined) return;
    step.state = 'done';
    turn.executed.push(step.id);
    if (step.id === 's3') turn.tools.push(cloneCard(DIFF_CARD));

    const next = turn.current + 1;
    if (next >= turn.plan.length) {
      turn.current = turn.plan.length;
      turn.state = 'done';
      turn.usage = { tokens: 18600, cost: 0.027, context: 41 };
      persist();
      renderAll();
      toast('本轮完成：已完成步骤保留，可直接标记待验收');
      announce('计划已完成，共 5 步');
      return;
    }
    turn.current = next;
    const nextStep = turn.plan[next];
    if (nextStep.id === 's4' && !turn.attemptedS4) {
      turn.attemptedS4 = true;
      nextStep.state = 'failed';
      turn.state = 'failed';
      persist();
      renderAll();
      toast('第 4 步失败：只影响该步，步骤 1–3 的产物保留');
      announce('第 4 步失败，等待重试');
      return;
    }
    nextStep.state = 'running';
    persist();
    renderAll();
    announce(`计划第 ${next + 1} 步，共 5 步`);
  }

  function retryStep() {
    const turn = state.turn;
    if (turn === null) return;
    const step = turn.plan[turn.current];
    if (step === undefined || step.state !== 'failed') { toast('当前没有失败的步骤'); return; }
    step.state = 'running';
    turn.state = 'running';
    // 只重跑该步：executed 只追加 s4，步骤 1–3 不重放，diff 卡不重复生成
    step.state = 'done';
    turn.executed.push(step.id);
    turn.tools.push(cloneCard(TEST_OK_CARD));
    turn.current += 1;
    if (turn.current >= turn.plan.length) turn.state = 'done';
    else turn.plan[turn.current].state = 'running';
    persist();
    renderAll();
    toast('已只重跑第 4 步 · 步骤 1–3 未重复执行');
    announce('第 4 步已重试完成');
  }

  function demoAwait() {
    focusDemoSession();
    let turn = state.turn;
    if (turn === null || turn.state === 'done' || turn.state === 'failed') {
      turn = freshTurn();
      turn.plan[0].state = 'done';
      turn.plan[1].state = 'done';
      turn.plan[2].state = 'running';
      turn.current = 2;
      turn.executed = ['s1', 's2'];
      turn.owner = state.activeId;
      state.turn = turn;
    }
    if (turn.state === 'awaiting_approval') { toast('请先处理危险操作确认'); return; }
    turn.state = 'awaiting_input';
    turn.plan[turn.current].state = 'awaiting';
    turn.question = {
      id: 'q1',
      text: '第 3 步需要你确认：计划条按「每轮一条」渲染，还是整个会话只保留一条全局计划？',
      options: [
        { id: 'a', label: '每轮一条（推荐）' },
        { id: 'b', label: '全局一条' },
      ],
      answered: '',
    };
    persist();
    renderAll();
    toast('已进入阻塞态：回答后继续同一轮');
    announce('Agent 正在等待你的回答');
  }

  function answerQuestion(optionId) {
    const turn = state.turn;
    if (turn === null || turn.state !== 'awaiting_input' || turn.question === null) return;
    const opt = turn.question.options.find((o) => o.id === optionId);
    turn.question.answered = opt !== undefined ? opt.label : '自由回答';
    const step = turn.plan[turn.current];
    if (step !== undefined && step.state !== 'done') {
      step.state = 'done';
      turn.executed.push(step.id);
    }
    turn.current = Math.min(turn.current + 1, turn.plan.length);
    if (turn.current < turn.plan.length) turn.plan[turn.current].state = 'running';
    turn.state = 'running';
    persist();
    renderAll();
    toast('已收到回答 · 继续同一轮');
    announce('已继续执行，同一轮未重发');
  }

  function openApproval() {
    focusDemoSession();
    state.approval = { scope: 'once' };
    if (state.turn !== null && state.turn.state === 'running') state.turn.state = 'awaiting_approval';
    renderAll();
    announce('等待危险操作授权');
  }

  function setScope(scope) {
    if (state.approval === null) return;
    state.approval.scope = scope;
    renderModal();
  }

  function confirmApproval() {
    if (state.approval === null) return;
    const labels = { once: '仅本次', task: '本任务', workspace: '本工作区' };
    const label = labels[state.approval.scope] ?? '仅本次';
    const turn = state.turn;
    if (turn !== null) {
      turn.approvals.push({ scope: state.approval.scope, label, tool: 'Bash' });
      if (turn.state === 'awaiting_approval') turn.state = 'running';
    }
    state.approval = null;
    persist();
    renderAll();
    toast(`已允许 · ${label}范围 · 已写入审批记录`);
    announce('危险操作已授权，继续执行');
  }

  function cancelApproval() {
    if (state.approval === null) return;
    if (state.turn !== null && state.turn.state === 'awaiting_approval') state.turn.state = 'running';
    state.approval = null;
    renderAll();
    toast('已拒绝本次危险操作');
    announce('危险操作已拒绝');
  }

  function simulateRefresh() {
    const persisted = loadPersisted();
    if (persisted !== null) {
      state.draft = typeof persisted.draft === 'string' ? persisted.draft : '';
      state.sessions = Array.isArray(persisted.sessions) ? persisted.sessions : state.sessions;
      state.activeId = typeof persisted.activeId === 'string' ? persisted.activeId : state.activeId;
      state.userMessage = typeof persisted.userMessage === 'string' ? persisted.userMessage : state.userMessage;
      state.theme = persisted.theme === 'dark' ? 'dark' : 'light';
      state.turn = persisted.turn !== null && typeof persisted.turn === 'object' ? persisted.turn : state.turn;
    }
    document.getElementById('composerInput').value = state.draft;
    renderAll();
    toast(`模拟刷新完成：草稿已恢复（${state.draft.length} 字）`);
    announce('页面已重新加载，草稿已恢复');
  }

  function resetAll() {
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    state = defaultState();
    document.getElementById('composerInput').value = '';
    renderAll();
    toast('已重置演示状态');
  }

  /* ── 侧栏动作 ─────────────────────────────────────────── */
  function commitRename(id) {
    const session = state.sessions.find((s) => s.id === id);
    const input = document.querySelector(`[data-role="rename-input"][data-id="${id}"]`);
    if (session === undefined || input === null) return;
    const next = input.value.trim();
    if (next === '') { toast('标题不能为空'); input.focus(); return; }
    session.title = next;
    state.renamingId = null;
    persist();
    renderAll();
    toast('已重命名');
  }

  function forkSession(id) {
    const origin = state.sessions.find((s) => s.id === id);
    if (origin === undefined) return;
    const forked = {
      id: 'fork-' + Date.now(),
      title: origin.title + ' · 分叉',
      issue: origin.issue,
      cli: origin.cli,
      model: origin.model,
      status: '已结束',
      unread: 0,
      ago: '刚刚',
      archived: false,
      forkedFrom: origin.title,
    };
    state.sessions.unshift(forked);
    state.activeId = forked.id;
    state.menuId = null;
    state.headMenuOpen = false;
    persist();
    renderAll();
    toast('已从当前轮分叉：源会话保持不变');
  }

  function archiveSession(id, archived) {
    const session = state.sessions.find((s) => s.id === id);
    if (session === undefined) return;
    session.archived = archived;
    state.menuId = null;
    state.headMenuOpen = false;
    if (archived && state.activeId === id) {
      const next = state.sessions.find((s) => !s.archived);
      state.activeId = next !== undefined ? next.id : null;
    }
    persist();
    renderAll();
    toast(archived ? '已归档（可在「已归档」中恢复）' : '已取消归档');
  }

  function deleteSession(id) {
    const index = state.sessions.findIndex((s) => s.id === id);
    if (index === -1) return;
    const session = state.sessions[index];
    if (session.status === '运行中') { toast('运行中的会话不能删除，请先停止'); return; }
    state.sessions.splice(index, 1);
    state.confirmDeleteId = null;
    state.menuId = null;
    if (state.activeId === id) {
      const next = state.sessions.find((s) => !s.archived);
      state.activeId = next !== undefined ? next.id : null;
    }
    persist();
    renderAll();
    toast('已删除会话');
  }

  function handleSend() {
    const input = document.getElementById('composerInput');
    const text = input.value.trim();
    if (text === '') { toast('先输入内容再发送'); return; }
    state.draft = '';
    input.value = '';
    const turn = state.turn;
    if (turn !== null && turn.state === 'awaiting_input' && turn.question !== null) {
      turn.question.answered = '直接回答：' + (text.length > 24 ? text.slice(0, 24) + '…' : text);
      const step = turn.plan[turn.current];
      if (step !== undefined && step.state !== 'done') {
        step.state = 'done';
        turn.executed.push(step.id);
      }
      turn.current = Math.min(turn.current + 1, turn.plan.length);
      if (turn.current < turn.plan.length) turn.plan[turn.current].state = 'running';
      turn.state = 'running';
    } else {
      state.userMessage = text;
      const next = freshTurn();
      next.owner = state.activeId ?? 's1';
      state.turn = next;
    }
    persist();
    renderAll();
    toast('已发送（原型不接后端，状态机按真实契约推进）');
  }

  /* ── 事件委托 ─────────────────────────────────────────── */
  document.addEventListener('click', (event) => {
    const target = event.target;
    const actionEl = target.closest('[data-act]');
    const inMenu = target.closest('.row-menu, .head-menu');
    const menuTrigger = target.closest('[data-act="session-menu"], [data-act="head-menu"]');
    if (!inMenu && menuTrigger === null && (state.menuId !== null || state.headMenuOpen)) {
      state.menuId = null;
      state.headMenuOpen = false;
      renderRail();
      renderHead();
    }
    // 点遮罩空白处 = 拒绝
    if (actionEl === null) {
      if (target.classList !== undefined && target.classList.contains('modal')) cancelApproval();
      return;
    }
    const act = actionEl.dataset.act;
    const id = actionEl.dataset.id;

    switch (act) {
      case 'session-select':
        if (state.activeId !== id) {
          state.activeId = id;
          state.menuId = null;
          state.headMenuOpen = false;
          state.renamingId = null;
          state.confirmDeleteId = null;
          persist();
          renderAll();
        }
        break;
      case 'session-menu':
        state.menuId = state.menuId === id ? null : id;
        renderRail();
        break;
      case 'head-menu':
        state.headMenuOpen = !state.headMenuOpen;
        state.menuId = null;
        renderRail();
        renderHead();
        break;
      case 'new-session':
        toast('新建会话弹窗沿用现有 NewSessionDialog（原型不重画）');
        break;
      case 'toggle-archived':
        state.archivedOpen = !state.archivedOpen;
        renderRailList();
        break;
      case 'rename':
        state.renamingId = id;
        state.menuId = null;
        state.headMenuOpen = false;
        renderAll();
        document.querySelector(`[data-role="rename-input"][data-id="${id}"]`)?.focus();
        break;
      case 'head-rename':
        state.renamingId = id;
        state.headMenuOpen = false;
        renderAll();
        document.querySelector(`[data-role="rename-input"][data-id="${id}"]`)?.focus();
        break;
      case 'rename-commit':
        commitRename(id);
        break;
      case 'rename-cancel':
        state.renamingId = null;
        renderAll();
        break;
      case 'fork':
      case 'head-fork':
        forkSession(id);
        break;
      case 'archive':
        archiveSession(id, true);
        break;
      case 'unarchive':
        archiveSession(id, false);
        break;
      case 'delete':
        state.confirmDeleteId = id;
        state.menuId = null;
        renderRail();
        break;
      case 'delete-confirm':
        deleteSession(id);
        break;
      case 'delete-cancel':
        state.confirmDeleteId = null;
        renderRail();
        break;
      case 'toggle-plan':
        state.planOpen = !state.planOpen;
        persist();
        renderThread();
        break;
      case 'toggle-fold':
        state.foldOpen = !state.foldOpen;
        renderThread();
        break;
      case 'toggle-tool': {
        const card = state.turn?.tools.find((c) => c.id === id);
        if (card !== undefined) {
          card.open = !card.open;
          renderThread();
        }
        break;
      }
      case 'toggle-file': {
        const card = state.turn?.tools.find((c) => c.id === actionEl.dataset.card);
        const file = card?.files[Number(actionEl.dataset.index)];
        if (file !== undefined) {
          file.open = !file.open;
          renderThread();
        }
        break;
      }
      case 'git-open':
        toast(`已在 git 中打开对比：${actionEl.dataset.path}`);
        announce('已打开 git 对比视图');
        break;
      case 'view-log':
        toast('完整日志：vitest 2 个用例失败，其余 16 个通过（原型示意）');
        break;
      case 'retry-step':
        retryStep();
        break;
      case 'answer':
        answerQuestion(actionEl.dataset.opt);
        break;
      case 'demo-turn':
        advanceTurn();
        break;
      case 'demo-approve':
        openApproval();
        break;
      case 'demo-await':
        demoAwait();
        break;
      case 'demo-refresh':
        simulateRefresh();
        break;
      case 'demo-reset':
        resetAll();
        break;
      case 'theme':
        state.theme = state.theme === 'light' ? 'dark' : 'light';
        document.body.dataset.theme = state.theme;
        persist();
        updateDemoBar();
        break;
      case 'scope':
        setScope(actionEl.dataset.scope);
        break;
      case 'approve-confirm':
        confirmApproval();
        break;
      case 'approve-cancel':
        cancelApproval();
        break;
      case 'send':
        handleSend();
        break;
      case 'stop':
        if (state.turn !== null) {
          state.turn.state = 'stopped';
          persist();
          renderAll();
          toast('已停止本轮：已完成步骤保留，可单步重试');
        }
        break;
      case 'approval-rules':
        state.headMenuOpen = false;
        renderHead();
        toast('审批规则 · 工作区级 2 条（原型示意，撤销入口见设计说明）');
        break;
      default:
        break;
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target.matches('[data-role="session-search"]')) {
      state.search = target.value;
      renderRailList();
      return;
    }
    if (target.id === 'composerInput') {
      state.draft = target.value;
      persist();
      renderComposer();
    }
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    // Esc：关闭弹窗/菜单/重命名
    if (event.key === 'Escape') {
      if (state.approval !== null) { cancelApproval(); return; }
      if (state.renamingId !== null) { state.renamingId = null; renderAll(); return; }
      if (state.menuId !== null || state.headMenuOpen) {
        state.menuId = null;
        state.headMenuOpen = false;
        renderRail();
        renderHead();
        return;
      }
    }
    // 重命名：Enter 提交
    if (target.matches('[data-role="rename-input"]') && event.key === 'Enter') {
      event.preventDefault();
      commitRename(target.dataset.id);
      return;
    }
    // 三档确认：方向键切换
    if (state.approval !== null && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const scopes = ['once', 'task', 'workspace'];
      const current = scopes.indexOf(state.approval.scope);
      const next = (current + (event.key === 'ArrowDown' ? 1 : scopes.length - 1)) % scopes.length;
      event.preventDefault();
      setScope(scopes[next]);
      return;
    }
    // 弹窗内 Tab 循环，避免焦点跑到遮罩后面
    if (state.approval !== null && event.key === 'Tab') {
      const dialog = document.querySelector('[data-testid="approval-dialog"]');
      if (dialog !== null) {
        const focusables = Array.from(dialog.querySelectorAll('button, [tabindex="0"]'));
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    // 输入框 Enter 发送（Shift+Enter 换行）
    if (target.id === 'composerInput' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });

  // 首次进入：补一次草稿值
  function init() {
    renderAll();
    const persisted = loadPersisted();
    if (persisted !== null && typeof persisted.draft === 'string') {
      state.draft = persisted.draft;
      document.getElementById('composerInput').value = persisted.draft;
      renderComposer();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 仅供 jsdom 断言使用（原型专用，不进产品）
  window.__proto = {
    get state() { return state; },
    advanceTurn,
    retryStep,
    demoAwait,
    answerQuestion,
    openApproval,
    setScope,
    confirmApproval,
    cancelApproval,
    simulateRefresh,
    forkSession,
    archiveSession,
  };
})();
