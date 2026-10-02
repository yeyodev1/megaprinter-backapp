import { AlertModel } from "../models/alert.model";

type AlertType = "order_new" | "payment_confirmed" | "receipt_review" | "ticket_new" | "human_handoff" | "email_failed";

/** Crea una alerta del panel. Nunca lanza ni bloquea. */
export function createAlert(type: AlertType, title: string, body = "", link = "") {
  void AlertModel.create({ type, title: title.slice(0, 160), body: body.slice(0, 500), link }).catch((error) =>
    console.error("[alertas] no se pudo crear la alerta:", error?.message || error),
  );
}
