import axios from "axios";
import { UploadApiResponse } from "cloudinary";
import cloudinary from "../config/cloudinary";
import { geminiJson } from "./gemini.service";
import { escapeHtml, sendStoreEmail } from "./email.service";
import { PaymentSettingsModel } from "../models/paymentSettings.model";

/**
 * Pagos por transferencia: datos de la cuenta, comprobantes y aviso al equipo.
 *
 * La cuenta y el interruptor viven en Mongo y se editan desde el panel
 * (/admin/payments). En Sorbito estaban escritos en cuatro lugares del codigo.
 */

export interface BankDetails {
  bank: string;
  accountType: string;
  accountNumber: string;
  accountHolder: string;
  holderId: string;
}

export interface TransferSettings extends BankDetails {
  enabled: boolean;
}

const EMPTY: TransferSettings = { enabled: false, bank: "", accountType: "", accountNumber: "", accountHolder: "", holderId: "" };

// Cache corto: el bot lee la configuracion en cada mensaje. Se limpia al guardar.
let cache: { at: number; value: TransferSettings } | null = null;
const CACHE_MS = 30_000;

export async function getTransferSettings(): Promise<TransferSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const doc: any = await PaymentSettingsModel.findById("payments").lean();
  const value = { ...EMPTY, ...(doc?.transfer || {}) } as TransferSettings;
  cache = { at: Date.now(), value };
  return value;
}

export async function saveTransferSettings(input: Partial<TransferSettings>, updatedBy: string) {
  const clean = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 120) : "");
  const transfer: TransferSettings = {
    enabled: input.enabled === true,
    bank: clean(input.bank),
    accountType: clean(input.accountType),
    accountNumber: clean(input.accountNumber).replace(/\s+/g, ""),
    accountHolder: clean(input.accountHolder),
    holderId: clean(input.holderId).replace(/\s+/g, ""),
  };
  await PaymentSettingsModel.updateOne({ _id: "payments" }, { $set: { transfer, updatedBy } }, { upsert: true });
  cache = null;
  return transfer;
}

const toDetails = ({ enabled: _enabled, ...details }: TransferSettings): BankDetails => details;

/** Cuenta para OFRECER transferencia a pedidos nuevos: null si esta apagada o incompleta. */
export async function bankDetails(): Promise<BankDetails | null> {
  const settings = await getTransferSettings();
  return settings.enabled && settings.accountNumber ? toDetails(settings) : null;
}

/**
 * Cuenta para un pedido YA creado por transferencia: se muestra aunque luego
 * se apague la opcion, porque ese cliente todavia tiene que pagar.
 */
export async function transferAccount(): Promise<BankDetails | null> {
  const settings = await getTransferSettings();
  return settings.accountNumber ? toDetails(settings) : null;
}

export const transferEnabled = async () => (await bankDetails()) !== null;

