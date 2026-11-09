# Serverless Multi-Project URL Shortener (Cloudflare Workers + D1 + R2)

Acortador de URLs ultraligero, sin dependencias de runtime y de costo cero, diseñado para ejecutarse en el Edge de Cloudflare utilizando **Cloudflare Workers** y **Cloudflare D1** (SQLite serverless).

Está optimizado para centralizar el acortamiento de rutas largas de **Cloudflare R2** (o URLs externas) a través de múltiples proyectos, incorporando caché en el Edge para minimizar las lecturas a la base de datos y el consumo de ejecuciones del Worker.

---

## Características Principales

- **Cero Dependencias:** Escrito en TypeScript nativo sobre las Web APIs estándar del runtime de Cloudflare Workers.
- **Soporte Multi-Proyecto:** Resuelve rutas relativas hacia distintos buckets o dominios CDN mediante un mapa de configuración (`PROJECT_DOMAINS`).
- **Inserción Individual y por Lotes (Batch):** Permite acortar desde 1 hasta 500 enlaces en una sola petición HTTP, ejecutando inserciones agrupadas en D1.
- **Caché en el Edge (`caches.default`):** Las redirecciones `301` se almacenan en la caché del CDN de Cloudflare (7 días) y del navegador (24 horas), evitando lecturas repetidas en D1.
- **Esquema SQLite Optimizado:** Tabla `WITHOUT ROWID` indexada por clave primaria (`slug`) para reducir a la mitad el uso de almacenamiento y acelerar las búsquedas.

---

## Arquitectura

1. **Creación (`POST /api/links`):** Recibe una URL completa o una ruta relativa junto con el identificador del proyecto (`project`), valida el token `Bearer`, genera un código Base62 de 6 caracteres (o usa un `slug` personalizado) y lo guarda en Cloudflare D1.
2. **Redirección (`GET /:slug`):**
   - Verifica primero si la redirección ya existe en la caché del Edge (`caches.default`).
   - Si no está en caché, consulta Cloudflare D1 (`< 2 ms`), devuelve un `301 Moved Permanently` y almacena el resultado en la caché del Edge de forma asíncrona (`ctx.waitUntil`).

---

## Requisitos Previos

