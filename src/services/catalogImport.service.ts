import { CategoryModel } from "../models/category.model";
import { ProductModel } from "../models/product.model";
import { offersCatalog } from "../data/offersCatalog";
import { slugify } from "../utils/slugify";

export interface ImportSummary {
  imported: number;
  created: number;
  updated: number;
  categories: number;
}

/**
 * Sincroniza la base de datos con `offersCatalog` (el catalogo de ofertas que
 * publica Megaprinter cada mes). Es idempotente: los productos se identifican
 * por nombre, asi que volver a ejecutarlo actualiza precios, fotos y fichas
 * sin duplicar publicaciones. Lo usan tanto el boton "Cargar ofertas base"
 * del panel como el script `pnpm catalog:import`.
 */
export async function importOffersCatalog(): Promise<ImportSummary> {
  const categoryIds = new Map<string, string>();

  for (const name of new Set(offersCatalog.map((item) => item.category))) {
    const slug = slugify(name);
    const category = await CategoryModel.findOneAndUpdate(
      { slug },
      { $setOnInsert: { name, slug } },
      { new: true, upsert: true },
    );
    categoryIds.set(name, category.id);
  }

  let created = 0;
  let updated = 0;

  for (const item of offersCatalog) {
    const { category, ...fields } = item;
    const result = await ProductModel.findOneAndUpdate(
      { name: item.name },
      { $set: { ...fields, category: categoryIds.get(category), kind: "product", active: true } },
      { new: true, upsert: true, setDefaultsOnInsert: true, includeResultMetadata: true },
    );

    if (result.lastErrorObject?.updatedExisting) updated += 1;
    else created += 1;
  }

  return { imported: offersCatalog.length, created, updated, categories: categoryIds.size };
}
