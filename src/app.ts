import express from "express";
import cors from "cors";
import http from "http";
import routerApi from "./routes";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";

const whitelist = [
  "http://localhost:8100",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:8101",
  "https://testing-storybrand-frontend.bakano.ec",
  "https://megaprinter.ec",
  "https://www.megaprinter.ec",
  ...(process.env.FRONTEND_URL || "").split(",").map((url) => url.trim()).filter(Boolean),
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || whitelist.includes(origin) || origin.endsWith(".vercel.app")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
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

  routerApi(app);

  app.use(globalErrorHandler);

  const server = http.createServer(app);

  return { app, server };
}

// Vercel's Node runtime recognizes the Express application as a serverless handler.
export default createApp().app;
