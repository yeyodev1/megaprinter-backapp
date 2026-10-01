# Bot de WhatsApp de Megaprinter (BuilderBot Cloud)

Mismo esquema que Boloncity y Sorbito de Verdad: **el backend decide cada paso** y BuilderBot solo
enruta el mensaje y envía `{message}` al cliente. Gemini (`gemini-2.5-flash`) extrae datos del
mensaje y responde preguntas de productos usando el catálogo real; el backend valida todo lo que
devuelve (ids del catálogo, correo, precios) y si Gemini falla sigue con reglas.

## Flujo de una venta

1. El cliente pregunta ("laptop i7", "¿cuál me sirve para diseño?") → el bot muestra opciones numeradas del catálogo.
2. Elige ("1", "la segunda") → se agrega al carrito.
3. El bot pide lo que falte, en orden: nombre, correo, dirección o *retiro*, forma de pago.
4. Muestra el resumen y pide **sí**.
5. Crea el pedido `MP-000xx` (canal `whatsapp_bot`) y responde según el pago:
   - **Tarjeta**: link `https://megaprinter.ec/pagar/<token>` con la caja de Payphone.
   - **Transferencia**: datos de la cuenta y pide la **foto del comprobante**.
6. El comprobante (imagen o PDF) se sube a Cloudinary (`megaprinter/receipts`), Gemini lo lee
   (monto, cuenta destino, referencia) y el pedido queda **"Comprobante por revisar"**. Al equipo le llega un correo.
7. En el panel (`/admin/orders`) el equipo **aprueba** (pedido → Pagado) o **rechaza con motivo**
   (el cliente lo ve en su enlace y puede mandar otro). **La IA nunca aprueba un pago sola.**

**Activar transferencias:** desde el panel, *Sistema → Pagos* (`/admin/payments`): interruptor
"Aceptar transferencias" + banco, tipo, número, titular y RUC/cédula. Apagado, ni la web ni el bot
ofrecen transferencia; los pedidos que ya estaban por transferencia siguen viendo la cuenta para pagar.

Si solo hay un método de pago configurado, no se pregunta. Si no hay ninguno, el pedido queda
"Por contactar" para un asesor.

## Endpoints

Base: `https://megaprinter-backapp.vercel.app/api/orders/whatsapp-bot`

| Endpoint | Uso |
|---|---|
| `POST /brain` | **Principal.** Toda la conversación, incluido el comprobante si llega su URL. |
| `POST /assistant` | Alias de `/brain` (flows tipo Sorbito que mandan solo `{history}`). |
| `POST /transfer-receipt` | Nodo opcional para el evento de imagen/documento. |
| `GET\|POST /catalog` | Resumen del catálogo (con mensaje corre el turno completo). |
| `GET\|POST /search-order` | Pedidos del teléfono o por número `MP-…`. |

Todas responden **HTTP 200** siempre (un 4xx/5xx deja al cliente sin respuesta).

### Campos del body (Body con campos, RAW apagado)

| Campo | Variable BuilderBot | Notas |
|---|---|---|
| `rawMessage` | `{body}` | Texto del cliente. También acepta `body`, `message` o `history={history}`. |
| `phone` | `{from}` | Teléfono; también `from`. Acepta JID `…@s.whatsapp.net`. |
| `urlTempFile` | variable del archivo del evento de imagen/documento | También `fileUrl`, `mediaUrl`, `imageUrl`, `url`. **Verificar el nombre exacto en el panel de BuilderBot.** |

### Respuesta

```json
{
  "success": true,
  "intencion": "conversar | menu | dudas | consultar_pedido | orden_creada | comprobante_recibido",
  "telefonoSoporte": "",
  "route": "conversation | catalog | confirmOrder | checkoutCard | checkoutTransfer | checkoutAdvisor | awaitingReceipt | receiptReceived | searchOrder | human",
  "message": "texto para el cliente (nunca vacío)",
  "step": "idle | choosing | name | email | address | payment | confirm | ordered",
  "decision": "R7:orden_creada",
  "readyToCheckout": false,
  "orderNumber": "MP-00012",
  "paymentMethod": "card | transfer | ",
  "paymentLink": "https://megaprinter.ec/pagar/…",
  "total": 649,
  "cart": [{ "productId": "…", "name": "…", "quantity": 1, "price": 649 }],
  "missingData": [],
  "targetEndpoint": "/api/orders/whatsapp-bot/brain"
}
```

Las Rules de BuilderBot van por **`route`** (ver "Flujos"). `decision` es solo para depurar
(qué regla respondió). `intencion` se mantiene por compatibilidad con Boloncity.

## Flujos en BuilderBot

Regla de oro: **solo el Flujo Principal decide.** Llama a `/brain`, envía `{message}` y salta con
Rules por `route`. Los demás flujos **nunca llaman a `/brain`** (procesarían el mensaje dos veces).
`route = conversation` no lleva Rule: el cliente sigue en el Principal.

