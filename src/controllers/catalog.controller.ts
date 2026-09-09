import { NextFunction, Request, Response } from "express";
import { CategoryModel } from "../models/category.model";
import { ProductModel } from "../models/product.model";
import { importOffersCatalog as runOffersImport } from "../services/catalogImport.service";
import { slugify } from "../utils/slugify";

/**
 * Lista blanca de campos editables. Antes se hacia `ProductModel.create(req.body)`,
 * de modo que un cliente podia inyectar cualquier campo del documento.
 */
const productPayload = (body: Record<string, any>) => {
  const payload: Record<string, unknown> = {};

  if (typeof body.name === "string") payload.name = body.name.trim();
  if (typeof body.description === "string") payload.description = body.description.trim();
  if (body.price !== undefined) payload.price = Number(body.price);
  if (typeof body.imageUrl === "string") payload.imageUrl = body.imageUrl.trim();
  if (typeof body.category === "string") payload.category = body.category;
  if (body.kind === "product" || body.kind === "service") payload.kind = body.kind;
  if (typeof body.active === "boolean") payload.active = body.active;

  // Precio anterior: vacio, 0 o null significa "sin oferta".
  if (body.originalPrice !== undefined) {
    const value = body.originalPrice === null || body.originalPrice === "" ? 0 : Number(body.originalPrice);
    payload.originalPrice = value > 0 ? value : null;
  }

  if (Array.isArray(body.specifications)) {
    payload.specifications = body.specifications
      .filter((spec: any) => spec && typeof spec.label === "string" && typeof spec.value === "string")
      .map((spec: any) => ({ label: spec.label.trim(), value: spec.value.trim() }))
      .filter((spec: any) => spec.label && spec.value);
  }

  return payload;
};

/**
 * Valida la relacion entre precio y precio anterior. Un "antes" menor o igual
 * al precio actual mostraria un descuento negativo en la tienda.
 */
const priceError = (payload: Record<string, unknown>, current?: { price: number; originalPrice?: number | null }) => {
  const price = typeof payload.price === "number" ? payload.price : current?.price;
  const originalPrice =
    payload.originalPrice !== undefined ? (payload.originalPrice as number | null) : current?.originalPrice ?? null;

  if (typeof price === "number" && Number.isNaN(price)) return "El precio no es válido";
  if (originalPrice !== null && Number.isNaN(originalPrice)) return "El precio anterior no es válido";
  if (originalPrice !== null && typeof price === "number" && originalPrice <= price) {
    return "El precio anterior debe ser mayor al precio actual";
  }
  return null;
};

export async function listCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await CategoryModel.find().sort({ name: 1 }));
  } catch (error) {
    next(error);
  }
}

export async function createCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "El nombre de la categoría es obligatorio" });

    const slug = slugify(name);
    if (!slug) return res.status(400).json({ error: "El nombre de la categoría no es válido" });

    res.status(201).json(await CategoryModel.create({ name, slug }));
  } catch (error) {
    next(error);
  }
}

export async function deleteCategory(req: Request, res: Response, next: NextFunction) {
  try {
    if (await ProductModel.exists({ category: req.params.id })) {
      return res
        .status(409)
        .json({ error: "La categoría tiene productos asociados. Muévelos o elimínalos primero." });
    }

    const deleted = await CategoryModel.findByIdAndDelete(req.params.id);
    // Antes devolvia 204 aunque el id no existiera, ocultando errores del panel.
    if (!deleted) return res.status(404).json({ error: "Categoría no encontrada" });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = { active: true };
    if (req.query.kind === "product" || req.query.kind === "service") filter.kind = req.query.kind;

    res.json(
      await ProductModel.find(filter).populate("category", "name slug").sort({ createdAt: -1 }),
    );
  } catch (error) {
    next(error);
  }
}

export async function listAllProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.kind === "product" || req.query.kind === "service") filter.kind = req.query.kind;

    res.json(
      await ProductModel.find(filter).populate("category", "name slug").sort({ createdAt: -1 }),
    );
  } catch (error) {
    next(error);
  }
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const payload = productPayload(req.body ?? {});

    if (!payload.category) {
      return res.status(400).json({ error: "La categoría es obligatoria" });
    }
    if (!(await CategoryModel.exists({ _id: payload.category }))) {
      return res.status(400).json({ error: "La categoría seleccionada no existe" });
    }

    const invalid = priceError(payload);
    if (invalid) return res.status(400).json({ error: invalid });

    const product = await ProductModel.create(payload);
    res.status(201).json(await product.populate("category", "name slug"));
  } catch (error) {
    next(error);
  }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const payload = productPayload(req.body ?? {});

    if (payload.category && !(await CategoryModel.exists({ _id: payload.category }))) {
      return res.status(400).json({ error: "La categoría seleccionada no existe" });
    }

    const current = await ProductModel.findById(req.params.id, "price originalPrice");
    if (!current) return res.status(404).json({ error: "Producto no encontrado" });

    const invalid = priceError(payload, current);
    if (invalid) return res.status(400).json({ error: invalid });

    const product = await ProductModel.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    }).populate("category", "name slug");

    if (!product) return res.status(404).json({ error: "Producto no encontrado" });

    res.json(product);
  } catch (error) {
    next(error);
  }
}

export async function deleteProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const deleted = await ProductModel.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Producto no encontrado" });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function importOffersCatalog(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await runOffersImport());
  } catch (error) {
    next(error);
  }
}
