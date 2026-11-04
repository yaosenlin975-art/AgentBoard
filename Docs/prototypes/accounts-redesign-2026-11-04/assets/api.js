/**
 * API 桩层（两个方向共用）。签名与真实接口一致，替换实现即可接后端。
 * 每个函数都带网络延迟，让骨架屏 / 进行中 / 失败态真的可见。
 */
(function () {
  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function uuid() {
    return 'ck-' + Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 6);
  }

  window.API = {
    /**
     * GET /api/managed-accounts + GET /api/managed-account-capabilities
     * 400ms 延迟用于展示加载态。
     */
    fetchOverview: function () {
      return delay(420).then(function () {
        return clone({ accounts: window.MOCK.accounts, platforms: window.MOCK.platforms });
      });
    },

    /**
     * POST /api/checkin-runs  (Idempotency-Key)
     * body: { app_id, account_ids[] }
     * 200: { batch: { id, app_id, status } }
     */
    createCheckinBatch: function (appId, accountIds) {
      return delay(300).then(function () {
        return { id: uuid(), appId: appId, accountIds: accountIds.slice() };
      });
    },

    /**
     * POST /api/managed-accounts/:id/switch
     * 900ms 模拟客户端重启窗口。
     */
    switchAccount: function (id) {
      return delay(900).then(function () { return { ok: true, id: id }; });
    },

    /**
     * DELETE /api/managed-accounts/:id
     * 409 时抛 { code }，前端只用中文文案 + 技术码。
     */
    deleteAccount: function (account) {
      return delay(560).then(function () {
        if (account.blocks) {
          var error = new Error('删除被服务端拒绝');
          error.code = account.blocks;
          throw error;
        }
        return { deleted: true, id: account.id };
      });
    },

    /**
     * POST /api/managed-accounts/:app/capture-current
     */
    captureCurrent: function (appId) {
      return delay(620).then(function () { return { ok: true, appId: appId }; });
    },

    /**
     * POST /api/managed-accounts/import-local
     */
    importLocal: function () {
      return delay(760).then(function () { return { count: 3 }; });
    }
  };
})();
