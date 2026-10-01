import { NextFunction, Response } from "express";
import { AdminRequest } from "../middlewares/admin.middleware";
import { PaymentSettingsModel } from "../models/paymentSettings.model";
import { getTransferSettings, saveTransferSettings } from "../services/transfer.service";

async function paymentSettingsResponse() {
  const doc: any = await PaymentSettingsModel.findById("payments").lean();
  return { transfer: await getTransferSettings(), updatedBy: doc?.updatedBy || "", updatedAt: doc?.updatedAt || null };
}

export async function getPaymentSettings(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    res.json(await paymentSettingsResponse());
  } catch (error) {
    next(error);
  }
}

/** Guarda la cuenta y el interruptor. Activar exige banco, numero y titular. */
export async function updatePaymentSettings(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const transfer = req.body?.transfer ?? {};
    const value = (key: string) => (typeof transfer[key] === "string" ? transfer[key].trim() : "");
    if (transfer.enabled === true && (!value("bank") || !value("accountNumber") || !value("accountHolder"))) {
      return res.status(400).json({ error: "Para activar transferencias completa banco, número de cuenta y titular" });
    }
    if (value("accountNumber") && !/^[\d\s-]{4,30}$/.test(value("accountNumber"))) {
      return res.status(400).json({ error: "El número de cuenta solo puede tener dígitos" });
    }

    await saveTransferSettings(transfer, req.admin?.email || "");
    res.json(await paymentSettingsResponse());
  } catch (error) {
    next(error);
  }
}
