import { NextFunction, Request, Response, Router } from "express";
import { requireAdmin } from "../middlewares/admin.middleware";
import { buildAttentionReport, ecuadorDate, sendAttentionReportEmail } from "../services/attentionReport.service";
import { crmHealth } from "../services/crm.service";
import { runDailyLearning } from "../services/botLearning.service";

const router = Router();
const validDate = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

/** GET /api/reports/attention?date=YYYY-MM-DD (hoy en Ecuador por defecto). */
router.get("/attention", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await buildAttentionReport(validDate(req.query.date) || ecuadorDate()));
  } catch (error) {
    next(error);
  }
});

/** POST /api/reports/attention/send { date? } — reenvía el correo del resumen desde el panel. */
router.post("/attention/send", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = await sendAttentionReportEmail(validDate(req.body?.date) || ecuadorDate(1));
    if (!email.ok) return res.status(502).json({ error: `No se pudo enviar: ${email.error || "error desconocido"}` });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** GET /api/reports/crm — estado de la conexion con el CRM de BuilderBot. */
router.get("/crm", requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await crmHealth());
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reports/daily-email — lo llama el cron de Vercel cada mañana con el
 * resumen de ayer. Vercel manda `Authorization: Bearer $CRON_SECRET` si existe.
 */
const fromCron = (req: Request) => {
  const secret = process.env.CRON_SECRET;
  return secret ? req.headers.authorization === `Bearer ${secret}` : /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
};

router.get("/daily-email", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!fromCron(req)) return res.status(401).json({ error: "Solo el cron" });
    const { report, email } = await sendAttentionReportEmail();
    console.log(`[reportes] resumen ${report.date}: ${report.totals.conversations} personas, ${report.totals.handoffs} asesor, correo ${email.ok ? "ok" : email.error}`);
    res.json({ ok: email.ok, date: report.date });
  } catch (error) {
    next(error);
  }
});

/** GET /api/reports/daily-learning — cron de cada mañana: Mila revisa los chats de ayer y aprende. */
router.get("/daily-learning", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!fromCron(req)) return res.status(401).json({ error: "Solo el cron" });
    const result = await runDailyLearning(undefined, { email: true });
    console.log(`[aprendizaje] ${result.date}: ${result.metrics.conversations} chats, ${result.added.length} lecciones${result.error ? `, ${result.error}` : ""}`);
    res.json({ ok: !result.error, date: result.date, added: result.added.length });
  } catch (error) {
    next(error);
  }
});

export default router;
