/**
 * sherpa-onnx-node 2.0.1 未随包提供 .d.ts：这里只声明本项目用到的最小面。
 * 运行时仍然是**延迟 import**（`services/voiceSessions.ts` 的 `lazyImportSherpa`），
 * 未下载模型时不会触碰原生模块。
 */
declare module 'sherpa-onnx-node' {
  export class OnlineRecognizer {
    constructor(config: Record<string, unknown>);
    createStream(): unknown;
    isReady(stream: unknown): boolean;
    decode(stream: unknown): void;
    getResult(stream: unknown): { text?: string };
  }
}
