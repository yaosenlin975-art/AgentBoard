/**
 * 账号管理重设计 · 唯一模拟数据源（两个方向共用）。
 * 字段命名贴近真实接口：GET /api/managed-accounts、/api/managed-account-quotas、/api/managed-account-capabilities。
 * 脱敏口径：只出现 display_name + identity_hint（哈希前 8 位），不出现 token / identity_hash / 快照路径。
 */
(function () {
  var TODAY = '2026-11-04';

  var platforms = [
    {
      id: 'workbuddy_desktop',
      name: 'WorkBuddy Desktop',
      glyph: 'W',
      category: 'checkin',
      capability: { capture: true, switch: true, checkin: true },
      quota: { kind: 'credit' }
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      glyph: 'M',
      category: 'checkin',
      capability: { capture: true, switch: true, checkin: true },
      quota: { kind: 'credit' }
    },
    {
      id: 'trae',
      name: 'Trae',
      glyph: 'T',
      category: 'checkin',
      capability: { capture: true, switch: true, checkin: true },
      quota: { kind: 'credit' }
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      glyph: 'D',
      category: 'quota',
      capability: { capture: false, switch: false, checkin: false },
      quota: {
        kind: 'balance',
        balance: 128.6,
        unit: 'CNY',
        fetchedAt: '09:42'
      }
    },
    {
      id: 'opencode',
      name: 'OpenCode Go',
      glyph: 'O',
      category: 'quota',
      capability: { capture: false, switch: false, checkin: false },
      quota: {
        kind: 'windows',
        fetchedAt: '09:42',
        windows: [
          { kind: '5h', label: '5 小时', used: 34, total: 120, reset: '2h 13m 后重置' },
          { kind: '周', label: '本周', used: 620, total: 2000, reset: '3d 后重置' },
          { kind: '月', label: '本月', used: 2400, total: 8000, reset: '18d 后重置' }
        ]
      }
    },
    {
      id: 'codex',
      name: 'Codex',
      glyph: 'C',
      category: 'quota',
      capability: { capture: false, switch: false, checkin: false },
      quota: {
        kind: 'windows',
        fetchedAt: '09:42',
        windows: [
          { kind: '5h', label: '5 小时', used: 12, total: 40, reset: '3h 04m 后重置' },
          { kind: '周', label: '本周', used: 200, total: 200, limited: true, reset: '5d 后重置' }
        ]
      }
    }
  ];

  /**
   * blocks：删除阻塞码（真实后端 409）。演示里保留三种：
   * ACCOUNT_BUSY / CHECKIN_AUTHORIZATION_EXISTS / RECOVERY_REQUIRED。
   * simulate：该账号在一次签到批次里的结果，用于演示完成口径。
   * required 的意思是「授权中」——lastCheckin.status = authorized，不计入完成。
   */
  var accounts = [
    {
      id: 'wb-1',
      appId: 'workbuddy_desktop',
      name: '猫猫旅行号',
      hint: '7c3a91fe',
      region: '国内',
      isCurrent: true,
      enabled: true,
      checkin: 'supported',
      lastCheckin: { day: TODAY, status: 'succeeded', at: '08:42' },
      blocks: null,
      simulate: 'succeeded'
    },
    {
      id: 'wb-2',
      appId: 'workbuddy_desktop',
      name: '工作号',
      hint: '2f6a5b70',
      region: '国内',
      isCurrent: false,
      enabled: true,
      checkin: 'supported',
      lastCheckin: { day: TODAY, status: 'unknown', at: '07:58' },
      blocks: 'ACCOUNT_BUSY',
      simulate: 'unknown'
    },
    {
      id: 'wb-3',
      appId: 'workbuddy_desktop',
      name: '小号 · 备用',
      hint: 'b41d0e88',
      region: '国际',
      isCurrent: false,
      enabled: true,
      checkin: 'supported',
      lastCheckin: { day: TODAY, status: 'already_done', at: '09:06' },
      blocks: null,
      simulate: 'already_done'
    },
    {
      id: 'wb-4',
      appId: 'workbuddy_desktop',
      name: '旧测试设备',
      hint: '9d0c4a12',
      region: '国际',
      isCurrent: false,
      enabled: false,
      checkin: 'supported',
      lastCheckin: null,
      blocks: 'RECOVERY_REQUIRED',
      simulate: 'failed'
    },
    {
      id: 'mm-1',
      appId: 'minimax',
      name: '海螺日常',
      hint: 'e5b2c7a1',
      region: '国内',
      isCurrent: true,
      enabled: true,
      checkin: 'supported',
      lastCheckin: { day: TODAY, status: 'succeeded', at: '08:15' },
      blocks: null,
      simulate: 'succeeded'
    },
    {
      id: 'mm-2',
      appId: 'minimax',
      name: '海螺绘图',
      hint: '33f8d206',
      region: '国内',
      isCurrent: false,
      enabled: true,
      checkin: 'supported',
      lastCheckin: null,
      blocks: null,
      simulate: 'failed'
    },
    {
      id: 'tr-1',
      appId: 'trae',
      name: 'Trae 主号',
      hint: 'aa71c3de',
      region: '国际',
      isCurrent: false,
      enabled: true,
      checkin: 'supported',
      lastCheckin: { day: null, status: 'authorized' },
      blocks: null,
      simulate: 'unknown'
    },
    {
      id: 'tr-2',
      appId: 'trae',
      name: 'Trae 备用',
      hint: '1c9f4b52',
      region: '国际',
      isCurrent: false,
      enabled: true,
      checkin: 'supported',
      lastCheckin: { day: null, status: 'authorized' },
      blocks: 'CHECKIN_AUTHORIZATION_EXISTS',
      simulate: 'unknown'
    }
  ];

  window.MOCK = {
    TODAY: TODAY,
    platforms: platforms,
    accounts: accounts,
    updatedAt: '09:42'
  };
})();
