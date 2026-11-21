# 🏦 Agente Financiero Banco de Chile & Fintual Acciones Hub (PWA Android & Desktop)

Aplicación Web Progresiva (**PWA**) instalable en **Android** y escritorio, diseñada con un **Agente de Finanzas Personales IA** que monitorea, clasifica y audita en tiempo real los movimientos del **Banco de Chile** vía **Gmail**, y calcula el puente de liquidez hacia **Fintual Acciones**.

## 📲 URL de la Aplicación Móvil (PWA Instalable en Android)
👉 **[https://carlosfsepu-cloud.github.io/bch-finanzas-agent-pwa/](https://carlosfsepu-cloud.github.io/bch-finanzas-agent-pwa/)**

### Cómo instalarla en tu teléfono Android:
1. Abre **[https://carlosfsepu-cloud.github.io/bch-finanzas-agent-pwa/](https://carlosfsepu-cloud.github.io/bch-finanzas-agent-pwa/)** en **Google Chrome** desde tu Android.
2. Toca el botón **`📲 Instalar en Android`** en la barra superior (o el menú `⋮` de Chrome → **"Instalar aplicación"**).
3. Se instalará como una aplicación nativa con su propio ícono **`BCH Finanzas`** a pantalla completa.

---

## ☁️ Cómo activar la Sincronización Automática 24/7 con Gmail (con el PC apagado)
El archivo [`cloud-worker/Code.gs`](./cloud-worker/Code.gs) corre **100% gratis 24/7** en los servidores de Google dentro de tu propia cuenta `tu-correo@gmail.com`:

1. Abre [https://script.google.com](https://script.google.com) con tu cuenta `tu-correo@gmail.com`.
2. Crea un **Nuevo proyecto**, pega el contenido de [`cloud-worker/Code.gs`](./cloud-worker/Code.gs) y guarda.
3. Selecciona la función `instalarTriggerAutomatico24x7` en la barra superior y pulsa **Ejecutar** (autoriza la lectura de tus correos de `@bancochile.cl`).
4. Haz clic arriba a la derecha en **Implementar → Nueva implementación → Aplicación web** (*Ejecutar como: Yo*, *Quién tiene acceso: Cualquier persona*).
5. Copia la URL generada (`https://script.google.com/macros/s/.../exec`), abre la app en tu Android, toca **`☁️ Gmail 24/7`** y pégala.

---

## 🧩 4 Viñetas Principales
1. **`📊 Dashboard General 360°`**: Visión consolidada de Ingresos, Consumo Real (Débito + Crédito sin duplicar pagos de estado de cuenta), Reserva para pago de Tarjeta de Crédito, Liquidez Libre para Fintual y Gráfico Comparativo Mensual (`Sep` vs `Oct` vs `Nov`).
2. **`💳 Débito / Cuenta (****0401)`**: Movimientos en tiempo real de cuenta corriente, compras con débito, giros en cajero y transferencias.
3. **`💳 Tarjeta de Crédito (****4114)`**: Compras con crédito y **Planificador de Facturación Mensual y Reserva de Pago** (calcula cuánto dinero debes apartar cada mes para pagar la tarjeta).
4. **`📈 Fintual Acciones (Puente Multi-Agente)`**: Calcula el capital transferible hoy a Fintual Acciones en CLP y USD, monitorea tu portafolio (`VOO`, `QQQ`, `NVDA`, `MSFT`) y expone los endpoints REST (`GET /api/fintual/context`, `POST /api/fintual/agent-signal`, `POST /api/fintual/positions`) para tu segundo Agente de Inversiones.
