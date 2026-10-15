import { env } from "../../../config/env.js";

export interface SendOtpInput {
  to: string;
  code: string;
  expiresInMinutes: number;
}

/**
 * Email sender abstraction for OTP delivery.
 *
 * Implementations must never expose OTP codes through public API responses
 * or application logs. The code is passed here in memory only and must be
 * handed directly to the mail provider.
 */
export interface EmailSender {
  sendOtp(input: SendOtpInput): Promise<void>;
}

export interface SentOtpMessage extends SendOtpInput {
  sentAt: Date;
}

/**
 * In-memory sender. Captures messages in an outbox for tests and local
 * development. Nothing is logged and nothing leaves the process.
 */
export class InMemoryEmailService implements EmailSender {
  readonly outbox: SentOtpMessage[] = [];

  async sendOtp(input: SendOtpInput): Promise<void> {
    this.outbox.push({ ...input, sentAt: new Date() });
  }

  lastCodeFor(email: string): string | undefined {
    const normalized = email.trim().toLowerCase();
    for (let i = this.outbox.length - 1; i >= 0; i -= 1) {
      if (this.outbox[i]!.to.trim().toLowerCase() === normalized) return this.outbox[i]!.code;
    }
    return undefined;
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

/**
 * Development sender. Keeps an in-memory outbox (inspectable via the
 * instance, never via HTTP) and logs only delivery metadata — never the
 * OTP code itself.
 */
export class DevEmailService extends InMemoryEmailService {
  override async sendOtp(input: SendOtpInput): Promise<void> {
    await super.sendOtp(input);
    console.log(
      `[email-otp] code sent to ${input.to} (expires in ${input.expiresInMinutes}m)`,
    );
  }
}

/**
 * Resend-backed sender for production. Requires RESEND_API_KEY and EMAIL_FROM.
 * See docs/email-provider.md for configuration.
 */
export class ResendEmailService implements EmailSender {
  constructor(
    private readonly apiKey: string = env.RESEND_API_KEY,
    private readonly from: string = env.EMAIL_FROM,
  ) {
    if (!this.apiKey) throw new Error("RESEND_API_KEY is required for the resend email provider");
  }

  async sendOtp(input: SendOtpInput): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: input.to,
        subject: "Your sign-in code",
        text:
          `Your HowMuchWillYouPayFor sign-in code:\n\n${input.code}\n\n` +
          `It is valid for ${input.expiresInMinutes} minutes. ` +
          `If you did not request this code, you can ignore this email.`,
        html:
          `<p>Your HowMuchWillYouPayFor sign-in code:</p>` +
          `<p><strong>${escapeHtml(input.code)}</strong></p>` +
          `<p>It is valid for ${input.expiresInMinutes} minutes. ` +
          `If you did not request this code, you can ignore this email.</p>`,
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend delivery failed with status ${res.status}`);
    }
  }
}

export type EmailProviderName = "dev" | "resend" | "memory";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Factory: selects the sender from EMAIL_PROVIDER. Defaults to dev. */
export function createEmailSender(name: EmailProviderName = env.EMAIL_PROVIDER): EmailSender {
  if (name === "resend") return new ResendEmailService();
  if (name === "memory") return new InMemoryEmailService();
  return new DevEmailService();
}
