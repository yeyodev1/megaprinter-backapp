import { NextFunction, Request, Response } from "express";
import { CategoryModel } from "../models/category.model";
import { ProductModel } from "../models/product.model";
import { offersCatalog } from "../data/offersCatalog";

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export async function listCategories(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await CategoryModel.find().sort({ name: 1 })); } catch (error) { next(error); }
}

export async function createCategory(req: Request, res: Response, next: NextFunction) {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Category name is required" });
  try { res.status(201).json(await CategoryModel.create({ name, slug: slugify(name) })); } catch (error) { next(error); }
}

export async function deleteCategory(req: Request, res: Response, next: NextFunction) {
  try {
    if (await ProductModel.exists({ category: req.params.id })) return res.status(409).json({ error: "Category has products" });
    await CategoryModel.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (error) { next(error); }
}

export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.kind === "product" || req.query.kind === "service") filter.kind = req.query.kind;
    filter.active = true;
    res.json(await ProductModel.find(filter).populate("category", "name slug").sort({ createdAt: -1 }));
  } catch (error) { next(error); }
}

export async function listAllProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.kind === "product" || req.query.kind === "service") filter.kind = req.query.kind;
    res.json(await ProductModel.find(filter).populate("category", "name slug").sort({ createdAt: -1 }));
  } catch (error) { next(error); }
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try { res.status(201).json(await ProductModel.create(req.body)); } catch (error) { next(error); }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const product = await ProductModel.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (error) { next(error); }
}

export async function deleteProduct(req: Request, res: Response, next: NextFunction) {
  try { await ProductModel.findByIdAndDelete(req.params.id); res.status(204).end(); } catch (error) { next(error); }
}

export async function importOffersCatalog(_req: Request, res: Response, next: NextFunction) {
  try {
    const categories = new Map<string, string>();
    for (const name of ["Laptops", "Monitores"]) {
      const category = await CategoryModel.findOneAndUpdate({ slug: slugify(name) }, { name, slug: slugify(name) }, { new: true, upsert: true, setDefaultsOnInsert: true });
      categories.set(name, category.id);
    }
    for (const item of offersCatalog) {
      await ProductModel.findOneAndUpdate({ name: item.name, description: item.description }, { ...item, category: categories.get(item.category), kind: "product", active: true }, { new: true, upsert: true, setDefaultsOnInsert: true });
    }
    res.json({ imported: offersCatalog.length });
  } catch (error) { next(error); }
}
