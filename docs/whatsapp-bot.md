# Bot de WhatsApp de Megaprinter (BuilderBot Cloud)

Mismo esquema que Boloncity y Sorbito de Verdad: **el backend decide cada paso** y BuilderBot solo
enruta el mensaje y envía `{message}` al cliente. Gemini (`gemini-2.5-flash`) extrae datos del
mensaje y responde preguntas de productos usando el catálogo real; el backend valida todo lo que
devuelve (ids del catálogo, correo, precios) y si Gemini falla sigue con reglas.

## Personalidad: Mila

El bot es **Mila** 🤖, *el bot de Megaprinter y tu agente para lo que necesites* (nombre configurable con `BOT_NAME`): siempre
amigable y dispuesta a ayudar ("pídeme lo que necesites"), cercana, nada formal, tutea y usa emojis. Signos de pregunta y exclamación **solo al
final** ("Cómo prefieres pagar?"), nunca "¿" ni "¡": un filtro final los quita de todo lo que sale,
incluidas las respuestas de Gemini.

### Voz con IA (sin repetir mensajes)

El router decide QUÉ decir; luego Gemini reescribe el mensaje con la voz de Mila, distinto a sus
últimos 3 mensajes. Los datos no se tocan: las líneas de listas, viñetas, cuenta bancaria y resumen
deben salir idénticas, y en el texto libre se conservan MP-, montos, números, links y correos. Si la
IA cambia un dato, tarda más de 8 s o falla, se envía el texto original. `BOT_AI_VOICE=off` la apaga.

## Políticas de Meta (WhatsApp Business) y cómo se cumplen

| Regla de Meta | Cómo la cumple el bot |
|---|---|
| Desde el 15-ene-2026 se prohíben los chatbots de **propósito general** (asistentes tipo ChatGPT); solo bots de un negocio concreto | Gemini solo responde sobre el catálogo, pedidos y servicio de Megaprinter. Lo que no es del negocio (tareas, recetas, política, programación…) se clasifica `fuera_de_tema` y Mila redirige con amabilidad (`R8:fuera_de_tema`). |
| Escalamiento a una persona | "asesor", reclamo o garantía → `route = human` → flujo 🙋 Asesor humano + Silenciar. |
| Responder dentro de 30 s | `/brain` decide sin IA (milisegundos). Los flujos usan Gemini con timeout de 12–15 s; si falla, siguen con reglas. |
| Transparencia: decir que es un bot | Mila se presenta como *"el bot de Megaprinter"* 🤖. Si preguntan "eres un bot?", "hablo con una persona?" o "eres real?", responde *"Sí, soy un bot 🤖"* y ofrece *asesor* (`R2:soy_un_bot`). La voz con IA no puede quitar la palabra "bot" ni decir que es una persona. Ofrece ayuda con "lo que necesites" (no "lo que sea"): todo dentro del negocio. |
| Respetar a quien no quiere mensajes | "no me escribas", "stop", "no gracias" → Mila lo confirma y queda marcado (`optOut`). |
| Mensajes fuera de plantilla solo dentro de la ventana de 24 h que abre el cliente; **cobrados desde el 1-oct-2026** | El bot **solo responde** (`{message}`) a lo que escribe el cliente: un mensaje por turno, nunca escribe primero. No hay envíos salientes ni recordatorios automáticos. |

Fuentes: developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages,
blog.chattigo.com (WhatsApp prohíbe chatbots de propósito general), developargentina.com (2026).

## Cuentas para transferencias

Se cargan en el panel: **Sistema → Pagos** (`/admin/payments`). Cada cuenta tiene banco (con logo
automático), tipo, número, titular, RUC/cédula y un interruptor para pausarla. Con varias cuentas
activas, Mila pregunta **"A qué banco te queda mejor transferir?"** mostrando solo los nombres; envía
los datos de **una sola** cuenta, la elegida, y el pedido la guarda. En la web, `/pagar/:token` muestra
los bancos con logo y la cuenta aparece al elegir. El cliente también puede decir el banco directo
("te pago por Pichincha"); "Quito, Pichincha" en una dirección no cuenta como banco.

Logos: servicio de íconos de Google por dominio (sin API key). Se puede poner una URL propia por cuenta.

## Flujo de una venta

1. El cliente pregunta ("laptop i7", "¿cuál me sirve para diseño?") → el bot muestra opciones numeradas del catálogo.
2. Elige ("1", "la segunda") → se agrega al carrito.
3. El bot pide lo que falte, en orden: nombre, correo, dirección o *retiro*, forma de pago y, si es
   transferencia con varias cuentas, el banco.
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
| `POST /brain` | **Flujo principal.** Solo decide `route`; `message` vacío. |
| `POST /conversation` | Turno completo: responde y saca los datos. |
| `POST /checkout` | Turno completo (el "sí" que crea el pedido). |
| `POST /search-order` | Turno completo (estado de pedidos, "ya transferí", MP-). |
| `POST /human` | Turno completo (aviso de que lo atiende una persona). |
| `GET\|POST /catalog` | Turno completo; sin mensaje, solo el resumen del catálogo. |
| `POST /media` | Fotos, PDF, videos y audios (alias `/transfer-receipt`). |

