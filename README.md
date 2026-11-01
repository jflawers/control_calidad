# QA Catastral - revisión asistida (primera versión)

Herramienta de apoyo para revisar un trámite antes de enviarlo a revisión SIG.
**No decide por sí sola.** Muestra verificaciones con estado OK, ERROR, REVISAR o PENDIENTE,
y pide al operador responder las preguntas que no puede resolver.

## Qué revisa esta versión
- Observaciones escritas en el anexo (cada una queda pendiente hasta que el operador la marque).
- Matrículas del plano contra `id_predio` de la edición.
- Total de niveles: pisos de vivienda + ramadas (la ramada cuenta como nivel).
- Uso de cada unidad contra el uso impreso en la página del piso correspondiente.
- Área de lote: redondeo entero contra la geometría, sin tolerancia.
- Códigos de tipo de construcción válidos.
- Balcones en la edición que el plano no rotula.
- Construcciones que salen del lote: distancia máxima (ERROR si supera 1 m); si no, pregunta sobre techo visible en la ortofoto.

## Qué NO hace todavía
- No lee planos escaneados (sin texto seleccionable). Si no hay texto, el resultado es REVISAR.
- No compara formas de los polígonos del plano con la edición.
- No compara la foto de fachada.
- No consulta la ortofoto: el operador la mira en ArcGIS Pro y responde.

## Archivos
- `index.html`, `app.js`: la aplicación. Todo corre en el navegador.
- `reglas.json`: tolerancias, códigos válidos y nombres de campos. Se ajusta sin tocar el código.
- `exportar_capas.py`: exporta desde ArcGIS Pro las capas de un CBML en shapefile, EPSG 9377, en un ZIP.

## Uso
1. En ArcGIS Pro, ejecutar `exportar_capas.py` con el CBML del trámite. Sale un ZIP.
2. Abrir `index.html` (o la dirección de GitHub Pages).
3. Cargar los planos PDF y el ZIP. Pulsar **Revisar trámite**.
4. Responder las preguntas de la tabla y pulsar **Exportar registro (JSON)**.

## Publicar en GitHub Pages
1. Crear un repositorio y subir `index.html`, `app.js`, `reglas.json` y este README.
2. En el repositorio: **Settings → Pages → Build and deployment → Deploy from a branch → main / (root)**.
3. La dirección queda como `https://<usuario>.github.io/<repositorio>/`.

**Privacidad.** Un repositorio público en GitHub Pages es visible para cualquiera. Sube solo código, nunca planos,
shapefiles ni registros de trámites reales. Para pruebas, usar datos anonimizados. Si el repositorio debe ser privado,
Pages requiere un plan de pago de GitHub; alternativamente, abrir `index.html` directamente desde el computador.

## Dependencias (desde CDN fijadas a versión)
- pdf.js 3.11.174 (lectura de PDF con texto)
- shpjs 4.0.4 (lectura de shapefiles en ZIP)
- polygon-clipping 0.15.7 (diferencias de polígonos en plano, EPSG 9377)

## Próximos pasos sugeridos
1. Probar con el trámite 202610282148 y comparar el resultado con la revisión manual.
2. Agregar la lectura de la foto de fachada (conteo de niveles) como apoyo.
3. Guardar los registros exportados para ajustar umbrales y reglas.
