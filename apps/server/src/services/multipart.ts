/**
 * KB-IMG-1：极简 multipart/form-data 解析（零依赖）。
 *
 * 只做本项目需要的事：`POST /api/knowledge/pages/:id/images` 的「若干文本字段 + 1~2 个文件」。
 * 严格失败优于猜测：boundary 缺失、part 头不合法、没有文件 → 抛 ValidationError（路由层归一为 400/415）。
 * 不支持嵌套 multipart、不支持 base64 传输编码。
 */
import { ValidationError } from '../errors.js';

export interface MultipartFile {
  fieldName: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

export interface MultipartParseResult {
  fields: Record<string, string>;
  files: MultipartFile[];
}

export function boundaryOf(contentType: string | undefined): string {
  if (!contentType || !contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new ValidationError('上传必须使用 multipart/form-data');
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (boundary === '') throw new ValidationError('multipart 请求缺少 boundary');
  return boundary;
}

/** 解析 multipart 请求体；`maxParts` 防止恶意长尾（默认 8） */
export function parseMultipart(body: Buffer, contentType: string | undefined, options: { maxParts?: number } = {}): MultipartParseResult {
  const boundary = boundaryOf(contentType);
  const maxParts = options.maxParts ?? 8;
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw new ValidationError('multipart 请求体与 boundary 不匹配');
  let parts = 0;
  while (cursor >= 0) {
    const afterDelimiter = cursor + delimiter.length;
    // 结束标记：--boundary--
    if (body[afterDelimiter] === 0x2d && body[afterDelimiter + 1] === 0x2d) break;
    const headersStart = body.indexOf(Buffer.from('\r\n\r\n'), afterDelimiter);
    if (headersStart < 0) throw new ValidationError('multipart part 头部不完整');
    const headerText = body.subarray(afterDelimiter, headersStart).toString('utf8');
    const next = body.indexOf(delimiter, headersStart + 4);
    if (next < 0) throw new ValidationError('multipart 请求体缺少结束 boundary');
    // part 数据尾部会多一个 \r\n
    const dataEnd = next >= 2 && body[next - 2] === 0x0d && body[next - 1] === 0x0a ? next - 2 : next;
    const data = body.subarray(headersStart + 4, dataEnd);
    parts += 1;
    if (parts > maxParts) throw new ValidationError(`multipart part 数量超限（>${maxParts}）`);

    const disposition = /content-disposition:([^\r\n]*)/i.exec(headerText)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const partType = /content-type:\s*([^\r\n;]+)/i.exec(headerText)?.[1]?.trim() ?? null;
    if (name === '') throw new ValidationError('multipart part 缺少 name');
    if (filename !== null) files.push({ fieldName: name, filename, contentType: partType, data: Buffer.from(data) });
    else fields[name] = data.toString('utf8');
    cursor = next;
  }
  return { fields, files };
}
