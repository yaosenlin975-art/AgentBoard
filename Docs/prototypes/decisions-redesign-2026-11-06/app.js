/* ============================================================
   待决策区重做 · 原型交互
   纯静态演示：无网络请求、无构建、双击 index.html 即可运行。
   数据字段尽量对齐生产 DTO（见 DESIGN-NOTES.md 的字段映射表）；
   其中 issue 优先级 / 下游阻塞数 / 父卡为「建议新增投影」，
   在当前 DecisionListItemDto 中并不存在，已在设计说明中标注。
   ============================================================ */
(function () {
  'use strict';

  var T0 = Date.now();
  var MIN = 60 * 1000;
  var HOUR = 60 * MIN;

  /* -------------------- 1. 演示数据 -------------------- */

  var issues = {
    'AB-142': {
      key: 'AB-142',
      title: '导出引擎：把 PVF 分片导出改为流式写入',
      status: '进行中',
      priority: '高',
      labels: ['服务端', '导出'],
      claimedBy: 'codebuddy',
      parent: 'AB-120',
      desc: '把 export_data.py 的 26 个分片从单事务全量写入改为流式写入，避免峰值内存 1.8GB 触发 OOM。导出产物会被便携包的 verify-rules 直接读取。'
    },
    'AB-118': {
      key: 'AB-118',
      title: '看板拖拽：锁卡在待规划列的拖拽冻结',
      status: '进行中',
      priority: '高',
      labels: ['看板', '交互'],
      claimedBy: 'kb-cli',
      parent: null,
      desc: '锁卡没有占用，当前拖拽只在 claimed_by != null 时冻结，导致锁卡可以直接被拖到别的列。需要决定拖拽与决策锁的交互口径。'
    },
    'AB-151': {
      key: 'AB-151',
      title: '知识库全文检索：FTS5 还是进程内倒排',
      status: '进行中',
      priority: '中',
      labels: ['知识库', '检索'],
      claimedBy: 'codex',
      parent: 'AB-144',
      desc: '知识库当前只有 LIKE 查询，12 万条知识页首屏约 800ms。需要确定索引方案与中文分词口径，再动迁移。'
    },
    'AB-137': {
      key: 'AB-137',
      title: '桌面壳通知：Tauri 插件与打包权限',
      status: '进行中',
      priority: '高',
      labels: ['桌面壳', '通知'],
      claimedBy: 'codebuddy',
      parent: null,
      desc: 'Tauri v2 需要 notification 插件与 capabilities 声明。权限申请时机直接影响宽限期内能否抢答。'
    },
    'AB-129': {
      key: 'AB-129',
      title: '便携包规则自检：把 6 个技能纳入 verify-rules',
      status: '待规划',
      priority: '中',
      labels: ['打包', '自检'],
      claimedBy: null,
      parent: null,
      desc: 'AGENTS.md 的打包约束要求 6 个技能齐全，当前 verify-rules 只校验文件存在，不校验技能清单。'
    },
    'AB-160': {
      key: 'AB-160',
      title: '任务详情：描述区 markdown 预览切换',
      status: '进行中',
      priority: '低',
      labels: ['详情', 'UI'],
      claimedBy: 'trae',
      parent: null,
      desc: '详情面板描述区需要「编辑 / 预览」切换，位置未定：标题行右侧还是工具栏。'
    },
    'AB-122': {
      key: 'AB-122',
      title: 'CLI：kb ask 的 --grace 0 退出码口径',
      status: '待验收',
      priority: '中',
      labels: ['CLI', '契约'],
      claimedBy: 'kb-cli',
      parent: null,
      desc: '--grace 0 立即落锁，CLI 应输出 LOCKED。需要确认退出码与 answered 是否共用 0。'
    },
    'AB-150': {
      key: 'AB-150',
      title: '聊天：图片粘贴失败后的重试口径',
      status: '待规划',
      priority: '中',
      labels: ['聊天', '附件'],
      claimedBy: null,
      parent: null,
      desc: '聊天粘贴图片上传失败后，重试是否复用同一个 attachment id。'
    }
  };

  var decisions = [
    {
      id: 'd1',
      issueKey: 'AB-142',
      state: 'grace',
      graceSeconds: 180,
      graceUntil: T0 + 167000,
      lockedAt: null,
      stopRequestedAt: null,
      stopAckAt: null,
      answerRevision: 0,
      answers: [],
      createdBy: 'codebuddy',
      trigger: '步骤间无法自动判定',
      blockedDownstream: 2,
      question: '流式导出遇到坏分片时，应该整批回滚、跳过并记警告，还是先写临时目录再原子替换？',
      context: '导出脚本当前在单事务里写 26 个 JSON 分片，峰值内存 1.8GB。第 17 个分片 schema 校验失败时，如果继续写，下游 import 会读到半套数据；如果整批回滚，26 个分片要重导，预计多花 4 分钟。\n\n导出产物会被便携包的 verify-rules 直接读取，所以「半套数据」比「多等 4 分钟」更危险。',
      options: [
        { id: 'a', label: '整批回滚', consequence: '下游不会读到半套数据；26 个分片要重导，预计多花 4 分钟', isDefault: true },
        { id: 'b', label: '跳过坏分片并记警告', consequence: '导出继续，但 import 端必须容忍缺片；需要额外改校验脚本' },
        { id: 'c', label: '先写临时目录，成功后原子替换', consequence: '最稳，但要改导出目录结构与清理逻辑，约 2 小时' }
      ],
      checkpoint: [
        ['改动摘要', 'export_data.py +38 −12'],
        ['下一步', '确认回滚语义后补 --atomic 分支与单测'],
        ['stash', 'stash@{0} · 4f2c1a9']
      ]
    },
    {
      id: 'd2',
      issueKey: 'AB-118',
      state: 'grace',
      graceSeconds: 180,
      graceUntil: T0 + 42000,
      lockedAt: null,
      stopRequestedAt: null,
      stopAckAt: null,
      answerRevision: 0,
      answers: [],
      createdBy: 'kb-cli',
      trigger: '看板交互与锁语义冲突',
      blockedDownstream: 0,
      question: '锁卡被拖到另一列时，是拒绝并提示，还是允许改列但保持锁定？',
      context: '锁卡的占用已释放，但 claim 仍被 NOT EXISTS 挡住。当前看板拖拽只在 claimed_by != null 时冻结；锁卡没有占用，可以直接被拖到别的列。',
      options: [
        { id: 'a', label: '拒绝拖动，toast 指向决策', consequence: '语义最一致；但用户可能以为界面卡住了' },
        { id: 'b', label: '允许改列，锁随卡走', consequence: '状态可被人工整理，不影响 claim；需补「锁卡改列」用例', isDefault: true },
        { id: 'c', label: '允许拖动但回弹', consequence: '反馈强，容易误以为操作失败' }
      ],
      checkpoint: [
        ['改动摘要', 'IssueCard.tsx +12 −3'],
        ['下一步', '补 updateIssueInHierarchy 的锁卡门禁测试']
      ]
    },
    {
      id: 'd3',
      issueKey: 'AB-151',
      state: 'open',
      graceSeconds: 180,
      graceUntil: T0 - 26 * MIN,
      lockedAt: T0 - 26 * MIN,
      stopRequestedAt: T0 - 26 * MIN + 1500,
      stopAckAt: T0 - 26 * MIN + 9000,
      answerRevision: 0,
      answers: [],
      createdBy: 'codex',
      trigger: '性能压测超阈值',
      blockedDownstream: 3,
      question: '知识库检索：12 万条知识页、约 300 万字，选 SQLite FTS5 还是进程内倒排？中文分词怎么定？',
      context: '现状：知识库只有 LIKE 查询。12 万条、约 300 万字时，首屏查询约 800ms，按当前数据增速 6 个月后接近 2s。\n\n约束：便携包不能新增运行时依赖；服务端启动预算 3s；内存预算 +200MB 以内；索引必须能在 Windows 单机增量更新，不要求多进程并发写。\n\n取舍点：FTS5 零依赖但中文只能按字切分，召回高、精确率低；jieba 预分词精确但引入 Python 依赖与重建流程；进程内倒排最快但启动重建 6s、内存 +180MB。',
      options: [
        { id: 'a', label: 'FTS5 + unicode61 分词', consequence: '零新依赖，中文按字切分；召回高但精确率低，索引约 40MB' },
        { id: 'b', label: 'FTS5 + jieba 预分词写入', consequence: '精确率高；引入 Python 依赖与索引重建流程，增量同步要重写' },
        { id: 'c', label: '进程内倒排（内存）', consequence: '查询 <10ms；启动重建约 6s，内存 +180MB，进程重启即丢' },
        { id: 'd', label: '维持 LIKE + 分页', consequence: '零改动；首屏 800ms，随数据量线性恶化' }
      ],
      checkpoint: [
        ['改动摘要', 'knowledgeSearch.ts +96 −18（未提交）'],
        ['下一步', '选型后补 FTS5 建表迁移与中文分词'],
        ['后台进程', '无']
      ]
    },
    {
      id: 'd4',
      issueKey: 'AB-137',
      state: 'open',
      graceSeconds: 180,
      graceUntil: T0 - 3 * HOUR,
      lockedAt: T0 - 3 * HOUR,
      stopRequestedAt: T0 - 3 * HOUR + 2000,
      stopAckAt: null,
      answerRevision: 0,
      answers: [],
      createdBy: 'codebuddy',
      trigger: '通知可达性设计',
      blockedDownstream: 1,
      question: '桌面壳通知权限：在启动时申请，还是首次进入宽限时申请？',
      context: '启动时申请没有上下文，用户容易点拒绝；首次进入宽限时申请上下文明确，但多一步点击，可能赶不上 3 分钟宽限。',
      options: [
        { id: 'a', label: '启动时申请', consequence: '后续零打扰；但用户没有上下文，拒绝率更高' },
        { id: 'b', label: '首次进入宽限时申请', consequence: '上下文明确、转化高；需要一次额外点击，可能损失几十秒', isDefault: true }
      ],
      checkpoint: [
        ['改动摘要', '无（仅调研）'],
        ['下一步', '等权限时机确定后改 tauri.conf.json 与 capabilities']
      ]
    },
    {
      id: 'd5',
      issueKey: 'AB-129',
      state: 'open',
      graceSeconds: 180,
      graceUntil: T0 - 80 * HOUR,
      lockedAt: T0 - 80 * HOUR,
      stopRequestedAt: T0 - 80 * HOUR + 800,
      stopAckAt: T0 - 80 * HOUR + 4000,
      answerRevision: 0,
      answers: [],
      createdBy: 'kb-cli',
      trigger: '规则清单单一真相',
      blockedDownstream: 1,
      question: '便携包自检要不要把 6 个技能名硬编码进 verify-rules？',
      context: '当前自检只校验文件存在。AGENTS.md 的打包约束要求 6 个技能齐全，但清单由 rules-manifest.json 生成，硬编码会形成第二份真相。',
      options: [
        { id: 'a', label: '硬编码 6 个技能名', consequence: '自检最强；新增技能要改两处，容易漏' },
        { id: 'b', label: '读 rules-manifest.json 校验', consequence: '单一清单，少改一处；依赖清单本身正确', isDefault: true }
      ],
      checkpoint: [
        ['改动摘要', '无'],
        ['下一步', '按清单口径改 verify-rules.mjs']
      ]
    },
    {
      id: 'd6',
      issueKey: 'AB-160',
      state: 'grace',
      graceSeconds: 180,
      graceUntil: T0 + 132000,
      lockedAt: null,
      stopRequestedAt: null,
      stopAckAt: null,
      answerRevision: 0,
      answers: [],
      createdBy: 'trae',
      trigger: '详情面板布局',
      blockedDownstream: 0,
      question: '描述区的预览切换放在标题行右侧，还是工具栏？',
      context: '标题行右侧离内容近，但窄屏会挤掉标题；工具栏不抢标题，但多一次视线移动。',
      options: [
        { id: 'a', label: '标题行右侧', consequence: '离内容近；窄屏会挤掉标题，需要折叠成图标', isDefault: true },
        { id: 'b', label: '工具栏', consequence: '不抢标题；需要多一次视线移动' }
      ],
      checkpoint: [
        ['改动摘要', 'DetailPanel.tsx +4 −1'],
        ['下一步', '按位置结论改标题区']
      ]
    },
    {
      id: 'd7',
      issueKey: 'AB-118',
      state: 'answered',
      graceSeconds: 180,
      graceUntil: T0 - 12 * MIN,
      lockedAt: null,
      stopRequestedAt: null,
      stopAckAt: null,
      answeredAt: T0 - 6 * MIN,
      answerRevision: 1,
      answers: [
        { revision: 1, optionId: 'a', by: '你', source: 'web', at: T0 - 6 * MIN }
      ],
      createdBy: 'codex',
      trigger: '卡面信息层级',
      blockedDownstream: 0,
      question: '这张卡的锁标识用徽标还是整卡描边？',
      context: '徽标放在右下角，不抢标题；整卡描边更醒目，但一张卡上会出现两个强调色。',
      options: [
        { id: 'a', label: '徽标（右下角）', consequence: '不抢标题，信息密度高' },
        { id: 'b', label: '整卡描边', consequence: '更醒目，但一张卡两个强调色' }
      ],
      checkpoint: []
    },
    {
      id: 'd8',
      issueKey: 'AB-122',
      state: 'answered',
      graceSeconds: 180,
      graceUntil: T0 - 4 * HOUR,
      lockedAt: null,
      stopRequestedAt: null,
      stopAckAt: null,
      answeredAt: T0 - 3 * HOUR,
      answerRevision: 2,
      answers: [
        { revision: 1, optionId: 'b', by: '你', source: 'cli', at: T0 - 4 * HOUR },
        { revision: 2, optionId: 'a', by: '你', source: 'web', at: T0 - 3 * HOUR }
      ],
      createdBy: 'kb-cli',
      trigger: 'CLI 退出码契约',
      blockedDownstream: 0,
      question: 'kb ask --grace 0 的退出码：0 还是 2？',
      context: '需要明确「拿到答案」与「已上锁」是否共用退出码，脚本才能正确分支。',
      options: [
        { id: 'a', label: '0（与 answered 一致）', consequence: '脚本判 0 就能继续；但无法区分「有答案」和「已上锁」' },
        { id: 'b', label: '2（与 DECISION_LOCKED 一致）', consequence: '脚本能分支；但两件事共用退出码，文档要多写一条' }
      ],
      checkpoint: []
    },
    {
      id: 'd9',
      issueKey: 'AB-150',
      state: 'answered',
      graceSeconds: 180,
      graceUntil: T0 - 27 * HOUR,
      lockedAt: null,
      stopRequestedAt: null,
      stopAckAt: null,
      answeredAt: T0 - 26 * HOUR,
      answerRevision: 1,
      answers: [
        { revision: 1, optionId: 'a', by: '你', source: 'web', at: T0 - 26 * HOUR }
      ],
      createdBy: 'trae',
      trigger: '重试幂等',
      blockedDownstream: 0,
      question: '聊天图片上传失败后重试，是否复用同一个 attachment id？',
      context: '复用可以幂等，但失败原因可能已变化；新建 id 更干净，但会产生孤儿附件记录。',
      options: [
        { id: 'a', label: '复用（幂等）', consequence: '服务端按 id 去重；失败原因会覆盖' },
        { id: 'b', label: '新建 id', consequence: '语义干净；需要清理孤儿附件' }
      ],
      checkpoint: []
    }
  ];

  /* -------------------- 2. 界面状态 -------------------- */

  var state = {
    view: 'decisions',
    filter: 'all',
    sort: 'urgency',
    scene: 'queue',
    narrow: false,
    dark: false,
    notif: 'default',
    expanded: new Set(['d1']),
    selectedOpt: {},
    revising: new Set(),
    leaving: new Set(),
    parked: new Set(),
    withdrawing: null,
    withdrawDraft: {},
    withdrawError: '',
    panelIssue: null,
    flash: null,
    toasts: [],
    undo: new Map(),
    now: T0,
    seq: 0
  };

  var toastTimers = {};
  var FLASH_TIMER = null;

  /* -------------------- 3. 基础工具 -------------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function decisionById(id) {
    for (var i = 0; i < decisions.length; i++) if (decisions[i].id === id) return decisions[i];
    return null;
  }

  function latestAnswer(d) {
    return d.answers.length ? d.answers[d.answers.length - 1] : null;
  }

  function optionById(d, id) {
    for (var i = 0; i < d.options.length; i++) if (d.options[i].id === id) return d.options[i];
    return null;
  }

  function optionLetter(d, id) {
    for (var i = 0; i < d.options.length; i++) if (d.options[i].id === id) return 'ABCDEFG'[i];
    return '?';
  }

  function priorityRank(p) { return p === '高' ? 3 : p === '中' ? 2 : 1; }

  function isStale(d) {
    return d.state === 'open' && d.lockedAt && (state.now - d.lockedAt) >= 72 * HOUR;
  }

  function remainingSec(d) { return (d.graceUntil - state.now) / 1000; }

  function tierOf(d) {
    if (d.state === 'answered') return 'answered';
    if (d.state === 'withdrawn') return 'answered';
    if (d.state === 'grace') return remainingSec(d) <= 60 ? 'critical' : 'grace';
    return isStale(d) ? 'stale' : 'open';
  }

  function fmtCd(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtWait(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' 分 ' + (sec % 60) + ' 秒';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分';
    var d = Math.floor(h / 24);
    return d + ' 天 ' + (h % 24) + ' 小时';
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    if (h < 1) return Math.max(1, Math.floor(sec / 60)) + ' 分钟';
    if (h < 24) return h + ' 小时';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  }

  function rel(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return '刚刚';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  function clock(ts) {
    var d = new Date(ts);
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    return hh + ':' + mm;
  }

  function activeDecisionOf(issueKey) {
    for (var i = 0; i < decisions.length; i++) {
      var d = decisions[i];
      if (d.issueKey === issueKey && (d.state === 'grace' || d.state === 'open') && !state.parked.has(d.id)) return d;
    }
    return null;
  }

  function effectiveStatus(issueKey) {
    var d = activeDecisionOf(issueKey);
    if (d && d.state === 'open') return '待规划';
    return issues[issueKey].status;
  }

  /* -------------------- 4. 分组 / 排序 -------------------- */

  function visibleInflight() {
    var list = decisions.filter(function (d) {
      return (d.state === 'grace' || d.state === 'open') && !state.parked.has(d.id);
    });
    if (state.scene === 'empty') return [];
    if (state.scene === 'single') return list.filter(function (d) { return d.id === 'd1'; });
    if (state.scene === 'long') return list.filter(function (d) { return d.id === 'd3'; });
    return list;
  }

  function visibleAnswered() {
    if (state.scene === 'single' || state.scene === 'long') return [];
    return decisions.filter(function (d) { return d.state === 'answered'; });
  }

  function groupOf(list) {
    var groups = { grace: [], open: [], stale: [], answered: [] };
    list.forEach(function (d) {
      if (d.state === 'grace') groups.grace.push(d);
      else if (d.state === 'open') groups[isStale(d) ? 'stale' : 'open'].push(d);
    });
    groups.grace = sortGroup(groups.grace, 'grace');
    groups.open = sortGroup(groups.open, 'open');
    groups.stale = sortGroup(groups.stale, 'stale');
    groups.answered = visibleAnswered().slice().sort(function (a, b) { return b.answeredAt - a.answeredAt; });
    return groups;
  }

  function sortGroup(list, group) {
    var arr = list.slice();
    if (state.sort === 'waiting') {
      return arr.sort(function (a, b) {
        var sa = a.state === 'open' ? a.lockedAt : a.graceUntil - a.graceSeconds * 1000;
        var sb = b.state === 'open' ? b.lockedAt : b.graceUntil - b.graceSeconds * 1000;
        return sa - sb;
      });
    }
    if (state.sort === 'priority') {
      return arr.sort(function (a, b) {
        return priorityRank(issues[b.issueKey].priority) - priorityRank(issues[a.issueKey].priority);
      });
    }
    if (group === 'grace') return arr.sort(function (a, b) { return a.graceUntil - b.graceUntil; });
    if (group === 'open') {
      return arr.sort(function (a, b) {
        return (b.blockedDownstream - a.blockedDownstream) || (a.lockedAt - b.lockedAt);
      });
    }
    return arr.sort(function (a, b) { return a.lockedAt - b.lockedAt; });
  }

  /* -------------------- 5. 渲染：决策视图 -------------------- */

  var SECTION_META = {
    grace: { title: '正在倒计时', hint: '期内回答，agent 立即继续；到点未答会自动上锁' },
    open: { title: '已锁住 · 等你回答', hint: '任务已回待规划并上锁，回答后才可重新派工' },
    stale: { title: '超时待处置', hint: '超过 72 小时未回答，建议回答或撤回' },
    answered: { title: '刚处理完', hint: '保留下最近记录，可随时改答案' }
  };

  var FILTER_LABEL = { grace: '宽限中', open: '待回答', stale: '已超时', answered: '已回答' };

  function decisionsHtml() {
    var list = visibleInflight();
    var groups = groupOf(list);
    var counts = {
      all: list.length + groups.answered.length,
      grace: groups.grace.length,
      open: groups.open.length,
      stale: groups.stale.length,
      answered: groups.answered.length
    };
    var rankMap = new Map();
    var n = 0;
    ['grace', 'open', 'stale'].forEach(function (key) {
      groups[key].forEach(function (d) { rankMap.set(d.id, ++n); });
    });

    var main = '';
    if (state.filter === 'answered') {
      main = groups.answered.length
        ? sectionHtml('answered', groups.answered, rankMap)
        : filterEmptyHtml('已回答');
    } else if (list.length === 0 && (state.scene === 'empty' || state.filter === 'all')) {
      main = emptyHtml(groups.answered);
    } else if (state.filter !== 'all') {
      var arr = groups[state.filter] || [];
      main = arr.length ? sectionHtml(state.filter, arr, rankMap) : filterEmptyHtml(FILTER_LABEL[state.filter]);
    } else {
      ['grace', 'open', 'stale', 'answered'].forEach(function (key) {
        if (groups[key].length) main += sectionHtml(key, groups[key], rankMap);
      });
      if (!main) main = emptyHtml(groups.answered);
    }

    if (state.parked.size) {
      main += '<div class="parked-bar"><span>本会话已隐藏 ' + state.parked.size + ' 条决策</span>' +
        '<button type="button" data-action="unpark-all">恢复</button></div>';
    }

    return headHtml(list, groups, counts) + '<div class="dv">' + main + '</div>';
  }

  function headHtml(list, groups, counts) {
    var parts = [list.length + ' 条在途'];
    if (groups.grace.length) parts.push(groups.grace.length + ' 条在倒计时');
    if (groups.open.length) parts.push(groups.open.length + ' 条已锁');
    if (groups.stale.length) parts.push(groups.stale.length + ' 条超时待处置');
    if (!list.length) parts.push('现在没有需要你拍板的事');

    var tabs = [
      ['all', '全部', counts.all],
      ['grace', '宽限中', counts.grace],
      ['open', '待回答', counts.open],
      ['stale', '已超时', counts.stale],
      ['answered', '已回答', counts.answered]
    ].map(function (item) {
      var on = state.filter === item[0];
      return '<button type="button" role="tab" class="tab' + (on ? ' is-active' : '') +
        '" aria-selected="' + on + '" data-action="filter" data-filter="' + item[0] + '">' +
        item[1] + ' <b class="tnum">' + item[2] + '</b></button>';
    }).join('');

    return '<div class="view-head"><div class="view-head-inner">' +
      '<div class="title-row">' +
        '<div><h1 class="view-title">待决策</h1>' +
          '<p class="view-summary">' + esc(parts.join(' · ')) + '</p></div>' +
        '<div class="head-actions">' +
          '<button type="button" class="notify-chip' + (state.notif === 'granted' ? ' is-on' : '') +
            '" data-action="notify" aria-pressed="' + (state.notif === 'granted') + '">' +
            iconBell() + '<span>' + (state.notif === 'granted' ? '系统通知已开启' : '开启系统通知') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="filterbar">' +
        '<div class="tabs" role="tablist" aria-label="按状态筛选">' + tabs + '</div>' +
        '<label class="sort">排序 ' +
          '<select data-action="sort" aria-label="排序方式">' +
            '<option value="urgency"' + (state.sort === 'urgency' ? ' selected' : '') + '>紧急度</option>' +
            '<option value="waiting"' + (state.sort === 'waiting' ? ' selected' : '') + '>等待最久</option>' +
            '<option value="priority"' + (state.sort === 'priority' ? ' selected' : '') + '>任务优先级</option>' +
          '</select>' +
        '</label>' +
      '</div>' +
    '</div></div>';
  }

  function sectionHtml(key, arr, rankMap) {
    var meta = SECTION_META[key];
    var items = arr.map(function (d) {
      return key === 'answered' ? answeredCardHtml(d, rankMap) : cardHtml(d, rankMap);
    }).join('');
    return '<section class="section" aria-labelledby="sec-' + key + '">' +
      '<div class="section-head">' +
        '<h2 id="sec-' + key + '">' + meta.title + '</h2>' +
        '<span class="section-count tnum">' + arr.length + '</span>' +
        '<span class="section-hint">' + meta.hint + '</span>' +
      '</div>' + items + '</section>';
  }

  function cardHtml(d, rankMap) {
    var tier = tierOf(d);
    var expanded = state.expanded.has(d.id);
    var issue = issues[d.issueKey];
    var related = relatedDecisions(d);
    var selected = state.selectedOpt[d.id];
    var opt = selected ? optionById(d, selected) : null;
    var cls = 'dcard tier-' + tier + (tier === 'critical' ? ' is-critical' : '') +
      (expanded ? ' is-expanded' : '') + (state.leaving.has(d.id) ? ' is-leaving' : '');

    return '<article class="' + cls + '" data-id="' + d.id + '" aria-labelledby="q-' + d.id + '">' +
      '<span class="rail" aria-hidden="true"></span>' +
      '<div class="dc-head">' +
        '<span class="dc-rank tnum">#' + (rankMap.get(d.id) || '') + '</span>' +
        statusChip(d) +
        '<button type="button" class="dc-issue" data-action="open-issue" data-issue="' + issue.key + '" title="打开任务卡">' +
          '<span class="issue-key">' + issue.key + '</span>' +
          '<span class="issue-title">' + esc(issue.title) + '</span>' +
        '</button>' +
        '<span class="prio prio-' + esc(issue.priority) + '">' + esc(issue.priority) + '</span>' +
        (related.length ? '<span class="dc-note">同卡 ' + related.length + ' 条历史</span>' : '') +
        '<button type="button" class="icon-btn" data-action="open-issue" data-issue="' + issue.key + '" aria-label="打开任务卡 ' + issue.key + '">' + iconArrow() + '</button>' +
      '</div>' +
      '<p class="dc-question" id="q-' + d.id + '">' + esc(d.question) + '</p>' +
      optionsChipsHtml(d, selected) +
      '<p class="dc-cons' + (opt ? '' : ' is-muted') + '">' +
        (opt ? '选 ' + optionLetter(d, opt.id) + '：' + esc(opt.consequence)
             : (defaultOption(d) ? '默认 ' + optionLetter(d, defaultOption(d).id) + '：' + esc(defaultOption(d).consequence) : '选择后在此显示后果')) +
      '</p>' +
      '<div class="dc-foot">' +
        '<div class="dc-stats">' + statsHtml(d) + '</div>' +
        '<div class="dc-actions">' +
          (d.state === 'open'
            ? '<button type="button" class="btn btn-ghost btn-sm" data-action="park" data-id="' + d.id + '" title="仅本会话隐藏，不改变任务状态">稍后</button>' +
              '<button type="button" class="btn btn-danger btn-sm" data-action="withdraw-start" data-id="' + d.id + '">撤回</button>'
            : '') +
          '<button type="button" class="btn btn-ghost" data-action="toggle-expand" data-id="' + d.id + '" aria-expanded="' + expanded + '">' + (expanded ? '收起' : '展开') + '</button>' +
          '<button type="button" class="btn btn-primary" data-action="submit-answer" data-id="' + d.id + '"' + (selected ? '' : ' disabled') + '>提交回答</button>' +
        '</div>' +
      '</div>' +
      (d.state === 'grace' ? progressHtml(d) : '') +
      (expanded ? bodyHtml(d) : '') +
      (state.leaving.has(d.id) ? '<div class="leave-overlay" role="status">已记录 · 正在移出</div>' : '') +
    '</article>';
  }

  function answeredCardHtml(d, rankMap) {
    var expanded = state.expanded.has(d.id);
    var revising = state.revising.has(d.id);
    var issue = issues[d.issueKey];
    var answer = latestAnswer(d);
    var answerOpt = answer ? optionById(d, answer.optionId) : null;
    var selected = state.selectedOpt[d.id];
    var related = relatedDecisions(d);

    return '<article class="dcard tier-answered' + (expanded || revising ? ' is-expanded' : '') + '" data-id="' + d.id + '">' +
      '<span class="rail" aria-hidden="true"></span>' +
      '<div class="dc-head">' +
        '<span class="chip chip-done">已回答 · 第 ' + d.answerRevision + ' 版</span>' +
        '<button type="button" class="dc-issue" data-action="open-issue" data-issue="' + issue.key + '">' +
          '<span class="issue-key">' + issue.key + '</span>' +
          '<span class="issue-title">' + esc(issue.title) + '</span>' +
        '</button>' +
        '<span class="dc-note">' + rel(d.answeredAt) + '</span>' +
        '<button type="button" class="icon-btn" data-action="open-issue" data-issue="' + issue.key + '" aria-label="打开任务卡 ' + issue.key + '">' + iconArrow() + '</button>' +
      '</div>' +
      '<p class="dc-question">' + esc(d.question) + '</p>' +
      (revising
        ? optionsChipsHtml(d, selected) +
          '<p class="dc-cons' + (selected ? '' : ' is-muted') + '">' +
            (selected ? '改为 ' + optionLetter(d, selected) + '：' + esc(optionById(d, selected).consequence) : '选择新答案后保存修订') + '</p>'
        : '<p class="dc-answer">已选 <b>' + (answerOpt ? optionLetter(d, answerOpt.id) + ' · ' + esc(answerOpt.label) : '—') + '</b>' +
          '<span class="sep">·</span>' + esc(answer.by) + '（' + esc(answer.source) + '）' +
          '<span class="sep">·</span>' + rel(answer.at) + '</p>') +
      '<div class="dc-foot">' +
        '<div class="dc-stats">' + (related.length ? '同卡还有 ' + related.length + ' 条相关决策' : '回答已同步到任务卡') + '</div>' +
        '<div class="dc-actions">' +
          (revising
            ? '<button type="button" class="btn btn-ghost" data-action="cancel-revise" data-id="' + d.id + '">取消</button>' +
              '<button type="button" class="btn btn-primary" data-action="submit-answer" data-id="' + d.id + '"' + (selected ? '' : ' disabled') + '>保存第 ' + (d.answerRevision + 1) + ' 版</button>'
            : '<button type="button" class="btn" data-action="revise" data-id="' + d.id + '">改答案</button>' +
              '<button type="button" class="btn btn-ghost" data-action="toggle-expand" data-id="' + d.id + '" aria-expanded="' + expanded + '">' + (expanded ? '收起' : '展开') + '</button>') +
        '</div>' +
      '</div>' +
      ((expanded || revising) ? bodyHtml(d) : '') +
    '</article>';
  }

  function optionsChipsHtml(d, selected) {
    return '<div class="dc-opts" role="radiogroup" aria-label="答案选项">' +
      d.options.map(function (o) {
        return '<button type="button" role="radio" aria-checked="' + (selected === o.id) + '"' +
          ' class="opt-chip' + (selected === o.id ? ' is-selected' : '') + '"' +
          ' data-action="select-option" data-id="' + d.id + '" data-opt="' + o.id + '"' +
          ' title="' + esc(o.consequence) + '">' +
          '<span class="opt-letter">' + optionLetter(d, o.id) + '</span>' +
          '<span>' + esc(o.label) + '</span>' +
        '</button>';
      }).join('') + '</div>';
  }

  function statsHtml(d) {
    var bits = [];
    if (d.state === 'answered') {
      bits.push('已同步到任务卡');
      bits.push(esc(issues[d.issueKey].status));
    } else {
      bits.push('提问 ' + esc(d.createdBy));
      bits.push('触发 ' + esc(d.trigger));
      bits.push(d.blockedDownstream ? '阻塞 ' + d.blockedDownstream + ' 个下游' : '无下游阻塞');
      if (d.state === 'open') {
        if (d.stopAckAt && d.stopRequestedAt) {
          bits.push('<span>停止已确认 · ' + Math.max(1, Math.round((d.stopAckAt - d.stopRequestedAt) / 1000)) + ' 秒</span>');
        } else {
          bits.push('<span class="warn">停止未确认</span>');
        }
      }
    }
    return bits.map(function (b, i) {
      return (i ? '<span class="sep">·</span>' : '') + '<span>' + b + '</span>';
    }).join('');
  }

  function statusChip(d) {
    if (d.state === 'grace') {
      var critical = remainingSec(d) <= 60;
      return '<span class="chip ' + (critical ? 'chip-critical' : 'chip-accent') + ' tnum" role="timer" data-countdown="' + d.id + '">剩 ' + fmtCd(remainingSec(d)) + '</span>' +
        (critical ? '<span class="chip chip-critical chip-note">即将落锁</span>' : '');
    }
    var stale = isStale(d);
    return '<span class="chip ' + (stale ? 'chip-critical' : 'chip-muted') + ' tnum" data-waiting="' + d.id + '">' +
      (stale ? '超时 ' + fmtDuration(state.now - d.lockedAt) : '已锁 ' + fmtWait((state.now - d.lockedAt) / 1000)) +
    '</span>' + (stale ? '<span class="chip chip-critical chip-note">建议处置</span>' : '');
  }

  function progressHtml(d) {
    var pct = Math.max(0, Math.min(100, (remainingSec(d) / d.graceSeconds) * 100));
    return '<div class="dc-progress" aria-hidden="true"><span data-progress="' + d.id + '" style="width:' + pct.toFixed(1) + '%"></span></div>';
  }

  function bodyHtml(d) {
    var parts = [];
    var issue = issues[d.issueKey];

    if (d.context) {
      parts.push('<section><h3 class="block-title">背景</h3><p class="context">' + esc(d.context) + '</p></section>');
    }

    parts.push('<section><h3 class="block-title">选项与后果</h3><ul class="opt-list">' +
      d.options.map(function (o) {
        var on = state.selectedOpt[d.id] === o.id || (!state.revising.has(d.id) && d.state === 'answered' && latestAnswer(d) && latestAnswer(d).optionId === o.id);
        return '<li><button type="button" class="opt-row' + (on ? ' is-selected' : '') + '" data-action="select-option" data-id="' + d.id + '" data-opt="' + o.id + '">' +
          '<span class="opt-letter">' + optionLetter(d, o.id) + '</span>' +
          '<span class="opt-main"><span class="opt-label">' + esc(o.label) +
            (o.isDefault ? '<span class="opt-default">默认</span>' : '') + '</span>' +
            '<span class="opt-cons">' + esc(o.consequence) + '</span></span>' +
        '</button></li>';
      }).join('') + '</ul></section>');

    parts.push('<div class="kv-grid">' + kvHtml(d, issue) + '</div>');

    if (d.checkpoint && d.checkpoint.length) {
      parts.push('<section><h3 class="block-title">agent 断点</h3><ul class="ckpt">' +
        d.checkpoint.map(function (row) {
          return '<li><span>' + esc(row[0]) + '</span><b>' + esc(row[1]) + '</b></li>';
        }).join('') + '</ul></section>');
    }

    if (d.state === 'answered' || d.answers.length) {
      parts.push('<section><h3 class="block-title">答案时间线</h3>' + timelineHtml(d) + '</section>');
    }

    var related = relatedDecisions(d);
    if (related.length) {
      parts.push('<section><h3 class="block-title">同一张任务卡</h3>' +
        related.map(function (r) {
          var label = r.state === 'answered'
            ? '已回答 ' + rel(r.answeredAt) + ' · ' + optionLabelText(r)
            : (r.state === 'open' ? '已锁 ' + fmtWait((state.now - r.lockedAt) / 1000) : '约会话中 · 剩 ' + fmtCd(remainingSec(r)));
          return '<button type="button" class="related" data-action="go-decision" data-id="' + r.id + '">' +
            '<b>' + esc(r.question) + '</b><span>' + esc(label) + '</span><span class="arrow" aria-hidden="true">→</span>' +
          '</button>';
        }).join('') + '</section>');
    }

    if (d.state === 'open' && state.withdrawing === d.id) {
      parts.push('<section class="withdraw-form">' +
        '<label class="block-title" for="wd-' + d.id + '">撤回理由（会写进卡评论）</label>' +
        '<textarea id="wd-' + d.id + '" data-withdraw-input="' + d.id + '" placeholder="例如：方案已过时，改走 FTS5">' + esc(state.withdrawDraft[d.id] || '') + '</textarea>' +
        (state.withdrawError ? '<p class="form-error">' + esc(state.withdrawError) + '</p>' : '') +
        '<div class="form-actions">' +
          '<button type="button" class="btn btn-ghost" data-action="withdraw-cancel" data-id="' + d.id + '">取消</button>' +
          '<button type="button" class="btn btn-danger" data-action="withdraw-confirm" data-id="' + d.id + '">确认撤回并解锁</button>' +
        '</div>' +
      '</section>');
    }

    return '<div class="dc-body">' + parts.join('') + '</div>';
  }

  function kvHtml(d, issue) {
    var cells = [];
    cells.push(kv('阻塞下游', d.blockedDownstream ? d.blockedDownstream + ' 张卡' : '无', d.blockedDownstream ? 'is-warn' : ''));
    if (d.state === 'grace') {
      cells.push(kv('本次宽限', d.graceSeconds + ' 秒', ''));
      cells.push(kv('任务优先级', issue.priority, ''));
    } else if (d.state === 'open') {
      cells.push(kv('已锁时长', fmtWait((state.now - d.lockedAt) / 1000), isStale(d) ? 'is-warn' : ''));
      cells.push(d.stopAckAt
        ? kv('停止确认', Math.max(1, Math.round((d.stopAckAt - d.stopRequestedAt) / 1000)) + ' 秒', 'is-ok')
        : kv('停止确认', '未确认', 'is-warn'));
    } else {
      cells.push(kv('回答版本', '第 ' + d.answerRevision + ' 版', ''));
      cells.push(kv('首答时间', clock(d.answers[0].at), ''));
    }
    return cells.join('');
  }

  function kv(label, value, cls) {
    return '<div class="kv"><span>' + esc(label) + '</span><b class="' + (cls || '') + '">' + esc(value) + '</b></div>';
  }

  function timelineHtml(d) {
    if (!d.answers.length) return '<p class="context">还没有回答。</p>';
    return '<ol class="timeline">' + d.answers.map(function (a, i) {
      var o = optionById(d, a.optionId);
      return '<li class="' + (i === d.answers.length - 1 ? 'is-current' : '') + '">' +
        '<span class="tl-rev">第 ' + a.revision + ' 版</span>' +
        optionLetter(d, a.optionId) + ' · ' + esc(o ? o.label : a.optionId) +
        ' <span class="tl-meta">· ' + esc(a.by) + '（' + esc(a.source) + '）· ' + rel(a.at) + '</span>' +
      '</li>';
    }).join('') + '</ol>';
  }

  function optionLabelText(d) {
    var a = latestAnswer(d);
    var o = a ? optionById(d, a.optionId) : null;
    return o ? optionLetter(d, o.id) + ' · ' + o.label : '';
  }

  function relatedDecisions(d) {
    return decisions.filter(function (x) {
      return x.id !== d.id && x.issueKey === d.issueKey && x.state !== 'withdrawn';
    });
  }

  function defaultOption(d) {
    for (var i = 0; i < d.options.length; i++) if (d.options[i].isDefault) return d.options[i];
    return null;
  }

  function emptyHtml(answered) {
    var recent = answered.slice(0, 3).map(function (d) {
      return '<button type="button" class="related" data-action="go-decision" data-id="' + d.id + '">' +
        '<b>' + esc(d.question) + '</b><span>' + esc(optionLabelText(d)) + '</span><span class="arrow" aria-hidden="true">→</span>' +
      '</button>';
    }).join('');

    return '<div class="empty">' +
      '<div class="empty-mark" aria-hidden="true">' + iconInboxCheck() + '</div>' +
      '<h2>现在没有需要你拍板的事</h2>' +
      '<p>agent 只在长任务走到「无法自动判定」时才会提问。提问会进入这里，宽限默认 3 分钟；到点未答的任务会自动回到待规划并上锁。</p>' +
      '<div class="empty-cta">' +
        '<button type="button" class="btn btn-primary" data-action="switch-view" data-view="board">去任务看板</button>' +
        (state.scene !== 'empty'
          ? '<button type="button" class="btn" data-action="scene" data-scene="queue">恢复演示队列</button>'
          : '<button type="button" class="btn" data-action="scene" data-scene="queue">载入演示队列</button>') +
      '</div>' +
      '<div class="tips">' +
        '<div class="tip"><span class="tip-num">01</span><div><b>宽限默认 3 分钟</b><span>期内回答，agent 立即继续，不用重新领卡；超时才停手。</span></div></div>' +
        '<div class="tip"><span class="tip-num">02</span><div><b>通知是前置条件</b><span>系统通知 + 侧栏徽标 + 顶部汇总条三件套；页面关闭时收不到。</span></div></div>' +
        '<div class="tip"><span class="tip-num">03</span><div><b>锁住不等于失败</b><span>回答后卡解锁回到待规划，agent 从断点重新 claim 续跑。</span></div></div>' +
      '</div>' +
      (recent ? '<div class="empty-recent"><h3>刚处理完</h3>' + recent + '</div>' : '') +
    '</div>';
  }

  function filterEmptyHtml(label) {
    return '<div class="filter-empty">当前筛选「' + esc(label) + '」下没有条目。' +
      '<div><button type="button" data-action="filter" data-filter="all">清除筛选</button></div></div>';
  }

  /* -------------------- 6. 渲染：任务看板 -------------------- */

  function boardHtml() {
    var cols = ['待规划', '进行中', '待验收'];
    var list = Object.keys(issues).map(function (k) { return issues[k]; });

    var body = cols.map(function (status) {
      var cards = list.filter(function (it) { return effectiveStatus(it.key) === status; });
      return '<section class="col" aria-labelledby="col-' + status + '">' +
        '<div class="col-head" id="col-' + status + '">' + status + '<span class="count tnum">' + cards.length + '</span></div>' +
        cards.map(function (it) { return boardCardHtml(it); }).join('') +
      '</section>';
    }).join('');

    return '<div class="board-head"><div class="title-row">' +
        '<div><h1 class="view-title">任务看板</h1>' +
        '<p class="view-summary">演示卡与决策的双向跳转：点卡面 [待决策] 进入决策区，点标题打开详情。</p></div>' +
        '<span class="board-note">锁卡不可派工 · 回答后才解锁</span>' +
      '</div></div>' +
      '<div class="board">' + body + '</div>';
  }

  function boardCardHtml(issue) {
    var d = activeDecisionOf(issue.key);
    var status = effectiveStatus(issue.key);
    var locked = !!(d && d.state === 'open');
    var tier = d ? (d.state === 'grace' ? (remainingSec(d) <= 60 ? 'critical' : 'grace') : (isStale(d) ? 'stale' : 'open')) : '';
    var mark = '';

    if (d) {
      var text;
      var cls = 'mark';
      if (d.state === 'grace') {
        if (remainingSec(d) <= 60) cls += ' is-critical';
        text = '待决策 · 剩 ' + fmtCd(remainingSec(d));
      } else if (isStale(d)) {
        cls += ' is-critical';
        text = '待决策 · 超时 ' + fmtDuration(state.now - d.lockedAt);
      } else {
        cls += ' is-open';
        text = '待决策 · 已等 ' + fmtWait((state.now - d.lockedAt) / 1000);
      }
      mark = '<button type="button" class="' + cls + '" data-action="go-decision" data-id="' + d.id + '" data-countdown="' + d.id + '">' +
        iconLock() + '<span>' + text + '</span></button>';
    }

    return '<div class="bcard' + (locked ? ' is-locked' : '') + (tier ? ' tier-' + tier : '') + '">' +
      '<span class="rail" aria-hidden="true" style="background:' + (locked ? 'var(--ab-ink-3)' : 'var(--ab-accent)') + '"></span>' +
      '<button type="button" class="bcard-title-btn" data-action="open-issue" data-issue="' + issue.key + '">' +
        '<span class="bcard-title">' + esc(issue.title) + '</span></button>' +
      '<div class="bcard-labels">' + issue.labels.map(function (l) {
        return '<span class="bcard-label">' + esc(l) + '</span>';
      }).join('') + '</div>' +
      '<div class="bcard-meta">' +
        '<span class="prio prio-' + esc(issue.priority) + '">' + esc(issue.priority) + '</span>' +
        '<span>' + (issue.claimedBy ? esc(issue.claimedBy) : '未派工') + '</span>' +
        (locked ? '<span>· 已上锁</span>' : '') +
        (mark ? '<span style="margin-left:auto">' + mark + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  /* -------------------- 7. 渲染：右侧任务详情 -------------------- */

  function panelHtml(issue) {
    var d = activeDecisionOf(issue.key);
    var answered = decisions.filter(function (x) { return x.issueKey === issue.key && x.state === 'answered'; })
      .sort(function (a, b) { return b.answeredAt - a.answeredAt; })[0];
    var shown = d || answered;
    var blocks = [];

    blocks.push('<div class="panel-meta">' +
      '<span class="chip ' + (d && d.state === 'open' ? 'chip-critical' : d ? 'chip-accent' : 'chip-muted') + '">' +
        (d ? (d.state === 'open' ? '已锁' : '宽限中') : effectiveStatus(issue.key)) + '</span>' +
      '<span class="chip chip-muted">' + esc(issue.priority) + ' 优先</span>' +
      issue.labels.map(function (l) { return '<span class="bcard-label">' + esc(l) + '</span>'; }).join('') +
      (issue.parent ? '<span class="dc-note">父卡 ' + issue.parent + '</span>' : '') +
    '</div>');

    if (shown) {
      blocks.push(decisionBoxHtml(shown));
    } else {
      blocks.push('<div class="filter-empty" style="margin-top:0">该卡当前没有待决策。</div>');
    }

    blocks.push('<section class="panel-block"><h4>描述</h4><p class="panel-desc">' + esc(issue.desc) + '</p></section>');

    blocks.push('<section class="panel-block"><h4>评论</h4>' +
      '<div class="panel-comment"><span class="avatar" aria-hidden="true">代</span>' +
        '<div><b>' + esc(issue.claimedBy || 'agent') + '</b> <span class="tl-meta">· 12 分钟前</span><br>已按断点停在工作树干净的状态，等你拍板。</div></div>' +
    '</section>');

    return '<div class="panel-head">' +
        '<span class="panel-key">' + issue.key + '</span>' +
        '<span class="panel-title">' + esc(issue.title) + '</span>' +
        '<button type="button" class="icon-btn" style="margin-left:auto" data-action="close-panel" aria-label="关闭详情">&times;</button>' +
      '</div>' +
      '<div class="panel-body">' + blocks.join('') + '</div>' +
      '<div class="panel-foot">' +
        (shown ? '<button type="button" class="btn" data-action="panel-to-decision" data-id="' + shown.id + '">在待决策区查看</button>' : '') +
        '<button type="button" class="btn btn-primary" data-action="close-panel">关闭</button>' +
      '</div>';
  }

  function decisionBoxHtml(d) {
    var isAnswered = d.state === 'answered';
    var selected = state.selectedOpt[d.id];
    var answer = latestAnswer(d);
    var answerOpt = answer ? optionById(d, answer.optionId) : null;

    return '<div class="dbox">' +
      '<div class="dbox-head">' +
        '<span class="dbox-label">' + (isAnswered ? '已处理的决策' : '待决策') + '</span>' +
        (d.state === 'grace' ? '<span class="chip chip-accent tnum" data-countdown="' + d.id + '">剩 ' + fmtCd(remainingSec(d)) + '</span>' : '') +
        (d.state === 'open' ? '<span class="chip ' + (isStale(d) ? 'chip-critical' : 'chip-muted') + ' tnum">' + (isStale(d) ? '超时 ' : '已锁 ') + (isStale(d) ? fmtDuration(state.now - d.lockedAt) : fmtWait((state.now - d.lockedAt) / 1000)) + '</span>' : '') +
        (isAnswered ? '<span class="chip chip-done">第 ' + d.answerRevision + ' 版</span>' : '') +
      '</div>' +
      '<p class="dbox-q">' + esc(d.question) + '</p>' +
      (d.context ? '<p class="dbox-ctx">' + esc(d.context.split('\n')[0]) + '</p>' : '') +
      (isAnswered
        ? '<p class="dbox-answer">已选 <b>' + (answerOpt ? optionLetter(d, answerOpt.id) + ' · ' + esc(answerOpt.label) : '—') + '</b> · ' + esc(answer.by) + ' · ' + rel(answer.at) + '</p>' +
          '<div class="dc-foot"><div class="dc-stats">' + relatedText(d) + '</div>' +
            '<div class="dc-actions"><button type="button" class="btn btn-sm" data-action="revise" data-id="' + d.id + '">改答案</button>' +
            '<button type="button" class="btn btn-sm" data-action="toggle-expand" data-id="' + d.id + '">' + (state.expanded.has(d.id) ? '收起详情' : '展开详情') + '</button></div></div>' +
          (state.expanded.has(d.id) ? '<div style="margin-top:8px">' + timelineHtml(d) + '</div>' : '')
        : '<ul class="opt-list">' + d.options.map(function (o) {
            return '<li><button type="button" class="opt-row' + (selected === o.id ? ' is-selected' : '') + '" data-action="select-option" data-id="' + d.id + '" data-opt="' + o.id + '">' +
              '<span class="opt-letter">' + optionLetter(d, o.id) + '</span>' +
              '<span class="opt-main"><span class="opt-label">' + esc(o.label) +
                (o.isDefault ? '<span class="opt-default">默认</span>' : '') + '</span>' +
                '<span class="opt-cons">' + esc(o.consequence) + '</span></span>' +
            '</button></li>';
          }).join('') + '</ul>' +
          '<div class="dc-foot"><div class="dc-stats">' + statsHtml(d) + '</div>' +
            '<div class="dc-actions"><button type="button" class="btn btn-primary" data-action="submit-answer" data-id="' + d.id + '"' + (selected ? '' : ' disabled') + '>提交回答</button></div></div>' +
          '<p class="dbox-note">回答后卡会解锁并回到待规划，agent 需重新 claim 才能续跑；改写答案不会自动重跑。</p>') +
    '</div>';
  }

  function relatedText(d) {
    var related = relatedDecisions(d);
    if (!related.length) return '回答已同步到任务卡';
    return '同卡还有 ' + related.length + ' 条相关决策';
  }

  /* -------------------- 8. 渲染收尾：侧栏 / 面板 / toast / 焦点 -------------------- */

  function render() {
    state.now = Date.now();
    var focus = captureFocus();
    var root = $('#view-root');
    var scroll = root.scrollTop;

    if (state.view === 'decisions') root.innerHTML = decisionsHtml();
    else if (state.view === 'board') root.innerHTML = boardHtml();
    else root.innerHTML = placeholderHtml();

    root.scrollTop = scroll;
    renderPanel();
    renderToasts();
    renderChrome();
    restoreFocus(focus);
    if (state.flash) applyFlash(state.flash);
  }

  function placeholderHtml() {
    var names = { tree: '任务树', knowledge: '知识库', log: '日志', chat: '聊天' };
    return '<div class="placeholder"><b>' + esc(names[state.view] || '视图') + '</b>' +
      '本原型只覆盖「任务看板」与「待决策」两条路径，其它入口保留导航位置，不在此演示。</div>';
  }

  function renderChrome() {
    $all('[data-action="switch-view"]').forEach(function (b) {
      var on = b.dataset.view === state.view;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    var badge = $('#sb-decisions-badge');
    var inflight = decisions.filter(function (d) {
      return (d.state === 'grace' || d.state === 'open') && !state.parked.has(d.id);
    }).length;
    badge.textContent = String(inflight);
    badge.classList.toggle('is-zero', inflight === 0);

    $all('[data-action="scene"]').forEach(function (b) {
      var on = b.dataset.scene === state.scene;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    var narrowBtn = $('[data-action="toggle-narrow"]');
    narrowBtn.classList.toggle('is-on', state.narrow);
    narrowBtn.setAttribute('aria-pressed', String(state.narrow));

    var themeBtn = $('.proto-group [data-action="theme"]');
    if (themeBtn) themeBtn.textContent = state.dark ? '浅色' : '深色';

    $('#stage').classList.toggle('is-narrow', state.narrow);
    $('#app-shell').classList.toggle('is-narrow', state.narrow);
    document.documentElement.classList.toggle('dark', state.dark);
  }

  function renderPanel() {
    var panel = $('#panel');
    var backdrop = $('#panel-backdrop');
    if (!state.panelIssue || !issues[state.panelIssue]) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      panel.innerHTML = '';
      backdrop.classList.remove('is-open');
      backdrop.hidden = true;
      state.panelIssue = null;
      return;
    }
    panel.innerHTML = panelHtml(issues[state.panelIssue]);
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    backdrop.classList.add('is-open');
  }

  function renderToasts() {
    var wrap = $('#toast-wrap');
    wrap.innerHTML = state.toasts.map(function (t) {
      return '<div class="toast ' + (t.kind === 'warn' ? 'is-warn' : t.kind === 'done' ? 'is-done' : '') + '" role="status">' +
        '<span class="toast-text">' + esc(t.text) + '</span>' +
        (t.undoToken ? '<button type="button" data-action="undo" data-token="' + t.undoToken + '">撤销</button>' : '') +
        (t.actionLabel ? '<button type="button" data-action="' + t.action + '" data-token="' + (t.actionToken || '') + '">' + esc(t.actionLabel) + '</button>' : '') +
      '</div>';
    }).join('');
  }

  function captureFocus() {
    var a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.action) return null;
    return { action: a.dataset.action, id: a.dataset.id || '', opt: a.dataset.opt || '' };
  }

  function restoreFocus(f) {
    if (!f) return;
    var sel = '[data-action="' + f.action + '"]' + (f.id ? '[data-id="' + f.id + '"]' : '') + (f.opt ? '[data-opt="' + f.opt + '"]' : '');
    var el = document.querySelector(sel);
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  function applyFlash(id) {
    var el = document.querySelector('.dcard[data-id="' + id + '"]') || document.querySelector('.related[data-id="' + id + '"]');
    state.flash = null;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('is-flash');
    clearTimeout(FLASH_TIMER);
    FLASH_TIMER = setTimeout(function () { el.classList.remove('is-flash'); }, 1500);
  }

  function pushToast(opts) {
    var id = 't' + (++state.seq);
    var toast = {
      id: id,
      text: opts.text,
      kind: opts.kind || 'info',
      undoToken: opts.undoToken || null,
      action: opts.action || null,
      actionLabel: opts.actionLabel || null,
      actionToken: opts.actionToken || null
    };
    state.toasts.push(toast);
    var ttl = opts.ttl || 5000;
    clearTimeout(toastTimers[id]);
    toastTimers[id] = setTimeout(function () { removeToast(id); }, ttl);
  }

  function removeToast(id) {
    var before = state.toasts.length;
    state.toasts = state.toasts.filter(function (t) { return t.id !== id; });
    if (state.toasts.length !== before) render();
  }

  /* -------------------- 9. 交互动作 -------------------- */

  function answer(d, optionId) {
    var now = Date.now();
    if (d.state === 'answered') {
      var rev = d.answerRevision + 1;
      d.answers.push({ revision: rev, optionId: optionId, by: '你', source: 'web', at: now });
      d.answerRevision = rev;
      d.answeredAt = now;
      state.revising.delete(d.id);
      delete state.selectedOpt[d.id];
      pushToast({ text: '答案已修订为第 ' + rev + ' 版', kind: 'done' });
      render();
      return;
    }
    if (state.leaving.has(d.id)) return;

    state.leaving.add(d.id);
    render();
    var delay = prefersReducedMotion() ? 0 : 420;

    setTimeout(function () {
      var prev = {
        state: d.state,
        answeredAt: d.answeredAt,
        answerRevision: d.answerRevision,
        answers: d.answers.map(function (a) { return Object.assign({}, a); }),
        lockedAt: d.lockedAt,
        stopRequestedAt: d.stopRequestedAt,
        stopAckAt: d.stopAckAt
      };
      d.state = 'answered';
      d.answeredAt = Date.now();
      d.answerRevision = 1;
      d.answers = [{ revision: 1, optionId: optionId, by: '你', source: 'web', at: Date.now() }];
      d.lockedAt = null;
      d.stopRequestedAt = null;
      d.stopAckAt = null;
      state.leaving.delete(d.id);
      delete state.selectedOpt[d.id];

      var token = 'u' + (++state.seq);
      state.undo.set(token, { id: d.id, prev: prev });
      pushToast({ text: '已回答 ' + d.issueKey + ' · 5 秒内可撤销', kind: 'done', undoToken: token, ttl: 6000 });
      render();
    }, delay);
  }

  function undo(token) {
    var entry = state.undo.get(token);
    if (!entry) return;
    var d = decisionById(entry.id);
    if (!d) return;
    Object.keys(entry.prev).forEach(function (k) { d[k] = entry.prev[k]; });
    state.undo.delete(token);
    state.toasts = state.toasts.filter(function (t) { return t.undoToken !== token; });
    pushToast({ text: '已撤销回答', kind: 'info' });
    render();
  }

  function toggleExpand(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    render();
  }

  function selectOption(id, optId) {
    var d = decisionById(id);
    if (!d) return;
    if (d.state === 'answered' && !state.revising.has(d.id)) {
      state.revising.add(d.id);
    }
    state.selectedOpt[id] = optId;
    state.withdrawError = '';
    render();
  }

  function goDecision(id) {
    var d = decisionById(id);
    if (!d) return;
    if (state.scene === 'single' || state.scene === 'long') state.scene = 'queue';
    state.filter = 'all';
    state.view = 'decisions';
    state.expanded.add(id);
    state.panelIssue = null;
    state.flash = id;
    render();
  }

  function withdraw(id) {
    var d = decisionById(id);
    if (!d) return;
    var reason = (state.withdrawDraft[id] || '').trim();
    if (reason.length < 2) {
      state.withdrawError = '请写一句撤回理由（至少 2 个字）';
      render();
      return;
    }
    d.state = 'withdrawn';
    d.withdrawnAt = Date.now();
    d.withdrawReason = reason;
    state.withdrawing = null;
    state.withdrawError = '';
    delete state.withdrawDraft[id];
    pushToast({ text: '问题已撤回，' + d.issueKey + ' 已解锁', kind: 'done' });
    render();
  }

  function fastForward() {
    decisions.forEach(function (d) {
      if (d.state === 'grace') d.graceUntil -= 60000;
    });
    pushToast({ text: '已把所有宽限倒计时快进 60 秒', kind: 'info', ttl: 3500 });
    tick();
    render();
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* -------------------- 10. 倒计时 -------------------- */

  function tick() {
    var now = Date.now();
    var needRender = false;

    decisions.forEach(function (d) {
      if (d.state !== 'grace') return;
      var rem = (d.graceUntil - now) / 1000;
      if (rem <= 0) {
        d.state = 'open';
        d.lockedAt = now;
        d.stopRequestedAt = now;
        d.stopAckAt = null;
        d.warned = true;
        pushToast({ text: d.issueKey + ' 宽限结束：任务卡已回待规划并上锁，agent 收到停止信号', kind: 'warn', ttl: 7000 });
        needRender = true;
      } else if (rem <= 60 && !d.warned) {
        d.warned = true;
        needRender = true;
      }
    });

    state.now = now;
    updateTimers();
    if (needRender) render();
  }

  function updateTimers() {
    $all('[data-countdown]').forEach(function (el) {
      var d = decisionById(el.dataset.countdown);
      if (!d || d.state !== 'grace') return;
      var text = '剩 ' + fmtCd(remainingSec(d));
      // 看板卡上的 .mark 内部是「锁图标 + 文案」：只改文案，不能整体覆盖 textContent（会吃掉图标）
      if (el.classList.contains('mark')) {
        var span = el.querySelector('span');
        if (span) span.textContent = '待决策 · ' + text;
      } else {
        el.textContent = text;
      }
    });
    $all('[data-waiting]').forEach(function (el) {
      var d = decisionById(el.dataset.waiting);
      if (!d || d.state !== 'open') return;
      el.textContent = (isStale(d) ? '超时 ' : '已锁 ') + (isStale(d) ? fmtDuration(state.now - d.lockedAt) : fmtWait((state.now - d.lockedAt) / 1000));
    });
    $all('[data-progress]').forEach(function (el) {
      var d = decisionById(el.dataset.progress);
      if (!d || d.state !== 'grace') return;
      var pct = Math.max(0, Math.min(100, (remainingSec(d) / d.graceSeconds) * 100));
      el.style.width = pct.toFixed(1) + '%';
    });
  }

  /* -------------------- 11. 事件绑定 -------------------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.dataset.action;

    if (action === 'switch-view') {
      state.view = el.dataset.view;
      state.panelIssue = null;
      render();
      return;
    }
    if (action === 'filter') {
      state.filter = el.dataset.filter;
      render();
      return;
    }
    if (action === 'scene') {
      state.scene = el.dataset.scene;
      state.parked.clear();
      if (state.scene === 'long') state.expanded.add('d3');
      if (state.scene === 'single') state.expanded.add('d1');
      state.view = 'decisions';
      state.filter = 'all';
      render();
      var root = $('#view-root');
      root.scrollTop = 0;
      return;
    }
    if (action === 'toggle-narrow') {
      state.narrow = !state.narrow;
      render();
      return;
    }
    if (action === 'fast-forward') { fastForward(); return; }
    if (action === 'theme') {
      state.dark = !state.dark;
      render();
      return;
    }
    if (action === 'notify') {
      state.notif = state.notif === 'granted' ? 'default' : 'granted';
      pushToast({
        text: state.notif === 'granted'
          ? '已模拟通知授权：真实实现走 Tauri 插件 / Web Notification'
          : '已关闭通知演示：宽限期内你将收不到提醒',
        kind: state.notif === 'granted' ? 'done' : 'warn'
      });
      render();
      return;
    }
    if (action === 'toggle-expand') { toggleExpand(el.dataset.id); return; }
    if (action === 'select-option') { selectOption(el.dataset.id, el.dataset.opt); return; }
    if (action === 'submit-answer') {
      var d = decisionById(el.dataset.id);
      var opt = state.selectedOpt[el.dataset.id];
      if (d && opt) answer(d, opt);
      return;
    }
    if (action === 'revise') {
      var rd = decisionById(el.dataset.id);
      if (rd) {
        state.revising.add(rd.id);
        state.selectedOpt[rd.id] = latestAnswer(rd).optionId;
        render();
      }
      return;
    }
    if (action === 'cancel-revise') {
      state.revising.delete(el.dataset.id);
      delete state.selectedOpt[el.dataset.id];
      render();
      return;
    }
    if (action === 'open-issue') {
      state.panelIssue = el.dataset.issue;
      renderPanel();
      return;
    }
    if (action === 'close-panel') {
      state.panelIssue = null;
      renderPanel();
      return;
    }
    if (action === 'go-decision') { goDecision(el.dataset.id); return; }
    if (action === 'panel-to-decision') { goDecision(el.dataset.id); return; }
    if (action === 'undo') { undo(el.dataset.token); return; }
    if (action === 'park') {
      state.parked.add(el.dataset.id);
      pushToast({ text: '已隐藏 1 条决策（仅本会话）', kind: 'info', ttl: 3000 });
      render();
      return;
    }
    if (action === 'unpark-all') {
      state.parked.clear();
      render();
      return;
    }
    if (action === 'withdraw-start') {
      state.withdrawing = el.dataset.id;
      state.withdrawError = '';
      state.expanded.add(el.dataset.id);
      render();
      return;
    }
    if (action === 'withdraw-cancel') {
      state.withdrawing = null;
      state.withdrawError = '';
      render();
      return;
    }
    if (action === 'withdraw-confirm') { withdraw(el.dataset.id); return; }
  });

  document.addEventListener('input', function (e) {
    var el = e.target.closest('[data-withdraw-input]');
    if (el) state.withdrawDraft[el.dataset.withdrawInput] = el.value;
  });

  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-action="sort"]');
    if (el) {
      state.sort = el.value;
      render();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (state.withdrawing) {
        state.withdrawing = null;
        state.withdrawError = '';
        render();
      } else if (state.panelIssue) {
        state.panelIssue = null;
        renderPanel();
      }
    }
  });

  /* -------------------- 12. 图标 -------------------- */

  function iconArrow() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';
  }
  function iconBell() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10.5 21a2 2 0 0 0 3 0"/></svg>';
  }
  function iconLock() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
  }
  function iconInboxCheck() {
    return '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13l2-8h12l2 8v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 13h5l1 2h4l1-2h5"/><path d="M10 8.5l1.5 1.5L15 6.5"/></svg>';
  }

  /* -------------------- 13. 启动 -------------------- */

  decisions.forEach(function (d) {
    d.warned = d.state === 'grace' && (d.graceUntil - T0) / 1000 <= 60;
  });

  render();
  setInterval(tick, 1000);
})();
