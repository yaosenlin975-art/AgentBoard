/**
 * Trae CN `tc` 信封解密（ACC-KB-B3，离线捕获）。
 *
 * 信封布局（本机实测 `iCubeAuthInfo://icube.cloudide`，1862 B）：
 * ```
 * [magic 6B: "tc\x05\x10\x00\x00"] [salt 32B 随机] [AES-128-CBC(PKCS7) 密文]
 * ```
 * 密钥推导：`kdf = SHA512( SHA512(salt) ‖ pepper )`，`key = kdf[0..16]`、`iv = kdf[16..32]`；
 * 明文布局：`[SHA512(data) 64B][data JSON]`，解密后必须校验哈希一致，否则视为损坏。
 *
 * 口径：
 * - 只用 `node:crypto`，不引第三方依赖；
 * - 失败一律抛 `TraeEnvelopeError`（带可读 reason_code），不返回半条数据；
 * - **不解出任何明文给调用方之外的人**：本模块只返回解析后的对象，由 provider 决定脱敏。
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { traePepper } from './pepper.js';

const MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const SALT_LEN = 32;
const HASH_LEN = 64;
const KEY_LEN = 16;
const IV_LEN = 16;

export type TraeEnvelopeErrorCode =
  | 'TRAE_ENVELOPE_TOO_SHORT'
  | 'TRAE_ENVELOPE_BAD_MAGIC'
  | 'TRAE_PEPPER_UNAVAILABLE'
  | 'TRAE_DECRYPT_FAILED'
  | 'TRAE_PAYLOAD_CORRUPT'
  | 'TRAE_PAYLOAD_NOT_JSON';

export class TraeEnvelopeError extends Error {
  constructor(readonly code: TraeEnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'TraeEnvelopeError';
  }
}

const sha512 = (data: Buffer): Buffer => createHash('sha512').update(data).digest();

/** 从 pepper 与 salt 推 AES-128-CBC 的 key/iv */
export function deriveKeyIv(salt: Buffer, pepper: Buffer = traePepper()): { key: Buffer; iv: Buffer } {
  const kdf = sha512(Buffer.concat([sha512(salt), pepper]));
  return { key: kdf.subarray(0, KEY_LEN), iv: kdf.subarray(KEY_LEN, KEY_LEN + IV_LEN) };
}

/**
 * 解 `tc` 信封（入参是 storage.json 里那段 base64 字符串）。
 * 成功返回解析后的 JSON 对象；任何一步失败都抛 `TraeEnvelopeError`。
 */
export function decryptTcEnvelope(base64: string, pepper: Buffer = traePepper()): Record<string, unknown> {
  let blob: Buffer;
  try {
    blob = Buffer.from(base64, 'base64');
  } catch {
    throw new TraeEnvelopeError('TRAE_PAYLOAD_CORRUPT', '信封不是合法 base64');
  }
  if (blob.length < MAGIC.length + SALT_LEN + 16) {
    throw new TraeEnvelopeError('TRAE_ENVELOPE_TOO_SHORT', `信封太短（${blob.length} B），不是 tc 信封`);
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new TraeEnvelopeError(
      'TRAE_ENVELOPE_BAD_MAGIC',
      `信封 magic 不符（实际 ${blob.subarray(0, MAGIC.length).toString('hex')}，期望 746305100000）`,
    );
  }
  if (pepper.length !== 64) {
    throw new TraeEnvelopeError('TRAE_PEPPER_UNAVAILABLE', 'pepper 常量表不可用（长度不是 64 B）');
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const ciphertext = blob.subarray(MAGIC.length + SALT_LEN);
  const { key, iv } = deriveKeyIv(salt, pepper);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new TraeEnvelopeError(
      'TRAE_PEPPER_UNAVAILABLE',
      `解不开信封（pepper 与当前客户端版本不匹配或数据损坏）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (plain.length <= HASH_LEN) {
    throw new TraeEnvelopeError('TRAE_PAYLOAD_CORRUPT', '明文长度不足，缺少哈希头');
  }
  const hash = plain.subarray(0, HASH_LEN);
  const data = plain.subarray(HASH_LEN);
  if (!sha512(data).equals(hash)) {
    throw new TraeEnvelopeError('TRAE_PAYLOAD_CORRUPT', '明文 SHA-512 校验不通过（数据损坏或 pepper 不符）');
  }
  try {
    return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new TraeEnvelopeError('TRAE_PAYLOAD_NOT_JSON', '解出的明文不是合法 JSON');
  }
}

/**
 * 反向：把 JSON 打成 `tc` 信封（**仅测试用**，用于构造脱敏 fixture，不参与生产路径）。
 */
export function encryptTcEnvelope(payload: Record<string, unknown>, salt: Buffer, pepper: Buffer = traePepper()): string {
  if (salt.length !== SALT_LEN) throw new Error(`salt 必须是 ${SALT_LEN} 字节`);
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const plain = Buffer.concat([sha512(data), data]);
  const { key, iv } = deriveKeyIv(salt, pepper);
  const enc = createCipheriv('aes-128-cbc', key, iv);
  const ciphertext = Buffer.concat([enc.update(plain), enc.final()]);
  return Buffer.concat([MAGIC, salt, ciphertext]).toString('base64');
}
