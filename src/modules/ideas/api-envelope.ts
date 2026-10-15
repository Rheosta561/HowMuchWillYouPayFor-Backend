import type { Request, Response } from "express";
import { z } from "zod";

export interface SuccessMeta {
  limit?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
  [key: string]: unknown;
}

/** Consistent success envelope for the ideas surface. */
export function ok(res: Response, data: unknown, meta: SuccessMeta = {}, status = 200): void {
  res.status(status).json({ success: true, data, meta });
}

export function fail(
  res: Response,
  req: Request,
  status: number,
  code: string,
  message: string,
  details: unknown[] = [],
): void {
  res.status(status).json({
    success: false,
    error: { code, message, details },
    requestId: req.requestId ?? null,
  });
}

export class IdeaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IdeaError";
  }
}

/** Maps domain errors to the ideas error envelope. Returns true when handled. */
export function sendIdeaError(res: Response, req: Request, err: unknown): boolean {
  if (err instanceof IdeaError) {
    fail(res, req, err.status, err.code, err.message, []);
    return true;
  }
  if (typeof err === "object" && err !== null && "issues" in err && err instanceof z.ZodError) {
    fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", err.issues);
    return true;
  }
  return false;
}
