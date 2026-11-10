/** 带 HTTP 状态码与错误码的业务错误基类；REST 层统一序列化为 { error: { code, message } } */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

export class ConflictError extends ApiError {
  constructor(message = '资源冲突') {
    super(409, 'CONFLICT', message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = '资源不存在') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = '无权执行该操作') {
    super(403, 'FORBIDDEN', message);
  }
}

export class ValidationError extends ApiError {
  constructor(message = '参数不合法', code = 'VALIDATION_ERROR') {
    super(400, code, message);
  }
}
