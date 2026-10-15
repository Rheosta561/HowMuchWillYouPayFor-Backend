import mongoose, { Schema, type HydratedDocument } from "mongoose";

export interface CountryDoc {
  /** Stable identifier: ISO 3166-1 alpha-2 code, uppercase. */
  _id: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CountryDocument = HydratedDocument<CountryDoc>;

export function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase();
}

const countrySchema = new Schema<CountryDoc>(
  {
    _id: { type: String, required: true, match: /^[A-Z]{2}$/ },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

countrySchema.index({ active: 1, name: 1 });

countrySchema.pre("validate", function () {
  if (this._id) this._id = normalizeCountryCode(this._id);
});

export const CountryModel: mongoose.Model<CountryDoc> =
  (mongoose.models.Country as mongoose.Model<CountryDoc> | undefined) ??
  mongoose.model<CountryDoc>("Country", countrySchema);
