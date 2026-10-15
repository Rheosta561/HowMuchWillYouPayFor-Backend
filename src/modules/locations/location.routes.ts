import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { LocationService, decodeCityCursor } from "./location.service.js";
import { ok, fail } from "../ideas/api-envelope.js";
import { normalizeCountryCode } from "./country.model.js";

const citiesQuerySchema = z.object({
  search: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

export function createLocationRouter(service: LocationService = new LocationService()): Router {
  const router = Router();

  router.get("/countries", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      ok(res, await service.listActiveCountries());
    } catch (err) {
      next(err);
    }
  });

  router.get("/countries/:countryCode/cities", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.params.countryCode;
      const code = normalizeCountryCode(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
      if (!/^[A-Z]{2}$/.test(code)) {
        fail(res, req, 400, "VALIDATION_ERROR", "Invalid country code.", []);
        return;
      }
      const country = await service.findActiveCountry(code);
      if (!country) {
        fail(res, req, 404, "COUNTRY_NOT_FOUND", "Country not found.", []);
        return;
      }
      const parsed = citiesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "Invalid pagination parameters.", parsed.error.issues);
        return;
      }
      let decodedCursor: { name: string; id: string } | undefined;
      if (parsed.data.cursor) {
        const decoded = decodeCityCursor(parsed.data.cursor);
        if (!decoded) {
          fail(res, req, 400, "VALIDATION_ERROR", "Invalid pagination cursor.", []);
          return;
        }
        decodedCursor = decoded;
      }
      const { cities, nextCursor } = await service.listCitiesOfCountry(code, {
        search: parsed.data.search,
        limit: parsed.data.limit,
        cursor: decodedCursor,
      });
      ok(res, cities, { limit: parsed.data.limit, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
