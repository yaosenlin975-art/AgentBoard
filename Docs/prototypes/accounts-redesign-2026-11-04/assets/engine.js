/**
 * 共享状态机（两个方向共用同一套数据与交互）。
 * 视图只读 state + 调用 actions，不各自维护业务状态。
 *
 * 业务口径（与设计文档保持一致）：
 * - 今日完成 = last_checkin_day 为今天且 status ∈ {succeeded, already_done}；
 *   unknown 不计入完成并追加 ? 角标；failed 落回未签到；authorized 不算完成。
 * - 删除：两步确认（3 秒自动收回）；服务端 409 的三种阻塞码原样呈现中文原因。
 * - 切换：客户端当前账号按平台各自独立。
 */
(function () {
  var MOCK = window.MOCK;
  var API = window.API;
  var TODAY = MOCK.TODAY;

  var STATUS_LABEL = {
    succeeded: '签到成功',
    already_done: '今日已完成',
    unknown: '结果未知',
    failed: '签到失败',
    authorized: '授权中'
  };

  var DELETE_FAIL_LABEL = {
    ACCOUNT_BUSY: '账号正忙，暂时无法删除',
    CHECKIN_AUTHORIZATION_EXISTS: '该账号已有进行中的签到授权，暂时无法删除',
    RECOVERY_REQUIRED: '上次切换仍需恢复，恢复完成前不能删除'
  };

  var state = {
    loading: true,
    modalOpen: true,
    accounts: [],
    platforms: [],
    open: {},            // 平台展开态（方向 A 用，方向 B 也用于「账号工作区」）
    selected: 'workbuddy_desktop', // 方向 B 左栏选中
    batches: {},         // batchId -> batch
    batchByApp: {},      // appId -> 最近批次 id
    batchHidden: {},     // appId -> 用户收起了批次面板
    busy: {},            // appId -> 正在建批
    pendingDelete: null, // accountId：处于二次确认
    deleteError: null,   // { accountId, code }
    switchConfirm: null, // accountId：切换确认中
    switching: null,     // accountId：切换进行中
    techOpen: {},        // accountId -> 技术信息展开
    toast: null,
    reduced: false,
    animKey: ''      // 触发一次性入场动画的键（避免批次轮询时反复重播动画）
  };

  var listeners = [];
  var toastTimer = null;
  var deleteTimer = null;

  function bump(key) {
    state.animKey = key + ':' + Date.now();
  }

  function emit() {
    listeners.forEach(function (fn) { fn(state); });
  }

  function clock() {
    var d = new Date();
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    return h + ':' + m;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function platformOf(appId) {
    for (var i = 0; i < state.platforms.length; i += 1) {
      if (state.platforms[i].id === appId) return state.platforms[i];
    }
    return null;
  }

  function accountsOf(appId) {
    return state.accounts.filter(function (a) { return a.appId === appId; });
  }

  /** 是否参与一键签到：启用 + 平台签到能力可用 + 账号签到能力 supported */
  function participates(account) {
    var platform = platformOf(account.appId);
    return !!(account.enabled && platform && platform.capability.checkin && account.checkin === 'supported');
  }

  function completed(account) {
    var last = account.lastCheckin;
    if (!last || last.day !== TODAY) return false;
    return last.status === 'succeeded' || last.status === 'already_done';
  }

  /** 平台签到芯片：done/total + unknown 角标 */
  function summaryOf(appId) {
    var list = accountsOf(appId).filter(participates);
    var done = list.filter(completed).length;
    var unknown = list.filter(function (a) {
      return a.lastCheckin && a.lastCheckin.day === TODAY && a.lastCheckin.status === 'unknown';
    }).length;
    return { done: done, total: list.length, unknown: unknown };
  }

  function todaySummary() {
    var list = state.accounts.filter(participates);
    return {
      done: list.filter(completed).length,
      total: list.length
    };
  }

  function batchOf(appId) {
    var id = state.batchByApp[appId];
    return id ? state.batches[id] : null;
  }

  function accountOf(id) {
    for (var i = 0; i < state.accounts.length; i += 1) {
      if (state.accounts[i].id === id) return state.accounts[i];
    }
    return null;
  }

  /** 删除阻塞提示文案（中文主文案 + 技术码分开） */
  function deleteFailLabel(code) {
    return DELETE_FAIL_LABEL[code] || '暂时无法删除该账号';
  }

  function toast(text, tone) {
    state.toast = { text: text, tone: tone || 'plain' };
    bump('toast');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      state.toast = null;
      emit();
    }, 2600);
    emit();
  }

  function clearDeleteTimer() {
    if (deleteTimer) {
      clearTimeout(deleteTimer);
      deleteTimer = null;
    }
  }

  /* ---------------- 批次模拟 ---------------- */

  var TERMINAL = ['succeeded', 'already_done', 'failed', 'unknown', 'cancelled'];

  function finishBatch(batch) {
    var items = batch.items;
    var ok = items.filter(function (i) { return i.state === 'succeeded' || i.state === 'already_done'; }).length;
    var bad = items.filter(function (i) { return i.state === 'failed' || i.state === 'unknown'; }).length;
    if (ok === items.length) batch.status = 'succeeded';
    else if (bad === items.length) batch.status = 'failed';
    else batch.status = 'partial';
    batch.finishedAt = clock();
    state.busy[batch.appId] = false;
    emit();
  }

  function runBatch(appId, onlyIds) {
    if (state.busy[appId]) return;
    var list = accountsOf(appId).filter(participates);
    if (onlyIds) {
      list = list.filter(function (a) { return onlyIds.indexOf(a.id) !== -1; });
    }
    if (list.length === 0) {
      toast('该平台没有参与签到的账号');
      return;
    }
    state.busy[appId] = true;
    state.open[appId] = true;
    state.batchHidden[appId] = false;
    emit();

    API.createCheckinBatch(appId, list.map(function (a) { return a.id; })).then(function (res) {
      var batch = {
        id: res.id,
        appId: appId,
        status: 'running',
        createdAt: clock(),
        finishedAt: null,
        items: list.map(function (a) {
          return { accountId: a.id, state: 'queued' };
        })
      };
      state.batches[batch.id] = batch;
      state.batchByApp[appId] = batch.id;
      bump('batch:' + appId);
      emit();

      batch.items.forEach(function (item, index) {
        setTimeout(function () {
          var current = state.batches[batch.id];
          if (!current) return;
          item.state = 'running';
          emit();
        }, 420 + index * 160);

        setTimeout(function () {
          var current = state.batches[batch.id];
          if (!current) return;
          var account = accountOf(item.accountId);
          if (!account) return;
          var result = account.simulate || 'succeeded';

          if (result === 'failed') {
            // failed 服务端不写 day：自然落回「未签到」
            account.lastCheckin = null;
            account.lastFailure = { at: clock() };
            item.state = 'failed';
          } else if (result === 'unknown') {
            account.lastCheckin = { day: TODAY, status: 'unknown', at: clock() };
            item.state = 'unknown';
          } else {
            account.lastCheckin = { day: TODAY, status: result, at: clock() };
            item.state = result;
          }
          emit();
          if (batch.items.every(function (i) { return TERMINAL.indexOf(i.state) !== -1; })) {
            finishBatch(batch);
          }
        }, 1250 + index * 260);
      });
    });
  }

  /* ---------------- actions ---------------- */

  var actions = {
    init: function () {
      API.fetchOverview().then(function (data) {
        state.accounts = data.accounts;
        state.platforms = data.platforms;
        state.loading = false;
        state.open['workbuddy_desktop'] = true; // 首屏展开一个平台，便于看到账号层级
        emit();
      });
    },

    toggleApp: function (appId) {
      state.open[appId] = !state.open[appId];
      if (state.open[appId]) bump('app:' + appId);
      emit();
    },

    selectApp: function (appId) {
      state.selected = appId;
      state.open[appId] = true;
      bump('select:' + appId);
      emit();
    },

    startCheckin: function (appId) {
      runBatch(appId);
    },

    checkinOne: function (id) {
      var account = accountOf(id);
      if (account) runBatch(account.appId, [id]);
    },

    startAll: function () {
      var targets = state.platforms.filter(function (p) {
        return p.category === 'checkin' && accountsOf(p.id).some(participates);
      });
      if (targets.length === 0) {
        toast('没有可签到的平台');
        return;
      }
      targets.forEach(function (p, i) {
        setTimeout(function () { runBatch(p.id); }, i * 120);
      });
      toast('已为 ' + targets.length + ' 个平台发起签到', 'ok');
    },

    beginSwitch: function (id) {
      state.deleteError = null;
      state.pendingDelete = null;
      state.switchConfirm = id;
      bump('switch:' + id);
      emit();
    },

    cancelSwitch: function () {
      state.switchConfirm = null;
      emit();
    },

    confirmSwitch: function (id) {
      var account = accountOf(id);
      if (!account) return;
      state.switchConfirm = null;
      state.switching = id;
      emit();
      API.switchAccount(id).then(function () {
        state.accounts.forEach(function (a) {
          if (a.appId === account.appId) a.isCurrent = a.id === id;
        });
        state.switching = null;
        toast('已切换到「' + account.name + '」', 'ok');
      });
    },

    beginDelete: function (id) {
      clearDeleteTimer();
      state.deleteError = null;
      state.switchConfirm = null;
      state.pendingDelete = id;
      bump('delete:' + id);
      emit();
      deleteTimer = setTimeout(function () {
        state.pendingDelete = null;
        deleteTimer = null;
        emit();
      }, 3000);
    },

    cancelDelete: function () {
      clearDeleteTimer();
      state.pendingDelete = null;
      emit();
    },

    confirmDelete: function (id) {
      clearDeleteTimer();
      var account = accountOf(id);
      if (!account) return;
      API.deleteAccount(account).then(function () {
        state.accounts = state.accounts.filter(function (a) { return a.id !== id; });
        state.pendingDelete = null;
        state.deleteError = null;
        toast('已删除「' + account.name + '」的本地记录');
      }).catch(function (error) {
        state.pendingDelete = null;
        state.deleteError = { accountId: id, code: error.code || 'UNKNOWN' };
        bump('err:' + id);
        emit();
      });
    },

    dismissDeleteError: function () {
      state.deleteError = null;
      emit();
    },

    capture: function (appId) {
      API.captureCurrent(appId).then(function () {
        toast('已捕获当前客户端账号（示例）', 'ok');
      });
    },

    importLocal: function () {
      API.importLocal().then(function (res) {
        toast('已读取本机账号 ' + res.count + ' 个（示例）', 'ok');
      });
    },

    refreshQuota: function () {
      toast('额度已刷新（示例）', 'ok');
    },

    toggleTech: function (id) {
      state.techOpen[id] = !state.techOpen[id];
      bump('tech:' + id);
      emit();
    },

    hideBatch: function (appId) {
      state.batchHidden[appId] = true;
      emit();
    },

    showBatch: function (appId) {
      state.batchHidden[appId] = false;
      bump('batch:' + appId);
      emit();
    },

    closeModal: function () {
      state.modalOpen = false;
      emit();
    },

    reopenModal: function () {
      state.modalOpen = true;
      emit();
    },

    dismissToast: function () {
      state.toast = null;
      emit();
    }
  };

  window.Engine = {
    state: state,
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (item) { return item !== fn; });
      };
    },
    actions: actions,
    labels: {
      status: STATUS_LABEL,
      deleteFail: DELETE_FAIL_LABEL
    },
    helpers: {
      clock: clock,
      platformOf: platformOf,
      accountsOf: accountsOf,
      participates: participates,
      completed: completed,
      summaryOf: summaryOf,
      todaySummary: todaySummary,
      batchOf: batchOf,
      accountOf: accountOf,
      deleteFailLabel: deleteFailLabel
    }
  };

  // 初始 reduced-motion 标记（CSS 已处理过渡，这里只用于文案/位置提示）
  if (typeof window.matchMedia === 'function') {
    state.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  }
})();