- [Node.js](https://nodejs.org/) (v18 o superior)
- Una cuenta en [Cloudflare](https://dash.cloudflare.com/) (el plan gratuito cubre hasta 100,000 peticiones/día en Workers y 5 millones de lecturas/día en D1)
- Un dominio gestionado en Cloudflare (recomendado para habilitar caché de CDN y evitar el *rate-limiting* de las URLs de desarrollo `*.r2.dev`)

---

## Guía de Instalación y Configuración

### 1. Clonar o inicializar el proyecto

Si partes desde cero con el CLI de Cloudflare:

```bash
npm create cloudflare@latest r2-shortener -- --type=hello-world --ts=true --git=true --deploy=false
cd r2-shortener
```

O si clonas este repositorio:

```bash
git clone [https://github.com/nanoxxi93/r2-shortener.git](https://github.com/nanoxxi93/r2-shortener.git)
cd r2-shortener
npm install
```

### 2. Autenticarse en Cloudflare y crear la Base de Datos D1

Inicia sesión con Wrangler y crea la base de datos:

```bash
npx wrangler login
npx wrangler d1 create shortener-db
```

Copia el `database_id` que devuelve la consola y colócalo en tu archivo `wrangler.jsonc` (o `wrangler.toml`).

### 3. Configurar `wrangler.jsonc`

Asegúrate de configurar el binding de tu base de datos D1 y el mapa `PROJECT_DOMAINS` con los dominios públicos o personalizados de tus buckets R2:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "r2-shortener",
  "main": "src/index.ts",
  "compatibility_date": "2025-02-01",
  "observability": {
    "enabled": true
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "shortener-db",
      "database_id": "TU-DATABASE-ID-AQUI"
    }
  ],
  "vars": {
    "PROJECT_DOMAINS": {
      "app1": "[https://app1-cdn.tudominio.com](https://app1-cdn.tudominio.com)",
      "default": "[https://cdn.tudominio.com](https://cdn.tudominio.com)"
    }
  }
}
```

> **Nota sobre Cloudflare R2:** Se recomienda conectar un **Custom Domain** a cada bucket de R2 (**R2 > Bucket > Settings > Custom Domains**) en lugar de usar las URLs `*.r2.dev`, ya que los subdominios `.r2.dev` tienen límites de concurrencia (*rate-limiting*) y no permiten caché de CDN.

### 4. Inicializar las tablas en D1

El archivo `schema.sql` define la estructura de la base de datos:

```sql
CREATE TABLE IF NOT EXISTS links (
  slug TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  project TEXT DEFAULT 'default',
  created_at INTEGER DEFAULT (unixepoch())
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_links_project ON links(project);
```

Ejecuta la migración en tu entorno local y en la nube (remoto):

```bash
# Base de datos local (para desarrollo)
npx wrangler d1 execute shortener-db --local --file=./schema.sql

# Base de datos en producción (Cloudflare Edge)
npx wrangler d1 execute shortener-db --remote --file=./schema.sql
```

### 5. Variables de Entorno y Secretos (`API_SECRET`)

Para proteger el endpoint de creación de enlaces, genera un token aleatorio seguro (por ejemplo, ejecutando `openssl rand -hex 32` o `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

#### En Desarrollo Local (`.dev.vars`)
Crea un archivo `.dev.vars` en la raíz del proyecto (este archivo está ignorado por Git):

```ini
API_SECRET="tu_token_secreto_generado"
```

Luego genera los tipos de TypeScript automáticamente:

```bash
npx wrangler types
```

#### En Producción (Cloudflare Secrets)
Sube el secreto encriptado a Cloudflare ejecutando:

```bash
npx wrangler secret put API_SECRET
```
*(La terminal te pedirá pegar el valor de tu token).*

---

## Desarrollo y Despliegue

Levantar el entorno de pruebas local:

```bash
npm run dev
```

Desplegar a producción en Cloudflare Workers:

```bash
npm run deploy
```

Para asignar un subdominio corto personalizado al Worker (ej. `s.tudominio.com`), ve al panel de Cloudflare en **Workers & Pages > r2-shortener > Settings > Domains & Routes > Add > Custom Domain**.

---

## Uso de la API

### 1. Acortar un enlace individual (`POST /api/links`)

Puedes enviar una ruta relativa (que se resolverá usando el dominio asociado al `project` en `PROJECT_DOMAINS`) o una URL completa con `https://`.

```bash
curl -X POST [https://s.tudominio.com/api/links](https://s.tudominio.com/api/links) \
  -H "Authorization: Bearer TU_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "app1",
    "url": "docs/reporte-anual-2026.pdf",
    "slug": "rep26"
  }'
```
*(El campo `slug` es opcional; si se omite, se genera uno aleatorio de 6 caracteres).*

**Respuesta (`201 Created`):**
```json
{
  "count": 1,
  "links": [
    {
      "slug": "rep26",
      "project": "app1",
      "shortUrl": "[https://s.tudominio.com/rep26](https://s.tudominio.com/rep26)",
      "target": "[https://app1-cdn.tudominio.com/docs/reporte-anual-2026.pdf](https://app1-cdn.tudominio.com/docs/reporte-anual-2026.pdf)"
    }
  ]
}
```

### 2. Acortar múltiples enlaces por lote (`POST /api/links`)

Envía un array de hasta 500 objetos en una sola llamada:

```bash
curl -X POST [https://s.tudominio.com/api/links](https://s.tudominio.com/api/links) \
  -H "Authorization: Bearer TU_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '[
    { "project": "app1", "url": "uploads/img-001.png" },
    { "project": "default", "url": "backups/db-dump.zip", "slug": "bk01" },
    { "url": "https:// [sitio-externo.com/articulo/12345](https://sitio-externo.com/articulo/12345)" }
  ]'
```

### 3. Redirección (`GET /:slug`)

Al acceder a `https://s.tudominio.com/rep26`, el Worker responde con un estado HTTP `301 Moved Permanently` apuntando a la URL de destino y cabeceras `Cache-Control: public, max-age=86400, s-maxage=604800`.

---

## Scripts Disponibles (`package.json`)

| Comando | Descripción |
| :--- | :--- |
| `npm run dev` | Inicia el servidor de desarrollo local con Wrangler. |
| `npm run deploy` | Despliega el Worker en la red global de Cloudflare. |
| `npm run cf-typegen` | Regenera `worker-configuration.d.ts` según `wrangler.jsonc`. |

---

## Licencia

MIT