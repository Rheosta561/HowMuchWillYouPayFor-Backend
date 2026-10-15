import mongoose, { Schema, type HydratedDocument, type Types } from "mongoose";

export interface CityDoc {
  _id: Types.ObjectId;
  /** Normalized city name, lowercase. */
  name: string;
  /** Display name with original capitalization. */
  displayName: string;
  /** ISO 3166-1 alpha-2 code of the owning country. */
  countryCode: string;
  /** Stable slug unique within the country. */
  slug: string;
  /** External identifier where available (e.g. GeoNames id). */
  externalId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CityDocument = HydratedDocument<CityDoc>;

export function normalizeCityName(name: string): string {
  return name.trim().toLowerCase();
}

export function slugifyCityName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const citySchema = new Schema<CityDoc>(
  {
    name: { type: String, required: true },
    displayName: { type: String, required: true, trim: true },
    countryCode: { type: String, required: true, uppercase: true, trim: true },
    slug: { type: String, required: true },
    externalId: { type: String, default: null },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// City identity: slug unique within its country. Country lookup +
// anchored prefix search on the normalized name (uses the index).
citySchema.index({ countryCode: 1, slug: 1 }, { unique: true });
citySchema.index({ countryCode: 1, name: 1, _id: 1 });

citySchema.pre("validate", function () {
  if (this.displayName) {
    this.name = normalizeCityName(this.displayName);
    if (!this.slug) this.slug = slugifyCityName(this.displayName);
  }
  if (this.countryCode) this.countryCode = this.countryCode.trim().toUpperCase();
});

export const CityModel: mongoose.Model<CityDoc> =
  (mongoose.models.City as mongoose.Model<CityDoc> | undefined) ??
  mongoose.model<CityDoc>("City", citySchema);
