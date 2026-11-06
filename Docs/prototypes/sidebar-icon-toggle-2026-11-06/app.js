/* ============================================================
 * 侧栏「图标简化 ↔ 完整」可切换 · 原型交互（SIDEBAR-ICT-1）
 *
 * 设计要点（与 DESIGN-NOTES.md 对应）：
 * ① 两种形态共用同一套 DOM，只切 app-shell[data-mode]，避免两套数据/两套渲染漂移；
 * ② 形态与按钮位置都写 localStorage，刷新保持；首次进入按视口宽度决定默认形态；
 * ③ 收起态靠 CSS tooltip（data-tip）在 hover 与 :focus-within 同时出现；
 * ④ Ctrl/Cmd+B 切换；收起时焦点若在侧栏内，转移到仍然可见的切换按钮；
 * ⑤ 窄屏下「展开」= 208px 浮层 + 遮罩，不挤压主区。
 * ============================================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'agentboard.sidebar.prototype';
  var shell = document.getElementById('app-shell');
  var sb = document.getElementById('sb');
  var stage = document.getElementById('stage');
  var root = document.getElementById('view-root');
  var memo = document.getElementById('memo');
  var html = document.documentElement;

  var NAV_LABEL = {
    board: '任务看板',
    decisions: '待决策',
    tree: '任务树',
    knowledge: '知识库',
    log: '日志',
    chat: '聊天',
  };

  var state = {
    mode: 'expanded',       // expanded | collapsed
    pos: 'top',             // top | bottom
    count: 3,               // 0 / 3 / 120（>99 显示 99+）
    view: 'board',
    narrow: false,
    dark: false,
    reduce: false,
  };

  var flags = { tooltip: false, shortcut: false, badge: false, persist: false, reduce: false };
  var seen = { mode: [], narrow: [], dark: [] };
  function addTo(bucket, value) {
    if (bucket.indexOf(value) === -1) bucket.push(value);
  }

  /* ---------------- 持久化 ---------------- */
  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        mode: parsed.mode === 'collapsed' ? 'collapsed' : parsed.mode === 'expanded' ? 'expanded' : null,
        pos: parsed.pos === 'bottom' ? 'bottom' : parsed.pos === 'top' ? 'top' : null,
      };
    } catch (error) {
      return null;
    }
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: state.mode, pos: state.pos }));
    } catch (error) {
      /* 隐私模式 / 禁用 localStorage：原型不阻塞，只是不记忆 */
    }
    updateMemo();
  }

  function updateMemo() {
    if (!memo) return;
    memo.textContent = '记忆：' + (state.mode === 'expanded' ? '展开' : '折叠') + ' · ' + (state.pos === 'top' ? '顶部' : '底部');
    memo.title = 'localStorage[' + STORAGE_KEY + '] = ' + JSON.stringify({ mode: state.mode, pos: state.pos });
  }

  /* ---------------- 形态切换 ---------------- */
  function visibleToggle() {
    return state.pos === 'top' ? document.getElementById('toggle-top') : document.getElementById('toggle-bottom');
  }

  function applyMode(mode, options) {
    var opts = options || {};
    var changed = state.mode !== mode;
    state.mode = mode;
    shell.setAttribute('data-mode', mode);
    sb.setAttribute('data-mode', mode);

    addTo(seen.mode, mode);
    if (stage.classList.contains('is-narrow')) addTo(seen.narrow, mode);
    if (html.classList.contains('dark')) addTo(seen.dark, mode);
    if (html.classList.contains('force-reduced')) flags.reduce = true;

    document.querySelectorAll('[data-toggle]').forEach(function (button) {
      button.setAttribute('aria-expanded', String(mode === 'expanded'));
      button.setAttribute('aria-label', (mode === 'expanded' ? '收起侧栏' : '展开侧栏') + '（Ctrl+B）');
      button.title = (mode === 'expanded' ? '收起侧栏' : '展开侧栏') + '（Ctrl+B）';
      button.setAttribute('data-tip', (mode === 'expanded' ? '收起侧栏' : '展开侧栏') + '（Ctrl+B）');
    });
    document.querySelectorAll('.sb-toggle-text').forEach(function (node) {
      node.textContent = mode === 'expanded' ? '收起侧栏' : '展开侧栏';
    });

    updateReadout();
    if (opts.persist !== false) save();
    else updateMemo();

    // 收起时焦点若在侧栏内部（且不在切换按钮上），转移到仍然可见的切换按钮
    if (changed && mode === 'collapsed' && !opts.keepFocus) {
      var active = document.activeElement;
      var inside = active && active !== document.body && sb.contains(active);
      var onToggle = active && active.hasAttribute && active.hasAttribute('data-toggle');
      if (inside && !onToggle) visibleToggle().focus({ preventScroll: true });
    }

    renderChecks();
  }

  function toggleMode() {
    applyMode(state.mode === 'expanded' ? 'collapsed' : 'expanded');
  }

  function applyPos(pos, options) {
    var opts = options || {};
    state.pos = pos === 'bottom' ? 'bottom' : 'top';
    shell.setAttribute('data-pos', state.pos);
    document.querySelectorAll('.proto-btn[data-pos]').forEach(function (button) {
      var on = button.getAttribute('data-pos') === state.pos;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    if (opts.persist !== false) save();
    else updateMemo();
  }

  /* ---------------- 角标 ---------------- */
  function badgeText(n) {
    return n > 99 ? '99+' : String(n);
  }

  function applyCount(n) {
    state.count = n;
    document.querySelectorAll('.proto-btn[data-count]').forEach(function (button) {
      var on = Number(button.getAttribute('data-count')) === n;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });

    ['decisions', 'chat'].forEach(function (kind) {
      var badge = document.querySelector('.sb-badge[data-badge="' + kind + '"]');
      var item = document.querySelector('.sb-item[data-view="' + kind + '"]');
      var li = item ? item.parentElement : null;
      if (badge) {
        badge.hidden = n <= 0;
        badge.textContent = badgeText(n);
        badge.title = n + (kind === 'chat' ? ' 条未读' : ' 条待决策');
      }
      if (item) {
        item.setAttribute('aria-label', NAV_LABEL[kind] + (n > 0 ? '，' + n + (kind === 'chat' ? ' 条未读' : ' 条') : ''));
      }
      if (li) li.setAttribute('data-tip', NAV_LABEL[kind] + (n > 0 ? ' · ' + badgeText(n) : ''));
    });

    if (state.mode === 'collapsed' && n > 0) flags.badge = true;
    renderChecks();
  }

  /* ---------------- 深色 / 减弱动效 / 窄屏 ---------------- */
  function applyTheme(dark) {
    state.dark = dark;
    html.classList.toggle('dark', dark);
    var button = document.getElementById('btn-theme');
    button.classList.toggle('is-on', dark);
    button.setAttribute('aria-pressed', String(dark));
    button.textContent = dark ? '浅色' : '深色';
    document.querySelectorAll('.sb-theme').forEach(function (node) {
      node.textContent = dark ? '深色' : '浅色';
    });
    var status = document.getElementById('sb-status');
    if (status) status.setAttribute('data-tip', '服务运行中 · 主题：' + (dark ? '深色' : '浅色'));
    if (dark) addTo(seen.dark, state.mode);
    renderChecks();
  }

  function applyReduce(reduce) {
    state.reduce = reduce;
    html.classList.toggle('force-reduced', reduce);
    var button = document.getElementById('btn-reduce');
    button.classList.toggle('is-on', reduce);
    button.setAttribute('aria-pressed', String(reduce));
    button.textContent = reduce ? '恢复动效' : '减弱动效';
    if (reduce) flags.reduce = true;
    renderChecks();
  }

  function applyNarrow(narrow) {
    state.narrow = narrow;
    stage.classList.toggle('is-narrow', narrow);
    var button = document.getElementById('btn-narrow');
    button.classList.toggle('is-on', narrow);
    button.setAttribute('aria-pressed', String(narrow));
    if (narrow) addTo(seen.narrow, state.mode);
    updateReadout();
    renderChecks();
  }

  /* ---------------- 视图 ---------------- */
  function boardTemplate() {
    var columns = [
      { name: '待规划', count: 3, cards: [
        { title: 'SIDEBAR-ICT-1 侧栏图标简化原型', meta: ['web', '调研'] },
        { title: 'DETAIL-D7 详情面板服务端接线', meta: ['server', '阻塞'] },
        { title: 'KB-CR-1 知识页 domain 必填收口', meta: ['知识库'] },
      ] },
      { name: '进行中', count: 2, cards: [
        { title: 'BORROW-4.3 会话暂停与恢复', meta: ['server', '进行中'], hot: true },
        { title: 'AWAIT1b 等待态心跳延长', meta: ['server'] },
      ] },
      { name: '待验收', count: 2, cards: [
        { title: 'SIDEBAR01 工作空间侧栏收放', meta: ['web'], hot: true },
        { title: 'STORE-2 工作区库下沉', meta: ['infra'] },
      ] },
      { name: '已关闭', count: 1, cards: [
        { title: 'DEC-9 待决策宽限 180s', meta: ['board'] },
      ] },
    ];
    var htmlParts = columns.map(function (column) {
      var cards = column.cards.map(function (card) {
        var meta = card.meta.map(function (text) {
          return '<span class="chip' + (text === '阻塞' ? ' is-warn' : '') + '">' + text + '</span>';
        }).join('');
        return '<article class="tcard"><div class="tcard-title">' + card.title + '</div><div class="tcard-meta">' + meta + '</div></article>';
      }).join('');
      return '<section class="qcol"><div class="qcol-head"><span>' + column.name + '</span><span class="qcol-count tnum">' + column.count + '</span></div>' + cards + '</section>';
    }).join('');

    return headTemplate('任务看板', '4 列 · 8 张卡 · 侧栏形态变化时主区自动回流') +
      '<div class="cols">' + htmlParts + '</div>';
  }

  function decisionsTemplate() {
    var items = [
      { title: 'BORROW-4.3 是否允许暂停后回滚已写入内容？', desc: '暂停只阻止新消息入队与新步骤，不撤销已完成写入。需要确认是否补充显式回滚入口。', meta: ['宽限 02:41', 'P1'], critical: true },
      { title: 'STORE-2 首次下沉是否允许分区冻结？', desc: '迁移期间仅冻结对应工作区写入，中心库保持服务；需要确认冻结粒度与恢复口径。', meta: ['宽限 04:18', 'P2'], critical: false },
      { title: 'DETAIL-D7 的溢出菜单是否收纳强制释放？', desc: '危险操作收进右上角 ⋯，吸底条只放高频动作；强制释放是否需要二次输入卡号确认。', meta: ['开放', 'P2'], critical: false },
    ];
    var list = items.map(function (item) {
      return '<article class="dcard' + (item.critical ? ' is-critical' : '') + '">' +
        '<span class="rail" aria-hidden="true"></span>' +
        '<div class="dcard-body">' +
          '<div class="dcard-title">' + item.title + '</div>' +
          '<div class="dcard-desc">' + item.desc + '</div>' +
          '<div class="dcard-meta">' + item.meta.map(function (text) { return '<span class="chip">' + text + '</span>'; }).join('') + '</div>' +
        '</div>' +
        '<div class="dcard-side"><button type="button" class="dbtn is-primary" data-toast="原型未接回答链路">去回答</button></div>' +
      '</article>';
    }).join('');

    return headTemplate('待决策', '3 条待拍板 · 侧栏角标在两种形态下都保留数量') +
      '<div class="dlist">' + list + '</div>';
  }

  function placeholderTemplate(view) {
    return headTemplate(NAV_LABEL[view], '入口本身在两种形态下都保留') +
      '<div class="placeholder"><h2>' + NAV_LABEL[view] + '视图</h2>' +
      '<p>本原型只覆盖左侧栏的两种形态、切换与记忆，不展开该视图内容。</p></div>';
  }

  function headTemplate(title, sub) {
    return '<div class="view-head"><div><h1 class="view-title">' + title + '</h1><p class="view-sub">' + sub + '</p></div>' +
      '<div class="view-meta"><span class="sb-readout" data-sb-readout>侧栏：完整 · 176px</span></div></div>';
  }

  function renderView() {
    if (state.view === 'board') root.innerHTML = boardTemplate();
    else if (state.view === 'decisions') root.innerHTML = decisionsTemplate();
    else root.innerHTML = placeholderTemplate(state.view);
    updateReadout();
  }

  function updateReadout() {
    var narrow = stage.classList.contains('is-narrow');
    var text;
    if (narrow && state.mode === 'expanded') text = '侧栏：浮层展开 · 208px';
    else if (narrow && state.mode === 'collapsed') text = '侧栏：图标栏 · 56px';
    else if (state.mode === 'expanded') text = '侧栏：完整 · 176px';
    else text = '侧栏：图标 · 56px';
    document.querySelectorAll('[data-sb-readout]').forEach(function (node) {
      node.textContent = text;
    });
  }

  function setActiveNav() {
    document.querySelectorAll('.sb-item[data-view]').forEach(function (button) {
      var active = button.getAttribute('data-view') === state.view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function renderViewAndActive() {
    setActiveNav();
    renderView();
  }

  /* ---------------- toast ---------------- */
  function toast(message) {
    var wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    var node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    wrap.appendChild(node);
    window.setTimeout(function () {
      if (node.parentElement) node.parentElement.removeChild(node);
    }, 1900);
  }

  /* ---------------- 原型自检 ---------------- */
  var CHECKS = [
    { key: 'mode', label: '两种形态互相切换（各至少一次）' },
    { key: 'tooltip', label: '收起态 hover / 键盘 focus 出 tooltip' },
    { key: 'shortcut', label: 'Ctrl / Cmd + B 可切换' },
    { key: 'persist', label: '刷新后保持上次形态与按钮位置' },
    { key: 'badge', label: '收起态角标显示数字（含 99+）' },
    { key: 'narrow', label: '窄屏下两种形态都看过' },
    { key: 'theme', label: '深色下两种形态都看过' },
    { key: 'reduce', label: '减弱动效下切换过形态' },
  ];

  function checkState(key) {
    if (key === 'mode') return seen.mode.length === 2;
    if (key === 'narrow') return seen.narrow.length === 2;
    if (key === 'theme') return seen.dark.length === 2;
    return Boolean(flags[key]);
  }

  function renderChecks() {
    var list = document.getElementById('selfcheck-list');
    var score = document.getElementById('selfcheck-score');
    if (!list || !score) return;
    var done = 0;
    list.innerHTML = CHECKS.map(function (check) {
      var ok = checkState(check.key);
      if (ok) done += 1;
      return '<li class="' + (ok ? 'is-done' : '') + '"><span class="mark" aria-hidden="true">' + (ok ? '✓' : '○') + '</span><span>' + check.label + '</span></li>';
    }).join('');
    score.textContent = done + '/' + CHECKS.length;
  }

  /* ---------------- 初始化 ---------------- */
  // 演示深链：?mode=collapsed&pos=bottom&count=120&narrow=1&dark=1（便于评审直接打开某个状态）
  var params = new URLSearchParams(window.location.search);
  var stored = readStored();
  if (stored) flags.persist = true;

  applyPos(params.get('pos') === 'bottom' ? 'bottom' : stored && stored.pos ? stored.pos : 'top', { persist: false });
  var initialMode = stored && stored.mode
    ? stored.mode
    : window.innerWidth < 920 ? 'collapsed' : 'expanded';
  if (params.get('mode') === 'collapsed' || params.get('mode') === 'expanded') initialMode = params.get('mode');
  applyMode(initialMode, { persist: false, keepFocus: true });
  applyCount(params.get('count') === '120' ? 120 : 3);
  renderViewAndActive();
  if (params.get('narrow') === '1' || window.innerWidth < 920) applyNarrow(true);
  if (params.get('dark') === '1') applyTheme(true);
  renderChecks();

  /* ---------------- 事件 ---------------- */
  // 侧栏切换（顶部 / 底部两个按钮同一动作）
  document.querySelectorAll('[data-toggle]').forEach(function (button) {
    button.addEventListener('click', toggleMode);
  });

  // 入口切换；窄屏浮层模式下选中后自动收起
  document.getElementById('sb-nav').addEventListener('click', function (event) {
    var item = event.target.closest('.sb-item[data-view]');
    if (!item) return;
    state.view = item.getAttribute('data-view');
    renderViewAndActive();
    if (stage.classList.contains('is-narrow') && state.mode === 'expanded') {
      applyMode('collapsed');
      visibleToggle().focus({ preventScroll: true });
    }
  });

  // 账号 / 设置 / 工作空间：不在本次原型范围，给明确反馈而不是死按钮
  sb.addEventListener('click', function (event) {
    if (event.target.closest('.sb-item[data-view]')) return;
    if (event.target.closest('[data-toggle]')) return;
    if (event.target.closest('.sb-ws')) {
      toast('工作空间浮窗不在本次原型范围');
      return;
    }
    if (event.target.closest('.sb-util')) {
      toast('账号 / 设置面板不在本次原型范围');
    }
  });

  // 角标 / 位置 / 窄屏 / 深色 / 减弱动效 / 重置
  document.querySelectorAll('.proto-btn[data-count]').forEach(function (button) {
    button.addEventListener('click', function () {
      applyCount(Number(button.getAttribute('data-count')));
    });
  });
  document.querySelectorAll('.proto-btn[data-pos]').forEach(function (button) {
    button.addEventListener('click', function () {
      applyPos(button.getAttribute('data-pos'));
    });
  });
  document.getElementById('btn-narrow').addEventListener('click', function () {
    applyNarrow(!state.narrow);
  });
  document.getElementById('btn-theme').addEventListener('click', function () {
    applyTheme(!state.dark);
  });
  document.getElementById('btn-reduce').addEventListener('click', function () {
    applyReduce(!state.reduce);
  });
  document.getElementById('btn-reset').addEventListener('click', function () {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (error) { /* ignore */ }
    flags = { tooltip: false, shortcut: false, badge: false, persist: false, reduce: false };
    seen = { mode: [], narrow: [], dark: [] };
    applyNarrow(false);
    applyTheme(false);
    applyReduce(false);
    applyPos('top', { persist: false });
    applyMode('expanded', { persist: false, keepFocus: true });
    applyCount(3);
    toast('已清空演示记忆与自检');
  });

  // tooltip 自检：收起态 hover 或键盘 focus 到带 data-tip 的元素
  sb.addEventListener('mouseover', function (event) {
    if (state.mode !== 'collapsed') return;
    if (!event.target.closest('.tip')) return;
    if (!flags.tooltip) {
      flags.tooltip = true;
      renderChecks();
    }
  });
  sb.addEventListener('focusin', function (event) {
    if (state.mode !== 'collapsed') return;
    if (!event.target.closest('.tip')) return;
    if (!flags.tooltip) {
      flags.tooltip = true;
      renderChecks();
    }
  });

  // 快捷键：Ctrl/Cmd + B（输入框内不劫持）
  window.addEventListener('keydown', function (event) {
    var target = event.target;
    var typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (typing) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (String(event.key).toLowerCase() !== 'b') return;
    event.preventDefault();
    flags.shortcut = true;
    toggleMode();
  });

  // Esc：窄屏浮层展开时先收起浮层
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!state.narrow || state.mode !== 'expanded') return;
    applyMode('collapsed');
    visibleToggle().focus({ preventScroll: true });
  });

  // 窄屏遮罩点击 = 收起浮层
  document.getElementById('narrow-scrim').addEventListener('click', function () {
    if (state.mode !== 'expanded') return;
    applyMode('collapsed');
    visibleToggle().focus({ preventScroll: true });
  });

  // 视图内「去回答」等占位动作
  root.addEventListener('click', function (event) {
    var target = event.target.closest('[data-toast]');
    if (target) toast(target.getAttribute('data-toast'));
  });

  // 自检面板折叠
  var selfcheck = document.getElementById('selfcheck');
  document.getElementById('selfcheck-toggle').addEventListener('click', function () {
    var open = selfcheck.getAttribute('data-open') !== 'false';
    selfcheck.setAttribute('data-open', String(!open));
    this.setAttribute('aria-expanded', String(!open));
  });
})();
