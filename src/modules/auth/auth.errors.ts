export class AuthError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, opts: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = opts.statusCode ?? 400;
    this.code = opts.code ?? "AUTH_ERROR";
  }
}

export class InvalidProviderError extends AuthError {
  constructor(provider: string) {
    super(`Unsupported auth provider: ${provider}`, { statusCode: 400, code: "INVALID_PROVIDER" });
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor(message = "Invalid credentials") {
    super(message, { statusCode: 401, code: "INVALID_CREDENTIALS" });
  }
}

export class OtpRequiredError extends AuthError {
  constructor(message = "OTP verification required") {
    super(message, { statusCode: 401, code: "OTP_REQUIRED" });
  }
}

export class OtpInvalidError extends AuthError {
  constructor(message = "Invalid OTP code") {
    super(message, { statusCode: 401, code: "OTP_INVALID" });
  }
}

export class OtpExpiredError extends AuthError {
  constructor(message = "OTP code has expired") {
    super(message, { statusCode: 410, code: "OTP_EXPIRED" });
  }
}

export class OtpRateLimitedError extends AuthError {
  constructor(message = "Too many OTP attempts") {
    super(message, { statusCode: 429, code: "OTP_RATE_LIMITED" });
  }
}

export class AccountSuspendedError extends AuthError {
  constructor(message = "Account is suspended or deleted") {
    super(message, { statusCode: 403, code: "ACCOUNT_SUSPENDED" });
  }
}

export class ProviderConflictError extends AuthError {
  constructor(message = "Provider identity already linked to another account") {
    super(message, { statusCode: 409, code: "PROVIDER_CONFLICT" });
  }
}

export class EmailNotVerifiedError extends AuthError {
  constructor(message = "Email ownership is not verified") {
    super(message, { statusCode: 403, code: "EMAIL_NOT_VERIFIED" });
  }
}

export class GoogleVerificationError extends AuthError {
  constructor(message = "Google token verification failed") {
    super(message, { statusCode: 401, code: "GOOGLE_VERIFICATION_FAILED" });
  }
}

export class InvalidTokenError extends AuthError {
  constructor(message = "Invalid or expired credentials.") {
    super(message, { statusCode: 401, code: "INVALID_TOKEN" });
  }
}

export class InvalidRefreshTokenError extends AuthError {
  constructor(message = "Invalid refresh token") {
    super(message, { statusCode: 401, code: "INVALID_REFRESH_TOKEN" });
  }
}

export class RefreshTokenReuseError extends AuthError {
  constructor(message = "Refresh token reuse detected") {
    super(message, { statusCode: 401, code: "REFRESH_TOKEN_REUSED" });
  }
}

export class CsrfError extends AuthError {
  constructor(message = "CSRF validation failed") {
    super(message, { statusCode: 403, code: "CSRF_INVALID" });
  }
}