/** Datos de la cuenta en formato WhatsApp. */
export function bankText(details: BankDetails) {
  return [
    details.bank && `🏦 *${details.bank}*`,
    details.accountType && `Cuenta ${details.accountType}`,
    `N.º *${details.accountNumber}*`,
    details.accountHolder && `A nombre de: ${details.accountHolder}`,
    details.holderId && `RUC/Cédula: ${details.holderId}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const RECEIPT_MIME = /^image\/(jpe?g|png|webp|heic|heif)$|^application\/pdf$/i;
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export interface ReceiptFile {
  buffer: Buffer;
  mimeType: string;
}

/** Descarga el archivo temporal que manda BuilderBot (sus URLs caducan). */
export async function downloadReceipt(url: string): Promise<ReceiptFile> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    maxContentLength: MAX_RECEIPT_BYTES,
  });
  const mimeType = String(response.headers["content-type"] || "").split(";")[0].trim() || "image/jpeg";
  return { buffer: Buffer.from(response.data), mimeType };
}

export const isAcceptedReceipt = (mimeType: string) => RECEIPT_MIME.test(mimeType);

async function uploadReceipt(file: ReceiptFile, orderNumber: string): Promise<string> {
  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "megaprinter/receipts",
        public_id: `${orderNumber}-${Date.now()}`,
        resource_type: file.mimeType === "application/pdf" ? "raw" : "image",
      },
      (error, upload) => (error || !upload ? reject(error || new Error("Cloudinary upload failed")) : resolve(upload)),
    );
    stream.end(file.buffer);
  });
  return result.secure_url;
}

export interface ReceiptAnalysis {
  isReceipt: boolean | null;
  amountMatches: boolean | null;
  accountMatches: boolean | null;
  detectedAmount: number | null;
  detectedBank: string;
  detectedReference: string;
  summary: string;
}

const RECEIPT_PROMPT = `Eres asistente contable de Megaprinter (tienda de tecnología en Ecuador). Te muestran una imagen que un cliente envió como comprobante de transferencia o depósito.
Devuelve SOLO JSON: {"isReceipt":bool,"detectedAmount":number|null,"detectedAccount":"","detectedBank":"","detectedReference":"","summary":""}
- isReceipt: true solo si es un comprobante bancario real (transferencia, depósito o pago por app del banco). Fotos de productos, capturas de chat o imágenes borrosas = false.
- detectedAmount: monto transferido en dólares, con decimales. null si no se lee.
- detectedAccount: número de cuenta destino tal como aparece (puede venir enmascarado, ej. ****6030).
- detectedReference: número de comprobante, referencia o documento.
- summary: una frase en español para el equipo (banco, monto, fecha, destinatario). No apruebes ni rechaces: solo describe.`;

/**
 * Lectura del comprobante con Gemini. Solo ayuda al equipo a revisar: el pago
 * se aprueba a mano en el panel (Sorbito aprobaba solo con la IA).
 */
export async function analyzeReceipt(
  file: ReceiptFile,
  expected: { total: number; orderNumber: string },
): Promise<ReceiptAnalysis | null> {
  if (!file.mimeType.startsWith("image/")) return null;
  const details = await transferAccount();
  const parsed = await geminiJson<any>({
    system: RECEIPT_PROMPT,
    text: `Pedido ${expected.orderNumber}. Monto esperado: $${expected.total.toFixed(2)}. Cuenta destino esperada: ${details?.accountNumber || "(no configurada)"} ${details?.bank || ""} a nombre de ${details?.accountHolder || "(no configurado)"}.`,
    image: { mimeType: file.mimeType, base64: file.buffer.toString("base64") },
    maxOutputTokens: 400,
    timeoutMs: 15000,
  });
  if (!parsed) return null;

  const detectedAmount = Number.isFinite(Number(parsed.detectedAmount)) && parsed.detectedAmount !== null
    ? Math.round(Number(parsed.detectedAmount) * 100) / 100
    : null;
  const accountDigits = String(parsed.detectedAccount || "").replace(/\D/g, "");
  const expectedDigits = (details?.accountNumber || "").replace(/\D/g, "");

  return {
    isReceipt: typeof parsed.isReceipt === "boolean" ? parsed.isReceipt : null,
    amountMatches: detectedAmount === null ? null : Math.abs(detectedAmount - expected.total) < 0.01,
    // Los bancos enmascaran la cuenta: basta con que coincidan los ultimos 4 digitos.
    accountMatches:
      accountDigits.length >= 4 && expectedDigits ? expectedDigits.endsWith(accountDigits.slice(-4)) : null,
    detectedAmount,
    detectedBank: String(parsed.detectedBank || "").slice(0, 80),
    detectedReference: String(parsed.detectedReference || "").slice(0, 80),
    summary: String(parsed.summary || "").slice(0, 400),
  };
}

/**
 * Guarda un comprobante en el pedido: lo sube a Cloudinary, lo lee con la IA,
 * deja el pedido "en revision" y avisa al equipo por correo.
 */
export async function attachReceipt(order: any, file: ReceiptFile, via: "whatsapp" | "web") {
  const orderNumber = order.orderNumber || String(order._id);
  const [url, analysis] = await Promise.all([
    uploadReceipt(file, orderNumber),
    analyzeReceipt(file, { total: order.totalAmount, orderNumber }),
  ]);

  const receipts = [...(order.transfer?.receipts || []), { url, receivedAt: new Date(), via, analysis: analysis || {} }];
  order.set("transfer.receipts", receipts);
  order.set("transfer.status", "in_review");
  await order.save();

  const adminUrl = `${(process.env.PUBLIC_WEB_URL || "https://megaprinter.ec").replace(/\/$/, "")}/admin/orders?transfer=in_review`;
  void sendStoreEmail(
    `Comprobante por revisar ${orderNumber} - $${order.totalAmount.toFixed(2)}`,
    `
      <h2>Llegó un comprobante de transferencia</h2>
      <p><strong>Pedido:</strong> ${escapeHtml(orderNumber)} (${via === "whatsapp" ? "WhatsApp" : "web"})</p>
      <p><strong>Cliente:</strong> ${escapeHtml(order.customerName)} · ${escapeHtml(order.customerPhone)}</p>
      <p><strong>Total del pedido:</strong> $${order.totalAmount.toFixed(2)}</p>
      ${analysis ? `<p><strong>Lectura automática:</strong> ${escapeHtml(analysis.summary)}${analysis.detectedAmount !== null ? ` (monto leído $${analysis.detectedAmount.toFixed(2)})` : ""}</p>` : ""}
      <p><a href="${url}">Ver comprobante</a> · <a href="${adminUrl}">Revisar en el panel</a></p>
    `,
    order.customerEmail,
  );

  return { url, analysis };
}
