/** 服务端版本单一来源：createRequire 按模块 URL 定位本包 package.json（src/ 与打包后 dist/ 均在其上一级）。 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const SERVER_VERSION = pkg.version ?? '0.0.0';
