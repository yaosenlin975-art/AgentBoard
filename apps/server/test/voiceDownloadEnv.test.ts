/**
 * VOICE-DL-FAIL：代理探测 / 可读错误文案 / 空闲超时与重试常量。
 *
 * 独立成文件的原因：只 import 服务模块，不拉起整个 app（`src/index.ts`）。
 * 真实网络证据见卡片评论（HF 直连 UND_ERR_CONNECT_TIMEOUT；开代理后下完且 sha256 通过；Range 续传）。
 */
import { describe, expect, it } from 'vitest';
import {
  describeVoiceDownloadError,
  ensureVoiceProxySupport,
  voiceDownloadEnv,
  VOICE_DOWNLOAD_IDLE_MS,
  VOICE_DOWNLOAD_RETRIES,
} from '../src/services/voiceModels.js';

describe('VOICE-DL-FAIL 下载环境与错误可读性', () => {
  it('代理探测：识别 HTTPS_PROXY 且**不打印凭据**', () => {
    const env = voiceDownloadEnv({ HTTPS_PROXY: 'http://user:secret@127.0.0.1:7897', NO_PROXY: 'localhost' } as NodeJS.ProcessEnv);
    expect(env).toMatchObject({ proxy_detected: true, proxy_var: 'HTTPS_PROXY', proxy_host: '127.0.0.1:7897', no_proxy: 'localhost' });
    expect(JSON.stringify(env)).not.toContain('secret');
    expect(JSON.stringify(env)).not.toContain('user');
  });

  it('代理探测：小写 http_proxy 也认；都没有则 proxy_detected=false', () => {
    expect(voiceDownloadEnv({ http_proxy: '127.0.0.1:1080' } as NodeJS.ProcessEnv)).toMatchObject({ proxy_detected: true, proxy_host: '127.0.0.1:1080' });
    expect(voiceDownloadEnv({} as NodeJS.ProcessEnv)).toMatchObject({ proxy_detected: false, proxy_var: null, proxy_host: null });
  });

  it('ensureVoiceProxySupport：有代理才开启；显式 0 尊重用户；已为 1 保持；无代理不动 env', () => {
    // 无代理变量：不注入（避免无意义地改全局行为）
    const none: NodeJS.ProcessEnv = {};
    expect(ensureVoiceProxySupport(none)).toBe(false);
    expect(none.NODE_USE_ENV_PROXY).toBeUndefined();
    // 有代理变量且未设置 → 开启
    const withProxy: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://127.0.0.1:7897' };
    expect(ensureVoiceProxySupport(withProxy)).toBe(true);
    expect(withProxy.NODE_USE_ENV_PROXY).toBe('1');
    // 显式 0 → 不覆盖（尊重用户关闭）
    const off: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://127.0.0.1:7897', NODE_USE_ENV_PROXY: '0' };
    expect(ensureVoiceProxySupport(off)).toBe(false);
    expect(off.NODE_USE_ENV_PROXY).toBe('0');
    // 已为 1 → 保持
    const on: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://127.0.0.1:7897', NODE_USE_ENV_PROXY: '1' };
    expect(ensureVoiceProxySupport(on)).toBe(true);
  });

  it('ECONNRESET 文案含原因、cause 码与已下载字节（不再是裸 fetch failed）', () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const described = describeVoiceDownloadError(error, { file: 'encoder.onnx', downloadedBytes: 12.3 * 1024 * 1024, fileBytes: 57.6 * 1024 * 1024, env: { HTTPS_PROXY: 'http://127.0.0.1:7897' } as NodeJS.ProcessEnv });
    expect(described.code).toBe('VOICE_DOWNLOAD_FAILED');
    expect(described.message).toContain('连接被重置');
    expect(described.message).toContain('ECONNRESET');
    expect(described.message).toContain('已下载 12.3MB/57.6MB');
    expect(described.message).toContain('检测到代理');
  });

  it('未配置代理时文案给代理提示；连接超时给「没走代理」的线索', () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    const described = describeVoiceDownloadError(error, { file: 'joiner.onnx', downloadedBytes: 0, fileBytes: 3_228_404, env: {} as NodeJS.ProcessEnv });
    expect(described.message).toContain('连接超时');
    expect(described.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(described.message).toContain('未检测到 HTTP(S)_PROXY');
  });

  it('空闲超时文案说明「重试会续传」', () => {
    const described = describeVoiceDownloadError(Object.assign(new Error('idle'), { code: 'VOICE_DOWNLOAD_IDLE_TIMEOUT' }), { file: 'a.onnx', downloadedBytes: 1024, fileBytes: 4096, env: {} as NodeJS.ProcessEnv });
    expect(described.code).toBe('VOICE_DOWNLOAD_IDLE_TIMEOUT');
    expect(described.message).toContain(`${Math.round(VOICE_DOWNLOAD_IDLE_MS / 1000)} 秒没有收到数据`);
    expect(described.message).toContain('续传');
  });

  it('常量：空闲 60s、重试 2 次', () => {
    expect(VOICE_DOWNLOAD_IDLE_MS).toBe(60_000);
    expect(VOICE_DOWNLOAD_RETRIES).toBe(2);
  });
});
