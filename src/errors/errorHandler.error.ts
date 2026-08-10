import { Response } from "express";
import axios from "axios";

export class ErrorHandler {
  private slackWebhookUrl: string;

  constructor(slackWebhookUrl: string) {
    this.slackWebhookUrl = slackWebhookUrl;
  }

  handleHttpError(res: Response, message: string, status: number, error: any) {
    console.error(`[${status}] ${message}`, error?.details || error?.stack || "");

    if (this.slackWebhookUrl && status >= 500) {
      this.notifySlack(message, status, error).catch(() => {});
    }

    if (res.headersSent) return;

    // Se envian las dos claves a proposito: los controladores responden
    // `{ error }` y este manejador respondia `{ message }`, asi que el frontend
    // mostraba un texto generico cada vez que el error venia por aqui.
    res.status(status).json({ error: message, message });
  }

  private async notifySlack(message: string, status: number, error: any) {
    await axios.post(this.slackWebhookUrl, {
      text: `:rotating_light: *Error ${status}*\n>${message}\n\`\`\`${JSON.stringify(
        error?.details || error?.stack || "",
        null,
        2,
      )}\`\`\``,
    });
  }
}
