/**
 * VOICE-5：按文件下载 + 逐文件校验（不下载真实大模型；fixture 是几 KB 的假 onnx）。
 *
 * 覆盖：成功路径（sha256 + tokens 弱校验）、单文件校验失败只删该文件且重下只补它、
 * 缺文件判 `VOICE_MODEL_INCOMPLETE`、进度按总字节聚合且单调、幂等复用、删除中 409、空间不足。
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { VoiceModelCatalogEntry } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { resetVoiceModelTasks, weakFileLooksValid } from '../src/services/voiceModels.js';

const ONNX_A = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 251));
const ONNX_B = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 11) % 253));
const TOKENS = Buffer.from('<blk> 0\n<unk> 1\n你 2\n好 3\n', 'utf8');
const sha = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

const PAYLOADS: Record<string, Buffer> = {
  'encoder.int8.onnx': ONNX_A,
  'joiner.int8.onnx': ONNX_B,
  'tokens.txt': TOKENS,
};

/** 本地 fixture 文件服务：按文件名给字节，记录每个路径命中次数 */
async function serveFixture(options: { slow?: boolean; missing?: string[] } = {}): Promise<{
  port: number;
  hits: () => Record<string, number>;
  close: () => Promise<void>;
}> {
  const hits: Record<string, number> = {};
  const server: Server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
    hits[name] = (hits[name] ?? 0) + 1;
    if (options.missing?.includes(name) || PAYLOADS[name] === undefined) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    const payload = PAYLOADS[name] as Buffer;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
    if (!options.slow) {
      res.end(payload);
      return;
    }
    for (let offset = 0; offset < payload.length; offset += 256) {
      res.write(payload.subarray(offset, offset + 256));
      await new Promise(r => setTimeout(r, 10));
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    hits: () => hits,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const buildCatalog = (port: number, overrides: { badSha?: string; tokensBytes?: number } = {}): VoiceModelCatalogEntry[] => [{
  id: 'test-model',
  name: '测试模型',
  bytes: 0,
  size_estimate: false,
  languages: ['zh'],
  repo: 'fixture/repo',
  revision: 'main',
  url: 'https://example.invalid/archive.tar.bz2',
  sha256: null,
  streaming: true,
  note: 'fixture',
  files: [
    { path: 'encoder.int8.onnx', bytes: ONNX_A.length, sha256: sha(ONNX_A) },
    { path: 'joiner.int8.onnx', bytes: ONNX_B.length, sha256: overrides.badSha ?? sha(ONNX_B) },
    { path: 'tokens.txt', bytes: overrides.tokensBytes ?? TOKENS.length, sha256: null },
  ],
}];

describe('voice models per-file download (VOICE-5)', () => {
  let t: TestDb;
  let root: string;
  let app: Express;
  let fixture: Awaited<ReturnType<typeof serveFixture>>;
  let catalog: VoiceModelCatalogEntry[];
  let freeBytes: number | null;

  const openApp = async (): Promise<void> => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      voice: {
        catalog,
        rootDir: root,
        freeBytes: async () => freeBytes,
        fileUrl: (_entry, file) => `http://127.0.0.1:${fixture.port}/${encodeURIComponent(file.path)}`,
        fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch,
      },
    });
    app = created.app;
  };

  const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('waitFor 超时');
  };

  const progress = async () => (await request(app).get('/api/voice/models/test-model/progress?poll=1')).body as {
    state: string; bytes: number; total: number; current_file: string | null; error: string | null; error_message: string | null;
  };
  const status = async () => (await request(app).get('/api/voice/models/test-model')).body as {
    state: string; present_files: string[]; missing_files: string[]; bytes_total: number; sha256_verified: boolean | null;
  };

  beforeEach(async () => {
    resetVoiceModelTasks();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-voice5-'));
    fixture = await serveFixture();
    catalog = buildCatalog(fixture.port);
    freeBytes = 10 * 1024 * 1024;
    await openApp();
  });

  afterEach(async () => {
    await fixture.close();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('downloadsEveryFileVerifiesShaAndMarksDownloaded', async () => {
    const res = await request(app).post('/api/voice/models/test-model/download').send({});
    expect(res.status).toBe(202);
    await waitFor(async () => (await progress()).state === 'downloaded');

    const dir = join(root, 'test-model');
    expect(readdirSync(dir).sort()).toEqual(['encoder.int8.onnx', 'joiner.int8.onnx', 'model.meta.json', 'tokens.txt']);
    expect(readFileSync(join(dir, 'encoder.int8.onnx')).equals(ONNX_A)).toBe(true);
    expect(readdirSync(dir).some(name => name.endsWith('.part'))).toBe(false);

    const final = await status();
    expect(final.state).toBe('downloaded');
    expect(final.bytes_total).toBe(ONNX_A.length + ONNX_B.length + TOKENS.length);
    expect(final.sha256_verified).toBe(true);
    expect(final.missing_files).toEqual([]);
    const meta = JSON.parse(readFileSync(join(dir, 'model.meta.json'), 'utf8')) as { files: Array<{ path: string; verified: string }> };
    expect(meta.files.map(file => file.verified)).toEqual(['sha256', 'sha256', 'weak']);
  });

  it('reportsMonotonicAggregateProgressWithCurrentFile', async () => {
    await fixture.close();
    fixture = await serveFixture({ slow: true });
    catalog = buildCatalog(fixture.port);
    await openApp();

    await request(app).post('/api/voice/models/test-model/download').send({});
    const samples: Array<{ bytes: number; file: string | null }> = [];
    await waitFor(async () => {
      const snapshot = await progress();
      samples.push({ bytes: snapshot.bytes, file: snapshot.current_file });
      return snapshot.state === 'downloaded';
    });
    expect(samples.length).toBeGreaterThan(1);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!.bytes).toBeGreaterThanOrEqual(samples[i - 1]!.bytes);
    }
    const total = ONNX_A.length + ONNX_B.length + TOKENS.length;
    expect(samples.at(-1)?.bytes).toBe(total);
    expect((await progress()).total).toBe(total);
    expect(samples.some(sample => sample.file !== null)).toBe(true);
  });

  it('keepsOtherFilesAndOnlyRedownloadsTheFailedOneOnChecksumMismatch', async () => {
    // 失败文件放最后：前面的好文件先落盘，才能验证「保留其它已成功文件、只补失败的那个」
    const base = buildCatalog(fixture.port, { badSha: 'deadbeef'.repeat(8) })[0]!;
    catalog = [{ ...base, files: [base.files![0]!, base.files![2]!, base.files![1]!] }];
    await openApp();
    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'failed');
    const failed = await progress();
    expect(failed.error).toBe('VOICE_CHECKSUM_MISMATCH');
    expect(failed.current_file).toBe('joiner.int8.onnx');

    const dir = join(root, 'test-model');
    // 校验失败的那个文件被删掉，其它已成功的文件保留
    expect(readdirSync(dir).sort()).toEqual(['encoder.int8.onnx', 'tokens.txt']);
    expect(existsSync(join(dir, 'joiner.int8.onnx.part'))).toBe(false);

    // 修正校验值后重下：只补 joiner 一个文件
    catalog = buildCatalog(fixture.port);
    await openApp();
    const before = { ...fixture.hits() };
    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'downloaded');
    const after = fixture.hits();
    expect((after['joiner.int8.onnx'] ?? 0) - (before['joiner.int8.onnx'] ?? 0)).toBe(1);
    expect((after['encoder.int8.onnx'] ?? 0) - (before['encoder.int8.onnx'] ?? 0)).toBe(0);
    expect((after['tokens.txt'] ?? 0) - (before['tokens.txt'] ?? 0)).toBe(0);
    expect((await status()).state).toBe('downloaded');
  });

  it('marksIncompleteWhenARequiredFileFailsItsWeakCheck', async () => {
    // tokens.txt 声明字节数故意写错 → 弱校验不过 → 判 INCOMPLETE，不标 downloaded
    catalog = buildCatalog(fixture.port, { tokensBytes: TOKENS.length + 1 });
    await openApp();
    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'failed');
    const snapshot = await progress();
    expect(snapshot.error).toBe('VOICE_MODEL_INCOMPLETE');
    expect(snapshot.error_message).toContain('tokens.txt');
    const final = await status();
    expect(final.state).toBe('failed');
    expect(final.missing_files).toEqual(['tokens.txt']);
    expect(final.present_files).toEqual(['encoder.int8.onnx', 'joiner.int8.onnx']);
    expect(existsSync(join(root, 'test-model', 'model.meta.json'))).toBe(false);
  });

  it('detectsMissingFileOnDiskAsIncomplete', async () => {
    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'downloaded');
    unlinkSync(join(root, 'test-model', 'tokens.txt'));
    const final = await status();
    expect(final.state).toBe('failed');
    expect(final.missing_files).toEqual(['tokens.txt']);
  });

  it('reusesInFlightTaskAndRejectsDeleteWhileDownloading', async () => {
    await fixture.close();
    fixture = await serveFixture({ slow: true });
    catalog = buildCatalog(fixture.port);
    await openApp();

    const first = await request(app).post('/api/voice/models/test-model/download').send({});
    const second = await request(app).post('/api/voice/models/test-model/download').send({});
    expect(second.body.task_id).toBe(first.body.task_id);
    expect(second.body.reused).toBe(true);

    const busy = await request(app).delete('/api/voice/models/test-model');
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('VOICE_MODEL_BUSY');

    await waitFor(async () => (await progress()).state === 'downloaded');
    const removed = await request(app).delete('/api/voice/models/test-model');
    expect(removed.status).toBe(200);
    expect(existsSync(join(root, 'test-model'))).toBe(false);
  });

  it('refusesToStartWhenDiskSpaceIsInsufficient', async () => {
    freeBytes = 1024;
    await request(app).post('/api/voice/models/test-model/download').send({});
    await waitFor(async () => (await progress()).state === 'failed');
    const snapshot = await progress();
    expect(snapshot.error).toBe('VOICE_NO_SPACE');
    expect(fixture.hits()['encoder.int8.onnx']).toBeUndefined();
  });

  it('weakCheckRejectsPlaceholderTokensFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-weak-'));
    try {
      const ok = join(dir, 'ok.txt');
      writeFileSync(ok, TOKENS);
      expect(weakFileLooksValid(ok, TOKENS.length)).toBe(true);
      expect(weakFileLooksValid(ok, TOKENS.length + 1)).toBe(false);
      const empty = join(dir, 'empty.txt');
      writeFileSync(empty, Buffer.alloc(0));
      expect(weakFileLooksValid(empty, 0)).toBe(false);
      const noSpace = join(dir, 'nospace.txt');
      writeFileSync(noSpace, Buffer.from('abc\n'));
      expect(weakFileLooksValid(noSpace, 4)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
