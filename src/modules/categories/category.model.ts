import mongoose, { Schema, type HydratedDocument } from "mongoose";

export interface CategoryDoc {
  /** Canonical slug, always lowercase. Unique (case-insensitive by normalization). */
  slug: string;
  name: string;
  active: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export type CategoryDocument = HydratedDocument<CategoryDoc>;

export function normalizeCategorySlug(slug: string): string {
  return slug.trim().toLowerCase();
}

const categorySchema = new Schema<CategoryDoc>(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, required: true, default: true },
    order: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

categorySchema.index({ active: 1, order: 1, name: 1 });

categorySchema.pre("validate", function () {
  if (this.slug) this.slug = normalizeCategorySlug(this.slug);
});

export const CategoryModel: mongoose.Model<CategoryDoc> =
  (mongoose.models.Category as mongoose.Model<CategoryDoc> | undefined) ??
  mongoose.model<CategoryDoc>("Category", categorySchema);
