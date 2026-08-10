import "dotenv/config";

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import http from "http";
import routerApi from "./routes";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";
import { dbConnect } from "./config/mongo";
import { CustomError } from "./errors/customError.error";

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

export function createApp() {
  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json({ limit: "50mb" }));

  app.get("/", (_req, res) => {
    res.send("Server is alive");
  });

  // En Vercel no se ejecuta `index.ts`, asi que nadie llamaba a `dbConnect()` y
  // toda peticion a /api fallaba. `dbConnect` cachea la conexion, por lo que
  // esto solo hace trabajo real en el arranque en frio.
  app.use("/api", (_req, _res, next) => {
    dbConnect().then(() => next(), next);
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
