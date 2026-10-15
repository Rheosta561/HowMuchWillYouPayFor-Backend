import { CountryModel, normalizeCountryCode } from "./country.model.js";
import { CityModel, normalizeCityName } from "./city.model.js";

export interface CountryView {
  code: string;
  name: string;
}

export interface CityView {
  id: string;
  name: string;
  countryCode: string;
  slug: string;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class LocationService {
  constructor(
    private readonly countries: typeof CountryModel = CountryModel,
    private readonly cities: typeof CityModel = CityModel,
  ) {}

  async listActiveCountries(): Promise<CountryView[]> {
    const docs = await this.countries.find({ active: true }).sort({ name: 1 }).exec();
    return docs.map((d) => ({ code: d._id, name: d.name }));
  }

  async findActiveCountry(code: string) {
    return this.countries.findOne({ _id: normalizeCountryCode(code), active: true }).exec();
  }

  /** Cities of a country with anchored, index-backed prefix search. */
  async listCitiesOfCountry(
    countryCode: string,
    opts: { search?: string; limit?: number; cursor?: { name: string; id: string } },
  ): Promise<{ cities: CityView[]; nextCursor: string | null }> {
    const code = normalizeCountryCode(countryCode);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const filter: Record<string, unknown> = { countryCode: code, active: true };
    if (opts.search) {
      // Anchored prefix on the normalized name: uses the
      // { countryCode, name, _id } index instead of a full scan.
      filter.name = { $regex: `^${escapeRegExp(normalizeCityName(opts.search))}` };
    }
    if (opts.cursor) {
      filter.$or = [
        { name: { $gt: opts.cursor.name } },
        { name: opts.cursor.name, _id: { $gt: opts.cursor.id } },
      ];
    }
    const docs = await this.cities.find(filter).sort({ name: 1, _id: 1 }).limit(limit + 1).exec();
    const page = docs.slice(0, limit);
    const last = page[page.length - 1];
    return {
      cities: page.map((d) => ({
        id: String(d._id),
        name: d.displayName,
        countryCode: d.countryCode,
        slug: d.slug,
      })),
      nextCursor:
        docs.length > limit && last
          ? Buffer.from(JSON.stringify({ name: last.name, id: String(last._id) }), "utf8").toString("base64url")
          : null,
    };
  }

  async findActiveCityById(id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    return this.cities.findOne({ _id: id, active: true }).exec();
  }
}

export function decodeCityCursor(cursor: string): { name: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { name?: unknown }).name === "string" &&
      typeof (parsed as { id?: unknown }).id === "string" &&
      /^[a-f0-9]{24}$/i.test((parsed as { id: string }).id)
    ) {
      return parsed as { name: string; id: string };
    }
    return null;
  } catch {
    return null;
  }
}
