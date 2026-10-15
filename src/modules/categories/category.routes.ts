import { Router, type Request, type Response, type NextFunction } from "express";
import { CategoryService } from "./category.service.js";
import { ok } from "../ideas/api-envelope.js";

export function createCategoryRouter(service: CategoryService = new CategoryService()): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const categories = await service.listActive();
      ok(res, categories);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
