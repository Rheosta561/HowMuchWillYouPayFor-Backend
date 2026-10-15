import jwt from "jsonwebtoken";
import { env } from "../../../config/env.js";

export interface AccessTokenPayload {
  sub: string;
  role: string;
  iss?: string;
  aud?: string;
}

export class TokenService {
  constructor(
    private readonly accessSecret: string = env.JWT_ACCESS_SECRET,
    private readonly accessTtlSeconds: number = env.JWT_ACCESS_TTL_SECONDS,
    private readonly issuer: string = env.JWT_ISSUER,
    private readonly audience: string = env.JWT_AUDIENCE,
  ) {}

  issueAccessToken(userId: string, role: string): string {
    return jwt.sign({ sub: userId, role }, this.accessSecret, {
      expiresIn: this.accessTtlSeconds,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    const decoded = jwt.verify(token, this.accessSecret, {
      issuer: this.issuer,
      audience: this.audience,
    });
    if (typeof decoded === "string" || !decoded.sub) {
      throw new Error("Invalid access token payload");
    }
    return decoded as AccessTokenPayload;
  }
}
