# web-metrics

Herramienta CLI para medir Web Vitals y tiempos de red en un conjunto de URLs configuradas, con salida a consola y HTML. Diseñada para aproximar los resultados de Lighthouse en entorno controlado y repetible.

## Instalación

```bash
npm install
npx playwright install chromium
```

## Uso

```bash
# Con el fichero de configuración por defecto (config.json)
npm start

# Con un fichero específico
node src/index.js mi-config.json
```

## Configuración

Copia `config.example.json` como `config.json` y edítalo:

```json
{
  "runs": 3,
  "devices": ["desktop", "mobile"],
  "urls": [
    {
      "name": "Home",
      "url": "https://example.com",
      "waitUntil": "networkidle"
    }
  ],
  "requests": {
    "patterns": ["api/", "analytics", "\\.js$", "\\.css$"]
  },
  "output": {
    "html": "results.html",
    "json": "results.json"
  },
  "browser": {
    "headless": true
  }
}
```

### Parámetros

| Campo | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `runs` | number | `1` | Número de repeticiones por URL y dispositivo |
| `devices` | string[] | `["desktop","mobile"]` | Dispositivos a medir |
| `urls[].url` | string | — | URL a medir |
| `urls[].name` | string | — | Nombre en el informe |
| `urls[].waitUntil` | string | `"networkidle"` | Condición de espera de Playwright |
| `urls[].timeout` | number | `30000` | Timeout de navegación (ms) |
| `requests.patterns` | string[] | `[]` | Expresiones regulares para filtrar requests a rastrear |
| `output.html` | string | `"results.html"` | Ruta del informe HTML |
| `output.json` | string | — | Ruta de salida JSON (opcional) |
| `browser.headless` | boolean | `true` | Modo sin cabeza |

## Métricas recogidas

### Web Vitals

| Métrica | Descripción | Bueno | Malo |
|---|---|---|---|
| **LCP** | Largest Contentful Paint | ≤ 2500ms | > 4000ms |
| **FCP** | First Contentful Paint | ≤ 1800ms | > 3000ms |
| **CLS** | Cumulative Layout Shift | ≤ 0.1 | > 0.25 |
| **TBT** | Total Blocking Time | ≤ 200ms | > 600ms |
| **TTFB** | Time to First Byte | ≤ 800ms | > 1800ms |
| **SI** | Speed Index | ≤ 3400ms | > 5800ms |
| **DCL** | DOMContentLoaded | — | — |
| **Load** | Evento `load` | — | — |

### Puntuación Lighthouse (0–100)

Se calcula replicando el algoritmo de Lighthouse: cada métrica se convierte a un score 0–1 mediante una distribución log-normal ajustada a dos puntos de control (p10 y mediana extraídos del Chrome UX Report), y se aplica una media ponderada.

**Pesos (Lighthouse 10+):**

| Métrica | Peso |
|---|---|
| TBT | 30% |
| LCP | 25% |
| CLS | 25% |
| FCP | 10% |
| SI  | 10% |

Si Speed Index no se puede calcular (speedline falla por pocas capturas), los pesos restantes se renormalizan automáticamente.

### Requests rastreadas

Para cada request que coincida con los patrones configurados se registra: URL, método HTTP, status de respuesta, offset de inicio relativo a la navegación, duración y tamaño (`Content-Length`).

## Condiciones de medición (equivalente a Lighthouse)

La herramienta aplica throttling real vía Chrome DevTools Protocol (CDP), igual que Lighthouse en modo "applied throttling":

| | Desktop | Mobile |
|---|---|---|
| Viewport | 1350×940 | iPhone 15 (390×844) |
| User Agent | Chrome desktop | iPhone 15 Safari |
| CPU | Sin throttling | 4x slowdown |
| Red | Sin throttling | Slow 4G: 1.6 Mbps↓ / 750 Kbps↑ / 150ms RTT |

Cada run usa un contexto de navegador independiente (sin caché compartida), equivalente al comportamiento de Lighthouse en primera visita.

## Resultados

Por cada combinación URL × dispositivo se realizan `runs` repeticiones y se calculan **media, desviación estándar, mínimo y máximo** para cada métrica.

**Salida consola:**
```
[Home] — mobile — 3 run(s)
  Run 1/3 ... done
  Run 2/3 ... done
  Run 3/3 ... done

Performance Score: 62  Needs improvement  (min 58 / max 67)

Web Vitals (stats over all runs):
  METRIC       MEAN    ±STDDEV       MIN       MAX  RATING
  LCP        3240ms     ±180ms    3050ms    3420ms  Needs improvement
  FCP        1650ms      ±90ms    1560ms    1740ms  Good
  CLS         0.050     ±0.008     0.040     0.060  Good
  TBT         320ms      ±40ms     280ms     360ms  Needs improvement
  TTFB        410ms      ±30ms     380ms     445ms  Good
  SI         2980ms     ±200ms    2780ms    3180ms  Good
  DCL        1820ms      ±60ms    1760ms    1880ms  -
  LOAD       3600ms     ±150ms    3450ms    3750ms  -
```

El informe **HTML** incluye un badge circular de puntuación (verde/naranja/rojo) por sección, tabla de estadísticas de vitals y detalle de requests por run.

## Arquitectura

```
src/
  index.js      Punto de entrada CLI. Lee el config JSON y llama a run().
  runner.js     Bucle principal: URL × dispositivo × N runs. Gestiona contextos
                de Playwright y calcula estadísticas agregadas (computeStats).
  collector.js  Mide una página. Aplica throttling CDP, inicia tracing, registra
                PerformanceObservers via addInitScript, captura requests y calcula
                vitals + Speed Index con speedline-core.
  reporter.js   Genera la salida por consola (ANSI) y el informe HTML. Sin
                dependencias externas: el HTML es un fichero autocontenido.
  score.js      Replica el algoritmo de puntuación de Lighthouse. Implementa la
                CDF log-normal y la media ponderada de métricas.
```

### Decisiones técnicas

**PerformanceObserver via `addInitScript`**
LCP, FCP, CLS y TBT se recogen inyectando observers antes de la navegación. Esto garantiza que ningún evento se pierde por el timing de la inyección.

**Speed Index via Chrome trace**
Se activa el tracing CDP (`devtools.timeline` + `disabled-by-default-devtools.screenshot`) antes de navegar. Los frames de pantalla se pasan a `speedline-core` (la misma librería que usa Lighthouse) para obtener el Speed Index real basado en progreso visual.

**Throttling via CDP, no simulado**
A diferencia del modo por defecto de Lighthouse CLI (que simula el throttling), esta herramienta aplica throttling real vía `Network.emulateNetworkConditions` y `Emulation.setCPUThrottlingRate`. Los resultados son por tanto más sensibles al hardware del equipo donde se ejecuta.

**Contexto nuevo por run**
Cada run abre un `BrowserContext` nuevo, lo que garantiza caché, cookies y estado vacíos — comportamiento equivalente a una primera visita.

**Desktop sin throttling**
Lighthouse no aplica throttling en desktop (ni CPU ni red), por lo que tampoco lo hacemos. El viewport de 1350×940 sí se aplica para replicar la configuración exacta.
