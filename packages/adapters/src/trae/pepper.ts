/**
 * Trae CN `tc` 信封的 pepper 常量表（ACC-KB-B3）。
 *
 * ## 来源与许可（便于审计与替换）
 * - 仓库：https://github.com/xxxbrian/tokmesh（crate `tokmesh-cli` 0.1.3，2026-09-03）
 * - 文件：`crates/tokmesh-cli/src/trae.rs` → `pub mod safestorage`
 *   原始地址：https://raw.githubusercontent.com/xxxbrian/tokmesh/main/crates/tokmesh-cli/src/trae.rs
 * - 许可类型：**MIT**（docs.rs crate 页与仓库 LICENSE 一致）
 * - 取用范围：只取 `JG` / `KG` 两张 64 字节常量表与 `hardcoded_pw = JG XOR KG` 的推导方式；
 *   不复制该仓库的解密实现代码（本项目的解密逻辑在 `tcEnvelope.ts` 用 node:crypto 独立实现）。
 *
 * ## 为什么需要它
 * Trae 的 `iCubeAuthInfo://*` 信封密钥为 `key‖iv = SHA512( SHA512(salt) ‖ pepper )[:32]`，
 * 其中 `pepper = JG XOR KG` 是随客户端分发的固定常量（与机器/用户无关）。
 * 本机 Trae 安装包（`D:\Program Files\Trae CN\resources\app`）前 400 个 `.js` 里已 grep 不到
 * `WOE_T`/`VOE_T` 字面量（疑似下沉原生模块），所以只能取开源实现里的同一张表。
 *
 * 替换方式：上游若换表，只需替换本文件两张数组；`tcEnvelope.ts` 的算法不变。
 */

/** `JG`：AES 逆 S-box 前 64 字节（混淆材料） */
export const JG: readonly number[] = [
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
  155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
  238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73,
  109, 139, 209, 37,
];

/** `KG`：hardcoded "password" 的另一半 */
export const KG: readonly number[] = [
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
  181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176,
  200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99,
  85, 33, 12, 125,
];

/** `pepper = JG XOR KG`（64 字节） */
export function traePepper(): Buffer {
  const out = Buffer.alloc(64);
  for (let i = 0; i < 64; i += 1) out[i] = (JG[i] as number) ^ (KG[i] as number);
  return out;
}
