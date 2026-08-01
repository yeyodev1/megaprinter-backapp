import { Router } from "express";
import { createCategory, createProduct, deleteCategory, deleteProduct, importOffersCatalog, listAllProducts, listCategories, listProducts, updateProduct } from "../controllers/catalog.controller";
import { requireAdmin } from "../middlewares/admin.middleware";
import multer from "multer";
import { uploadCatalogImage } from "../controllers/upload.controller";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp|avif)$/.test(file.mimetype)),
});

router.get("/categories", listCategories);
router.post("/categories", requireAdmin, createCategory);
router.delete("/categories/:id", requireAdmin, deleteCategory);
router.get("/products", listProducts);
router.get("/products/manage", requireAdmin, listAllProducts);
router.post("/products/import-offers", requireAdmin, importOffersCatalog);
router.post("/uploads/image", requireAdmin, upload.single("image"), uploadCatalogImage);
router.post("/products", requireAdmin, createProduct);
router.put("/products/:id", requireAdmin, updateProduct);
router.delete("/products/:id", requireAdmin, deleteProduct);

export default router;
