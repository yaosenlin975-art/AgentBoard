/*
 * 设置页「智能体人设」管理 · 静态原型交互（PERSONA-LIB-1）
 * 纯前端 mock：不发请求、不依赖构建。数据与状态只存在内存，刷新即还原。
 */
(function () {
  'use strict';

  var TODAY = '2026-11-10';

  // ---- mock 数据：覆盖 builtin / import / user 三种来源 ----
  var SEED = [
    {
      id: 'p-builtin-general',
      name: '通用助手',
      source: 'builtin',
      description: '平台内置的通用协作人设：先澄清目标与边界，再给可执行的下一步。',
      body_md: '你是 AgentBoard 的通用协作助手。\n\n1. 先确认目标、范围与验收标准；\n2. 不确定的事实先查证，不猜；\n3. 输出先结论，再给依据与下一步。',
      package_path: null,
      created_at: '2026-10-28',
    },
    {
      id: 'p-builtin-review',
      name: '严格代码评审',
      source: 'builtin',
      description: '内置评审口径：正确性、边界条件、可复现验证，不放过「看起来对」。',
      body_md: '你是严格的代码评审者。\n\n- 只报能指出文件与行号的问题；\n- 区分「会导致错误」与「风格偏好」；\n- 每条问题给出可复现的验证方式。',
      package_path: null,
      created_at: '2026-10-28',
    },
    {
      id: 'p-import-data',
      name: '数据分析师',
      source: 'import',
      description: '从 WorkBuddy 专家包导入：指标口径、SQL 审阅与可视化建议。',
      body_md: '你是数据分析师。\n\n- 先对齐指标定义与口径；\n- SQL 逐段解释过滤条件；\n- 图表只保留能回答问题的维度。',
      package_path: 'D:\\WorkBuddy\\packages\\data-analyst',
      created_at: '2026-11-08',
    },
    {
      id: 'p-import-fe',
      name: '前端工程师',
      source: 'import',
      description: '从 WorkBuddy 专家包导入：React/Vite 界面实现与既有设计令牌约束。',
      body_md: '你是前端工程师。\n\n- 先读现有组件与设计令牌，不另造风格；\n- 改动保持最小可用；\n- 交互必须能用键盘走完。',
      package_path: 'D:\\WorkBuddy\\packages\\fe-craft',
      created_at: '2026-11-08',
    },
    {
      id: 'p-user-release',
      name: '发布协调员',
      source: 'user',
      description: '收敛发布清单，逐项确认回滚方案后再放行。',
      body_md: '你是发布协调员。\n\n- 每次发布前输出一份可勾选清单；\n- 每项都必须有回滚路径；\n- 未确认项一律视为阻塞。',
      package_path: null,
      created_at: '2026-11-09',
    },
  ];

  var SOURCE_LABEL = { builtin: '内置', import: '导入', user: '自建' };
  var SOURCE_CLASS = { builtin: 'badge-builtin', import: 'badge-import', user: 'badge-user' };

  // ---- DOM ----
  var listEl = document.getElementById('persona-list');
  var emptyEl = document.getElementById('persona-empty');
  var scrimEl = document.getElementById('scrim');
  var drawerEl = document.getElementById('drawer');
  var drawerTitle = document.getElementById('drawer-title');
  var drawerReadonly = document.getElementById('drawer-readonly');
  var drawerSave = document.getElementById('drawer-save');
  var drawerCancel = document.getElementById('drawer-cancel');
  var nameEl = document.getElementById('f-name');
  var descEl = document.getElementById('f-desc');
  var bodyEl = document.getElementById('f-body');
  var errName = document.getElementById('err-name');
  var errBody = document.getElementById('err-body');
  var confirmLayer = document.getElementById('confirm-layer');
  var confirmText = document.getElementById('confirm-text');
  var importLayer = document.getElementById('import-layer');
  var importPath = document.getElementById('f-path');
  var importError = document.getElementById('import-error');
  var toastsEl = document.getElementById('toasts');
  var notesEl = document.getElementById('notes');

  // ---- 状态 ----
  var personas = clone(SEED);
  var drawerState = null; // { mode: 'create' | 'edit', id: string | null }
  var confirmId = null;
  var importResult = 'ok';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- 列表渲染 ----
  function rowHtml(p) {
    var builtin = p.source === 'builtin';
    var meta = [];
    if (p.package_path) meta.push('<code>' + escapeHtml(p.package_path) + '</code>');
    meta.push('创建于 ' + escapeHtml(p.created_at));
    if (builtin) meta.push('内置人设不可改删');

    return (
      '<article class="persona-row" data-id="' + escapeHtml(p.id) + '">' +
        '<div class="persona-main">' +
          '<div class="persona-title-line">' +
            '<span class="persona-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="badge ' + SOURCE_CLASS[p.source] + '">' + SOURCE_LABEL[p.source] + '</span>' +
          '</div>' +
          '<p class="persona-desc">' + escapeHtml(p.description || '（无描述）') + '</p>' +
          '<p class="persona-meta">' + meta.join(' · ') + '</p>' +
        '</div>' +
        '<div class="persona-ops">' +
          '<button type="button" class="ab-btn ab-btn-secondary ab-btn-sm" data-act="edit"' +
            (builtin ? ' disabled title="内置人设只读：服务端 PATCH / DELETE 返回 409"' : '') + '>编辑</button>' +
          '<button type="button" class="ab-btn ab-btn-secondary ab-btn-sm ab-btn-danger" data-act="delete"' +
            (builtin ? ' disabled title="内置人设只读：服务端 PATCH / DELETE 返回 409"' : '') + '>删除</button>' +
          (builtin ? '<span class="lock-note">内置只读</span>' : '') +
        '</div>' +
      '</article>'
    );
  }

  function renderList() {
    listEl.innerHTML = personas.map(rowHtml).join('');
    var isEmpty = personas.length === 0;
    listEl.hidden = isEmpty;
    emptyEl.hidden = !isEmpty;
  }

  // ---- Toast ----
  function toast(html) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 3) toastsEl.removeChild(toastsEl.firstChild);
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 4200);
  }

  // ---- 抽屉 ----
  function setDrawerReadonly(readonly) {
    [nameEl, descEl, bodyEl].forEach(function (el) {
      el.disabled = readonly;
    });
    drawerReadonly.hidden = !readonly;
    drawerSave.hidden = readonly;
    drawerCancel.textContent = readonly ? '关闭' : '取消';
  }

  function clearFieldErrors() {
    errName.hidden = true;
    errBody.hidden = true;
    nameEl.style.borderColor = '';
    bodyEl.style.borderColor = '';
  }

  function openDrawer(mode, id) {
    drawerState = { mode: mode, id: id || null };
    clearFieldErrors();

    var p = mode === 'edit' ? personas.filter(function (x) { return x.id === id; })[0] : null;
    var readonly = !!p && p.source === 'builtin';
    drawerTitle.textContent = mode === 'create'
      ? '新建人设'
      : readonly ? '查看内置人设' : '编辑人设';
    nameEl.value = p ? p.name : '';
    descEl.value = p ? p.description : '';
    bodyEl.value = p ? p.body_md : '';
    setDrawerReadonly(readonly);

    scrimEl.classList.add('is-open');
    drawerEl.classList.add('is-open');
    if (!readonly) window.setTimeout(function () { nameEl.focus(); }, 60);
  }

  function closeDrawer() {
    drawerState = null;
    scrimEl.classList.remove('is-open');
    drawerEl.classList.remove('is-open');
  }

  function saveDrawer() {
    if (!drawerState) return;
    clearFieldErrors();

    var name = nameEl.value.trim();
    var bodyMd = bodyEl.value.trim();
    var desc = descEl.value.trim();
    var bad = false;

    if (!name) {
      errName.hidden = false;
      nameEl.style.borderColor = 'var(--ab-del)';
      bad = true;
    }
    if (!bodyMd) {
      errBody.hidden = false;
      bodyEl.style.borderColor = 'var(--ab-del)';
      bad = true;
    }
    if (bad) return;

    if (drawerState.mode === 'create') {
      personas.unshift({
        id: 'p-user-' + Date.now(),
        name: name,
        source: 'user',
        description: desc,
        body_md: bodyMd,
        package_path: null,
        created_at: TODAY,
      });
      toast('已新建人设「<strong>' + escapeHtml(name) + '</strong>」');
    } else {
      personas = personas.map(function (p) {
        if (p.id !== drawerState.id) return p;
        return Object.assign({}, p, { name: name, description: desc, body_md: bodyMd });
      });
      toast('已保存人设「<strong>' + escapeHtml(name) + '</strong>」');
    }

    closeDrawer();
    renderList();
  }

  // ---- 删除确认 ----
  function openConfirm(id) {
    var p = personas.filter(function (x) { return x.id === id; })[0];
    if (!p || p.source === 'builtin') return;
    confirmId = id;
    confirmText.textContent = '「' + p.name + '」删除后不可恢复，也不会同步到已经绑定它的会话。';
    scrimEl.classList.add('is-open');
    confirmLayer.classList.add('is-open');
  }

  function closeConfirm() {
    confirmId = null;
    confirmLayer.classList.remove('is-open');
    if (!drawerEl.classList.contains('is-open')) scrimEl.classList.remove('is-open');
  }

  function doDelete() {
    if (!confirmId) return;
    var p = personas.filter(function (x) { return x.id === confirmId; })[0];
    personas = personas.filter(function (x) { return x.id !== confirmId; });
    closeConfirm();
    renderList();
    toast('已删除人设「<strong>' + escapeHtml(p ? p.name : '') + '</strong>」');
  }

  // ---- 导入 ----
  function openImport() {
    importError.hidden = true;
    importError.textContent = '';
    if (!importPath.value) importPath.value = 'D:\\WorkBuddy\\packages\\data-analyst';
    scrimEl.classList.add('is-open');
    importLayer.classList.add('is-open');
  }

  function closeImport() {
    importLayer.classList.remove('is-open');
    if (!drawerEl.classList.contains('is-open') && !confirmLayer.classList.contains('is-open')) {
      scrimEl.classList.remove('is-open');
    }
  }

  function doImport() {
    importError.hidden = true;
    var path = importPath.value.trim();
    if (!path) {
      importError.textContent = '请填写专家包目录（绝对路径优先）。';
      importError.hidden = false;
      return;
    }

    if (importResult === 'conflict') {
      // 服务端 409 原文展示，界面不做二次包装
      importError.textContent = '同名专家包「用研小队」已导入过（团队 3f1c9a2e），不重复导入';
      importError.hidden = false;
      return;
    }

    personas.unshift({
      id: 'p-import-' + Date.now(),
      name: '用户研究员',
      source: 'import',
      description: '从 WorkBuddy 专家包导入：访谈提纲、可用性测试与结论归纳。',
      body_md: '你是用户研究员。\n\n- 访谈先写目标与问题清单；\n- 结论必须有原始观察支撑；\n- 输出按「发现 → 证据 → 建议」组织。',
      package_path: path,
      created_at: TODAY,
    });
    closeImport();
    renderList();
    toast('已导入 <strong>1</strong> 个人设（用户研究员）· 团队模板「用研小队」');
  }

  // ---- 顶部控制条（非产品 UI） ----
  function initChrome() {
    var isDark = false;
    var themeBtn = document.getElementById('btn-theme');
    themeBtn.addEventListener('click', function () {
      isDark = !isDark;
      document.documentElement.classList.toggle('dark', isDark);
      themeBtn.setAttribute('aria-pressed', String(isDark));
      themeBtn.textContent = isDark ? '浅色' : '深色';
    });

    document.getElementById('btn-empty').addEventListener('click', function () {
      personas = [];
      renderList();
      toast('已清空列表（演示空态）');
    });
    document.getElementById('btn-reset').addEventListener('click', function () {
      personas = clone(SEED);
      renderList();
      toast('已重置为初始 mock 数据');
    });
    document.getElementById('btn-notes').addEventListener('click', function () {
      var visible = notesEl.hidden;
      notesEl.hidden = !visible;
      this.setAttribute('aria-pressed', String(visible));
    });

    if (new URLSearchParams(location.search).get('clean') === '1') {
      document.body.classList.add('clean');
    }
  }

  // ---- 事件绑定 ----
  function bind() {
    document.getElementById('btn-create').addEventListener('click', function () { openDrawer('create'); });
    document.getElementById('btn-empty-create').addEventListener('click', function () { openDrawer('create'); });
    document.getElementById('btn-import').addEventListener('click', openImport);
    document.getElementById('btn-empty-import').addEventListener('click', openImport);

    // 列表行内操作（事件委托）
    listEl.addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-act]');
      if (!btn) return;
      var row = btn.closest('.persona-row');
      if (!row) return;
      var id = row.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') openDrawer('edit', id);
      if (btn.getAttribute('data-act') === 'delete') openConfirm(id);
    });

    drawerCloseBind();
    drawerSave.addEventListener('click', saveDrawer);
    drawerCancel.addEventListener('click', closeDrawer);

    confirmLayer.addEventListener('click', function (event) {
      if (event.target === confirmLayer) closeConfirm();
    });
    document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
    document.getElementById('confirm-ok').addEventListener('click', doDelete);

    importLayer.addEventListener('click', function (event) {
      if (event.target === importLayer) closeImport();
    });
    document.getElementById('import-cancel').addEventListener('click', closeImport);
    document.getElementById('import-ok').addEventListener('click', doImport);

    var resultButtons = importLayer.querySelectorAll('[data-import-result]');
    Array.prototype.forEach.call(resultButtons, function (btn) {
      btn.addEventListener('click', function () {
        importResult = btn.getAttribute('data-import-result');
        Array.prototype.forEach.call(resultButtons, function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        importError.hidden = true;
      });
    });

    scrimEl.addEventListener('click', function () {
      if (confirmLayer.classList.contains('is-open')) closeConfirm();
      else if (importLayer.classList.contains('is-open')) closeImport();
      else closeDrawer();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (importLayer.classList.contains('is-open')) closeImport();
      else if (confirmLayer.classList.contains('is-open')) closeConfirm();
      else if (drawerEl.classList.contains('is-open')) closeDrawer();
    });
  }

  function drawerCloseBind() {
    document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  }

  initChrome();
  bind();
  renderList();
})();
