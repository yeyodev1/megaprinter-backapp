import "dotenv/config";

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import http from "http";
import multer from "multer";
import routerApi from "./routes";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";
import { dbConnect } from "./config/mongo";
import { CustomError } from "./errors/customError.error";
import { BOT_FALLBACK } from "./controllers/whatsappBot.controller";

const whitelist = [
  "http://localhost:8100",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:8101",
  "https://testing-storybrand-frontend.bakano.ec",
  "https://megaprinter.ec",
  "https://www.megaprinter.ec",
  ...(process.env.FRONTEND_URL || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || whitelist.includes(origin) || origin.endsWith(".vercel.app")) {
      return callback(null, true);
    }
    // Antes se pasaba un Error suelto y Express respondia un 500 con HTML.
    // Con CustomError el manejador global devuelve un 403 JSON legible.
    return callback(new CustomError(`Origin ${origin} not allowed by CORS`, 403));
  },
  credentials: true,
};

/**
 * Rutas del bot de WhatsApp. BuilderBot no es un navegador (sin CORS) y si
 * recibe un 4xx/5xx el cliente se queda sin respuesta: aqui todo responde 200.
 * Express compara rutas sin distinguir mayusculas, esta comparacion tampoco.
 */
export const isBotPath = (path: string) => {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* ruta mal codificada: se compara tal cual */
  }
  return decoded.toLowerCase().includes("/whatsapp-bot/");
};

export function createApp() {
  const app = express();

  app.use((req, res, next) => (isBotPath(req.path) ? next() : cors(corsOptions)(req, res, next)));
  app.use(express.json({ limit: "50mb" }));
  // "Body con campos" de BuilderBot puede llegar como formulario, texto o multipart.
  app.use((req, res, next) => (isBotPath(req.path) ? express.urlencoded({ extended: true, limit: "1mb" })(req, res, next) : next()));
  app.use((req, res, next) => (isBotPath(req.path) ? express.text({ type: "text/plain", limit: "1mb" })(req, res, next) : next()));
  const botMultipart = multer({ limits: { fieldSize: 1024 * 1024, fields: 50 } }).none();
  app.use((req, res, next) => {
    if (!isBotPath(req.path) || !req.is("multipart/form-data")) return next();
    botMultipart(req, res, (error?: unknown) => {
      if (error) console.warn(`[whatsapp-bot] multipart en ${req.path} incompleto: ${error instanceof Error ? error.message : error}`);
      if (!req.body || typeof req.body !== "object") req.body = {};
      next();
    });
  });
  app.use((req, _res, next) => {
    if (isBotPath(req.path) && typeof req.body === "string") {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        req.body = { rawMessage: req.body };
      }
    }
    next();
  });
  // JSON invalido (RAW encendido y el cliente escribio comillas): 200 con respaldo.
  app.use((error: any, req: Request, res: Response, next: NextFunction) => {
    if (isBotPath(req.path) && (error?.type === "entity.parse.failed" || error instanceof SyntaxError)) {
      console.error(`[whatsapp-bot] body invalido en ${req.path}: ${error.message}. Usa "Body con campos" (RAW apagado)`);
      return res.status(200).json(BOT_FALLBACK);
    }
    next(error);
  });
  // Secreto compartido opcional: con WHATSAPP_BOT_SECRET, BuilderBot debe mandar el header X-Bot-Token.
  app.use((req, res, next) => {
    const secret = process.env.WHATSAPP_BOT_SECRET;
    if (!secret || !isBotPath(req.path)) return next();
    const token = String(req.headers["x-bot-token"] || req.query.token || "");
    if (token === secret) return next();
    console.warn(`[whatsapp-bot] ${req.path} sin X-Bot-Token valido`);
    res.status(200).json({ ...BOT_FALLBACK, message: "" });
  });

  app.get("/", (_req, res) => {
    res.send("Server is alive");
  });

  // En Vercel no se ejecuta `index.ts`, asi que nadie llamaba a `dbConnect()` y
  // toda peticion a /api fallaba. `dbConnect` cachea la conexion, por lo que
  // esto solo hace trabajo real en el arranque en frio.
  app.use("/api", (req, res, next) => {
    dbConnect().then(
      () => next(),
      (error) => (isBotPath(req.originalUrl) ? res.status(200).json(BOT_FALLBACK) : next(error)),
    );
  });

  routerApi(app);

  // 404 en JSON: sin esto una ruta desconocida devolvia la pagina HTML por
  // defecto de Express y el frontend no podia interpretar el error.
  app.use("/api", (req: Request, _res: Response, next: NextFunction) => {
    next(new CustomError(`Route ${req.method} ${req.originalUrl} not found`, 404));
  });

  app.use(globalErrorHandler);

  const server = http.createServer(app);

  return { app, server };
}

// El runtime Node de Vercel reconoce la aplicacion Express como handler.
export default createApp().app;