Todas responden **HTTP 200** siempre (un 4xx/5xx deja al cliente sin respuesta).

### Campos del body (Body con campos, RAW apagado)

| Campo | Variable BuilderBot | Notas |
|---|---|---|
| `rawMessage` | `{body}` | Texto del cliente. También acepta `body`, `message` o `history={history}`. |
| `phone` | `{from}` | Teléfono; también `from`. Acepta JID `…@s.whatsapp.net`. |
| `urlTempFile` | `{urlTempFile}` | Foto o PDF. La IA la analiza siempre: comprobante → al pedido; foto de producto → busca en el catálogo. |
| `history` | `{history}` | Opcional, recomendado. Contexto para la IA (incluye lo que escribió un asesor a mano). El backend además guarda su propio historial por teléfono (30 mensajes, 3 días). |

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

## Flujos en BuilderBot (6 flujos)

**`/brain` solo decide** a qué flujo va el mensaje (`route`); no responde ni toca el pedido. Cada
flujo destino llama a su endpoint, que procesa el mensaje completo y responde en `{message}`.
Todos los endpoints procesan el turno completo: consultas de pedido, pedidos sin método de pago y
fotos se atienden bien aunque no tengan un flujo propio.

Todos los nodos HTTP: `POST`, `Content-Type: application/json`, Body con campos (RAW apagado):
`rawMessage = {body}`, `phone = {from}`, `history = {history}`, `urlTempFile = {urlTempFile}`.
Base: `https://megaprinter-backapp.vercel.app/api/orders/whatsapp-bot`.

| Flujo | Evento | Endpoint | Enviar al cliente | Después |
|---|---|---|---|---|
| 🧠 Principal | GENERAL | `/brain` | **APAGADO** | Rules por `route` (abajo) |
| 💬 Conversación | ACCIÓN | `/conversation` | `{message}` | Sin Rules |
| 📚 Catálogo | ACCIÓN | `/catalog` | `{message}` | Sin Rules |
| 💳 Checkout tarjeta | ACCIÓN | `/checkout` | `{message}` | Sin Rules |
| 🏦 Checkout transferencia | IMAGEN O VÍDEO | `/checkout` | `{message}` | Sin Rules (también recibe fotos y comprobantes) |
| 🙋 Asesor humano | ACCIÓN | `/human` | `{message}` | Paso Silenciar (60 min) |

Rules de 🧠 Principal:

| `route` | Va a | Cuándo |
|---|---|---|
| `conversation` | 💬 Conversación | Charla, búsqueda, datos, consultas de pedido, "eres un bot?" |
| `catalog` | 📚 Catálogo | Pide el catálogo |
| `checkoutCard` | 💳 Checkout tarjeta | "sí" al resumen con tarjeta |
| `checkoutTransfer` | 🏦 Checkout transferencia | "sí" al resumen con transferencia, o llega una foto |
| `human` | 🙋 Asesor humano | Pide un asesor, reclamo o garantía |

Nunca una Rule hacia el mismo flujo (bucle). Los flujos destino no llevan Rules.
Endpoints extra disponibles: `/search-order`, `/media` (alias `/transfer-receipt`).

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

## Logs (qué pasa en cada mensaje)

- **Panel:** `megaprinter.ec/admin/bot` (en vivo).
- **Terminal:** `pnpm bot:logs` (últimos 60 pasos), `pnpm bot:logs -- 0991234567` (un número),
  `pnpm bot:logs -- --errors`. Lee la bitácora de Mongo (30 días).
- **Vercel:** cada mensaje deja una línea `[bot]` con teléfono, decisión de `/brain`, flujo, regla,
  tiempo, lo que escribió el cliente y lo que respondió Mila.

## Pagos con tarjeta: link, pago y "pagado"

1. Al confirmar, Mila manda `megaprinter.ec/pagar/<token>`. Cada vez que se abre se crea un intento
   nuevo; los anteriores se guardan (`clientTransactionIds`).
2. Si el cliente vuelve a la web después de pagar, `/pay-response` confirma y el pedido queda Pagado.
3. Si cierra la pestaña y escribe **"pagado"** / "ya pagué", el bot consulta a Payphone cada intento,
   hace la confirmación obligatoria (sin ella Payphone revierte la venta a los 5 min) y el pedido
   queda Pagado. Si aún no aparece, no toca nada y le reenvía el link. Rechazado: link para reintentar.
   Monto distinto: pasa a una persona. Un segundo "pagado" responde "ya está confirmado" sin volver a cobrar.

Simulación de 25 compras completas: `docs/simulacion-25-compras.md`.

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
