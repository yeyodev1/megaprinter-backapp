import { NextFunction, Response } from "express";
import { isValidObjectId } from "mongoose";
import { AdminRequest, actorName } from "../middlewares/admin.middleware";
import { BotLearningRunModel } from "../models/botLearningRun.model";
import { BotLessonModel } from "../models/botLesson.model";
import { BotChatReviewModel } from "../models/botChatReview.model";
import { BotPersonaModel } from "../models/botPersona.model";
import { PhotoMatchModel } from "../models/photoMatch.model";
import { ProductModel } from "../models/product.model";
import { photoExamplesChanged } from "../services/whatsappBot/photoLearning";
import { loadPersona, personaChanged } from "../services/whatsappBot/persona";
import { ecuadorDate } from "../services/attentionReport.service";
import { runDailyLearning } from "../services/botLearning.service";
import { LESSON_KINDS, LessonKind, MAX_PROMPT_LESSONS, lessonsChanged } from "../services/whatsappBot/learning";

const STATUSES = ["activa", "pendiente", "descartada"];

/** GET /api/bot/learning — ultimos dias revisados y todas las lecciones. */
export async function getLearning(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const [runs, lessons, reviews] = await Promise.all([
      BotLearningRunModel.find({}).sort({ _id: -1 }).limit(30).lean(),
      BotLessonModel.find({}).sort({ updatedAt: -1 }).limit(500).lean(),
      BotChatReviewModel.find({}).sort({ createdAt: -1 }).limit(30).lean(),
    ]);
    res.json({ runs, lessons, reviews, maxActive: MAX_PROMPT_LESSONS });
  } catch (error) {
    next(error);
  }
}

/** POST /api/bot/learning/run { date?, dryRun?, email? } — revisa un dia ahora (ayer por defecto); dryRun solo muestra lo que aprenderia. */
export async function runLearningNow(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const date = typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? req.body.date : ecuadorDate(1);
    const result = await runDailyLearning(date, { email: Boolean(req.body?.email), dryRun: Boolean(req.body?.dryRun) });
    if (result.error) return res.status(502).json({ error: result.error, result });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

const cleanText = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 320) : "");

/** POST /api/bot/learning/lessons { kind, text, example? } — leccion escrita por el equipo (activa al instante). */
export async function createLesson(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const kind = req.body?.kind as LessonKind;
    const text = cleanText(req.body?.text);
    if (!LESSON_KINDS.includes(kind)) return res.status(400).json({ error: "Tipo de lección inválido" });
    if (text.length < 10) return res.status(400).json({ error: "Escribe la lección (mínimo 10 caracteres)" });
    const lesson = await BotLessonModel.create({ kind, text, example: cleanText(req.body?.example).slice(0, 200), status: "activa", source: "manual", updatedBy: actorName(req) });
    lessonsChanged();
    res.status(201).json(lesson);
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/bot/learning/lessons/:id { status?, text?, kind? } — aprobar, descartar o corregir. */
export async function updateLesson(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "No existe" });
    const set: Record<string, unknown> = { updatedBy: actorName(req) };
    if (req.body?.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: "Estado inválido" });
      set.status = req.body.status;
    }
    if (req.body?.kind !== undefined) {
      if (!LESSON_KINDS.includes(req.body.kind)) return res.status(400).json({ error: "Tipo de lección inválido" });
      set.kind = req.body.kind;
    }
    if (req.body?.text !== undefined) {
      const text = cleanText(req.body.text);
      if (text.length < 10) return res.status(400).json({ error: "La lección es muy corta" });
      set.text = text;
    }
    const lesson = await BotLessonModel.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!lesson) return res.status(404).json({ error: "No existe" });
    lessonsChanged();
    res.json(lesson);
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/bot/learning/lessons/:id */
export async function deleteLesson(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "No existe" });
    await BotLessonModel.deleteOne({ _id: req.params.id });
    lessonsChanged();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

// ─── Vista (fotos de productos) ──────────────────────────────────────────────

/** GET /api/bot/learning/photos — ultimas fotos de clientes y el catalogo para corregirlas. */
export async function listPhotos(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const [photos, products] = await Promise.all([
      PhotoMatchModel.find({}).sort({ createdAt: -1 }).limit(80).lean(),
      ProductModel.find({ active: true, kind: { $ne: "service" } }, { name: 1, price: 1, imageUrl: 1, category: 1 }).populate("category", "name").sort({ name: 1 }).lean(),
    ]);
    const counts = await PhotoMatchModel.aggregate([{ $group: { _id: "$status", total: { $sum: 1 } } }]);
    res.json({
      photos,
      products: products.map((product: any) => ({ _id: product._id, name: product.name, price: product.price, imageUrl: product.imageUrl || "", category: product.category?.name || "" })),
      counts: Object.fromEntries(counts.map((item) => [item._id, item.total])),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/bot/learning/photos/:id { productId | null, status? } — el equipo
 * dice cual era el producto (null = no esta en el catalogo) o descarta la foto.
 * Entra como ejemplo de la vista desde la siguiente foto.
 */
export async function updatePhoto(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "No existe" });
    const set: Record<string, unknown> = { confirmedBy: actorName(req) || "equipo" };
    if (req.body?.status === "descartada") set.status = "descartada";
    else {
      const productId = req.body?.productId;
      if (productId !== null && !isValidObjectId(productId)) return res.status(400).json({ error: "Elige un producto" });
      if (productId && !(await ProductModel.exists({ _id: productId }))) return res.status(400).json({ error: "Ese producto no existe" });
      set.productId = productId;
      set.status = "corregida";
    }
    const photo = await PhotoMatchModel.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!photo) return res.status(404).json({ error: "No existe" });
    photoExamplesChanged();
    res.json(photo);
  } catch (error) {
    next(error);
  }
}

// ─── Personalidad (solo admin) ───────────────────────────────────────────────

const rules = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === "string" ? item.replace(/\s+/g, " ").trim().slice(0, 240) : ""))
    .filter((item) => item.length >= 3)
    .slice(0, 30);

/** GET /api/bot/persona */
export async function getPersona(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const doc: any = await BotPersonaModel.findById("persona").lean();
    res.json(doc || { personality: "", alwaysSay: [], neverSay: [], updatedBy: "", updatedAt: null });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/bot/persona { personality, alwaysSay[], neverSay[] } — Mila lo aplica al instante. */
export async function savePersona(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const personality = typeof req.body?.personality === "string" ? req.body.personality.replace(/\s+/g, " ").trim().slice(0, 800) : "";
    const doc = await BotPersonaModel.findByIdAndUpdate(
      "persona",
      { $set: { personality, alwaysSay: rules(req.body?.alwaysSay), neverSay: rules(req.body?.neverSay), updatedBy: actorName(req) } },
      { upsert: true, new: true },
    ).lean();
    personaChanged();
    await loadPersona(true);
    res.json(doc);
  } catch (error) {
    next(error);
  }
}
