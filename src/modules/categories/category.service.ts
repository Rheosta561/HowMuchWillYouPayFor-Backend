import { CategoryModel, normalizeCategorySlug } from "./category.model.js";

export interface CategoryView {
  slug: string;
  name: string;
  order: number;
}

export class CategoryService {
  constructor(private readonly model: typeof CategoryModel = CategoryModel) {}

  async listActive(): Promise<CategoryView[]> {
    const docs = await this.model.find({ active: true }).sort({ order: 1, name: 1 }).exec();
    return docs.map((d) => ({ slug: d.slug, name: d.name, order: d.order }));
  }

  /** Case-insensitive lookup: input is normalized before matching. */
  async findActiveBySlug(slug: string) {
    return this.model.findOne({ slug: normalizeCategorySlug(slug), active: true }).exec();
  }

  async requireActiveBySlug(slug: string, ErrorClass: new (slug: string) => Error) {
    const doc = await this.findActiveBySlug(slug);
    if (!doc) throw new ErrorClass(slug);
    return doc;
  }
}
