import express, { Application } from "express";
import orderRouter from "./order.router";
import catalogRouter from "./catalog.router";
import authRouter from "./auth.router";
import settingsRouter from "./settings.router";
import botRouter from "./bot.router";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/orders", orderRouter);
  router.use("/catalog", catalogRouter);
  router.use("/auth", authRouter);
  router.use("/settings", settingsRouter);
  router.use("/bot", botRouter);
}

export default routerApi;
