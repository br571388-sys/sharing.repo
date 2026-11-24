// Shared error types. Messages are for logs; `userMessage` (when set) is safe to show to users.

export class AppError extends Error {
  constructor(message, { code = 'app_error', cause, userMessage } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (cause) this.cause = cause;
    if (userMessage) this.userMessage = userMessage;
  }
}

export class DbError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'db_error', ...opts });
  }
}

/** Failure of an external API (anime, translation, image search...). */
export class ApiError extends AppError {
  constructor(message, { code = 'api_error', retryAfter, ...opts } = {}) {
    super(message, { code, ...opts });
    this.retryAfter = retryAfter;
  }
}

export class PermissionError extends AppError {
  constructor(message = 'Permission denied', opts = {}) {
    super(message, { code: 'permission_denied', ...opts });
  }
}

export class ValidationError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'validation_error', ...opts });
  }
}

/** Error returned by the Telegram Bot API (or a network failure talking to it). */
export class TelegramError extends AppError {
  constructor(message, { status = 0, method = '', retryAfter, migrateTo, cause } = {}) {
    super(message, { code: 'telegram_error', cause });
    this.status = status;
    this.method = method;
    this.retryAfter = retryAfter;
    this.migrateTo = migrateTo;
  }
}
