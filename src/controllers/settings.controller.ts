import { NextFunction, Response } from "express";
import { AdminRequest } from "../middlewares/admin.middleware";
import { PaymentSettingsModel } from "../models/paymentSettings.model";
import { KNOWN_BANKS, bankLogo } from "../services/banks";
import { getTransferSettings, saveTransferSettings } from "../services/transfer.service";

async function paymentSettingsResponse() {
  const doc: any = await PaymentSettingsModel.findById("payments").lean();
  return {
    transfer: await getTransferSettings(),
    updatedBy: doc?.updatedBy || "",
    updatedAt: doc?.updatedAt || null,
    // Bancos que el panel ofrece en el selector, con su logo.
    knownBanks: Object.entries(KNOWN_BANKS).map(([code, bank]) => ({ code, name: bank.name, logoUrl: bankLogo(code) })),
  };
}

export async function getPaymentSettings(_req: AdminRequest, res: Response, next: NextFunction) {
  try {
    res.json(await paymentSettingsResponse());
  } catch (error) {
    next(error);
  }
}

/** Guarda el interruptor y las cuentas. Activar exige al menos una cuenta activa completa. */
export async function updatePaymentSettings(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const transfer = req.body?.transfer ?? {};
    const accounts: any[] = Array.isArray(transfer.accounts) ? transfer.accounts : [];
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    for (const [index, account] of accounts.entries()) {
      const label = `Cuenta ${index + 1}`;
      if (!text(account?.bankCode) && !text(account?.bank)) return res.status(400).json({ error: `${label}: elige el banco` });
      if (!/^[\d\s-]{4,30}$/.test(text(account?.accountNumber))) return res.status(400).json({ error: `${label}: el número de cuenta solo puede tener dígitos` });
      if (!text(account?.accountHolder)) return res.status(400).json({ error: `${label}: falta el titular` });
    }
    if (transfer.enabled === true && !accounts.some((account) => account?.active !== false)) {
      return res.status(400).json({ error: "Para activar transferencias deja al menos una cuenta activa" });
    }

    await saveTransferSettings({ enabled: transfer.enabled === true, accounts }, req.admin?.email || "");
    res.json(await paymentSettingsResponse());
  } catch (error) {
    next(error);
  }
}