| `route` | Qué pasó | Flujo destino | ¿Obligatorio? |
|---|---|---|---|
| `conversation` | Sigue la charla (busca, elige, da datos) | Ninguno | — |
| `catalog` | Pidió el catálogo; ya recibió el resumen | Catálogo | Opcional |
| `confirmOrder` | Ya recibió el resumen del pedido; falta su "sí" | Ninguno | — |
| `checkoutCard` | Pedido creado, ya recibió el link de Payphone | Pago con tarjeta | Opcional |
| `checkoutTransfer` | Pedido creado, ya recibió la cuenta bancaria | Esperar comprobante | Recomendado |
| `awaitingReceipt` | Dijo "ya transferí" o dio su N.º MP-; se le pidió la foto | Esperar comprobante | Recomendado |
| `receiptReceived` | Llegó el comprobante, queda en revisión | Ninguno | — |
| `checkoutAdvisor` | Pedido creado sin método de pago activo | Asesor humano | Recomendado |
| `searchOrder` | Ya recibió el estado de sus pedidos | Ninguno | — |
| `human` | Pidió un asesor o tiene un reclamo | Asesor humano | **Sí** |

En todos los nodos HTTP: `POST`, header `Content-Type: application/json`, **Body con campos (RAW apagado)**.
Base: `https://megaprinter-backapp.vercel.app/api/orders/whatsapp-bot`.

### 1. Flujo Principal (evento GENERAL)
- HTTP `POST /brain` · `rawMessage = {body}` · `phone = {from}`
- Enviar al cliente: **ON** con `{message}`
- Rules por `route`: `human` → Asesor humano · `checkoutAdvisor` → Asesor humano ·
  `checkoutTransfer` → Esperar comprobante · `awaitingReceipt` → Esperar comprobante ·
  (opcionales) `catalog` → Catálogo · `checkoutCard` → Pago con tarjeta
- Nunca una Rule hacia el mismo Flujo Principal (bucle).

### 2. Esperar comprobante (sin evento, solo por Rule)
- Paso "esperar respuesta del cliente" (acepta imagen o documento).
- HTTP `POST /transfer-receipt` · `phone = {from}` · `rawMessage = {body}` · `urlTempFile = <variable del archivo>`
- Enviar al cliente: **ON** con `{message}`
- Rule: `human` → Asesor humano. Ninguna Rule hacia este mismo flujo.
- Si el cliente escribe texto en vez de la foto, el endpoint lo responde como conversación normal.

### 3. Comprobante (evento MEDIA / DOCUMENTO)
Para comprobantes que llegan más tarde, fuera del flujo 2. Mismo nodo HTTP que el flujo 2, sin Rules.

### 4. Asesor humano (sin evento, solo por Rule)
El bot ya le dijo al cliente que lo atiende una persona. Este flujo solo **silencia el bot**
(ej. 60 min) y avisa al equipo (notificación/etiqueta de BuilderBot). Sin nodo HTTP.

### 5. Pago con tarjeta (opcional)
El link ya va en `{message}`. Úsalo solo para etiquetar el chat o mandar un recordatorio. Sin nodo HTTP.

### 6. Catálogo (opcional)
El resumen ya va en `{message}`. Úsalo para enviar un PDF o imagen del catálogo. Sin nodo HTTP.

### Seguridad (opcional, recomendado)
Con `WHATSAPP_BOT_SECRET` en Vercel, cada nodo HTTP debe mandar el header `X-Bot-Token: <valor>`.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `GEMINI_API_KEY` | Gemini (extracción, respuestas de productos y lectura del comprobante). Sin ella el bot funciona con reglas. |
| `GEMINI_MODEL` | Opcional, por defecto `gemini-2.5-flash`. |
| `PUBLIC_WEB_URL` | Base del link de pago (por defecto `https://megaprinter.ec`). |
| `BOT_SUPPORT_PHONE` | Opcional: número que el bot da cuando piden un asesor. |
| `WHATSAPP_BOT_SECRET` | Opcional: exige `X-Bot-Token`. |
| `BOT_TEST_PHONE` | Solo fuera de producción: fija el teléfono (pruebas por Telegram/Postman). |
| Ya existentes | `PAYPHONE_TOKEN`, `PAYPHONE_STORE_ID`, `CLOUDINARY_*`, `RESEND_API_KEY`, `EMAIL_TO`. |

## Pruebas

```bash
pnpm test:bot              # conversaciones completas sin red ni Mongo
VERBOSE=1 pnpm test:bot    # imprime las conversaciones
```

Para probar contra la API: `reiniciatodo` borra la conversación del teléfono.

## Qué NO se copió de Sorbito (a propósito)

- Aprobación automática del pago por IA → aquí siempre la aprueba una persona.
- Tomar el carrito de otro teléfono si no llega el propio (fuga de datos).
- Datos bancarios escritos en el código → ahora se editan desde el panel (Sistema → Pagos).
- Mensajes proactivos por WhatsApp (violan la política de Meta).
