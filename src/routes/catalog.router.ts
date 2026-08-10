import { Router } from "express";
import multer from "multer";
import {
  createCategory,
  createProduct,
  deleteCategory,
  deleteProduct,
  importOffersCatalog,
  listAllProducts,
  listCategories,
  listProducts,
  updateProduct,
} from "../controllers/catalog.controller";
import { requireAdmin } from "../middlewares/admin.middleware";
import { uploadCatalogImage } from "../controllers/upload.controller";
import { CustomError } from "../errors/customError.error";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    // Antes se rechazaba en silencio con `callback(null, false)`: el archivo
    // desaparecia y el controlador respondia "Image file is required", que no
    // le dice al usuario que el problema era el formato.
    if (/^image\/(jpeg|png|webp|avif)$/.test(file.mimetype)) return callback(null, true);
    callback(new CustomError("Formato no admitido. Usa JPG, PNG, WebP o AVIF.", 415));
  },
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
