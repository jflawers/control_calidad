/* QA Catastral - revisión asistida (primera versión).
   Procesa planos PDF y shapefiles en el navegador. No envía datos a ningún servidor.
   Estados: OK, ERROR, REVISAR, PENDIENTE. Las preguntas dependen del operador. */

let REGLAS = null;
let CHECKS = [];          // { id, estado, texto, detalle, pregunta?, tipo?, respuesta? }
let CONTEXTO = {};        // cbml, planos, uc, construcciones, lote

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- Utilidades geométricas (planas, en metros EPSG:9377) ----------
function areaAnillo(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
}
function areaPoligono(coords) { return coords.length ? areaAnillo(coords[0]) : 0; }
function distPuntoSegmento(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function distPuntoAnillo(p, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length - 1; i++) d = Math.min(d, distPuntoSegmento(p, ring[i], ring[i + 1]));
  return d;
}
function dentroAnillo(p, ring) {           // ray casting
  let dentro = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
function redondeoEntero(x) { return Math.floor(x + 0.5); }   // redondeo normal, 0,5 sube

// ---------- Lectura de planos ----------
async function leerPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const paginas = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const texto = content.items.map(i => i.str).join(" ").replace(/\s+/g, " ").trim();
    paginas.push({ archivo: file.name, n, texto });
  }
  return paginas;
}

const PISO_PALABRAS = { PRIMER: 1, SEGUNDO: 2, TERCER: 3, CUARTO: 4, QUINTO: 5 };

function parsearPagina(p) {
  // Solo el cuerpo del plano; las observaciones se leen aparte para no confundir "piso 3" de un texto libre.
  const t = p.texto.split(/OBSERVACIONES GENERALES/i)[0];
  const textoCompleto = p.texto;
  const r = { archivo: p.archivo, pagina: p.n, pisos: [], ramada: false, uso: null, mi: null, cbml: null,
              planta_general: false, label_total: null, observaciones: [], balcon: /BALC/i.test(t), texto: t };
  const mi = t.match(/MATR[IÍ]CULA:?\s*(\d{5,})|\bMI:?\s*(\d{5,})/i);
  if (mi) r.mi = mi[1] || mi[2];
  const cb = t.match(/CBML:?\s*(\d{9,11})/i);
  if (cb) r.cbml = cb[1];
  const uso = t.match(/USO\s*\(?\s*(\d{1,3})\s*\)?/i);
  if (uso) r.uso = uso[1];
  const pisoNum = t.match(/PISO\s+(\d+)(?:\s*Y\s*(\d+))?/);
  if (pisoNum) { r.pisos.push(+pisoNum[1]); if (pisoNum[2]) r.pisos.push(+pisoNum[2]); }
  else {
    const pal = t.match(/\b(PRIMER|SEGUNDO|TERCER|CUARTO|QUINTO)\s+PISO\b/i);
    if (pal) r.pisos.push(PISO_PALABRAS[pal[1].toUpperCase()]);
  }
  r.ramada = /RAMADA/i.test(t);
  r.planta_general = /PLANTA GENERAL/i.test(t);
  const lt = t.match(/(\d+)\s*P\s*\+\s*(\d+)\s*R/i);
  if (lt) r.label_total = { pisos: +lt[1], ramadas: +lt[2] };
  const obs = textoCompleto.match(/OBSERVACIONES GENERALES:\s*(.*?)(?:Asignaci[oó]n|Firma Prediador|Impreso por|$)/i);
  if (obs && obs[1].trim().length > 5) {
    r.observaciones = obs[1].split(/(?<=\.)\s+/).map(s => s.trim()).filter(s => s.length > 5);
  }
  return r;
}

// ---------- Lectura de shapefiles ----------
async function leerShapes(file) {
  const buf = await file.arrayBuffer();
  const res = await shp(buf);
  const capas = {};
  const lista = Array.isArray(res) ? res : [Object.assign({ fileName: "uconstruccion_ladm" }, res)];
  for (const fc of lista) {
    const nombre = String(fc.fileName || "").toLowerCase().replace(/\.shp$/, "");
    capas[nombre] = fc.features || [];
  }
  return capas;
}
// Devuelve la geometría como lista de polígonos (cada uno, lista de anillos), sea Polygon o MultiPolygon.
function poligonos(geom) {
  if (!geom) return [];
  return geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
}
function anillosExteriores(geom) { return poligonos(geom).map(p => p[0]); }

const prop = (f, campo) => (f.properties || {})[campo];

// ---------- Revisión ----------
function añadir(id, estado, texto, detalle = "", extra = {}) {
  CHECKS.push(Object.assign({ id, estado, texto, detalle, respuesta: null }, extra));
}

async function revisar() {
  CHECKS = []; CONTEXTO = {};
  const archivosPlanos = [...$("fPlanos").files];
  const archivoShp = $("fShp").files[0];
  if (!archivosPlanos.length || !archivoShp) { alert("Cargue los planos y el ZIP de shapefiles."); return; }
  $("btnRevisar").disabled = true; $("resumen").textContent = "Leyendo archivos…";

  // Planos
  let paginas = [];
  for (const f of archivosPlanos) paginas = paginas.concat(await leerPdf(f));
  const planos = paginas.map(parsearPagina);

  // Geometría
  const capas = await leerShapes(archivoShp);
  const cbmlPlano = (planos.find(p => p.cbml) || {}).cbml || null;
  const sf = REGLAS.campos_shapefile;
  const cbml = cbmlPlano;
  const lotes = (capas.lote || []).filter(f => String(prop(f, "cbml")) === String(cbml));
  const constr = (capas.construccion || []).filter(f => String(prop(f, "cbml")) === String(cbml));
  const ucs = (capas.uconstruccion_ladm || []).filter(f => String(prop(f, "cbml")) === String(cbml));
  CONTEXTO = { cbml, planos, lote: lotes[0] || null, construcciones: constr, uc: ucs };

  // 1. CBML
  if (!cbml) añadir("cbml", "REVISAR", "No se encontró CBML en los planos", "Revise que el anexo tenga el CBML impreso");
  else if (!lotes.length) añadir("cbml", "ERROR", "El CBML del plano no existe en la capa lote", `CBML ${cbml}`);
  else añadir("cbml", "OK", "CBML del plano presente en la capa lote", `CBML ${cbml}`);

  // 2. Observaciones del anexo
  const obsTodas = planos.flatMap(p => p.observaciones.map(o => ({ pagina: p.pagina, o })));
  const vistas = new Set();
  obsTodas.forEach((x, i) => {
    if (vistas.has(x.o)) return; vistas.add(x.o);
    añadir("obs-" + i, "PENDIENTE", "Observación del anexo: " + x.o, `Página ${x.pagina} del anexo`,
      { pregunta: "¿Está atendida en la edición?", tipo: "atendida" });
  });
  if (!obsTodas.length) añadir("obs", "OK", "El anexo no tiene observaciones generales", "");

  // 3. Matrículas
  const miPlano = new Set(planos.map(p => p.mi).filter(Boolean));
  const miEdicion = new Set(ucs.map(f => String(prop(f, "id_predio"))));
  const sinEnPlano = [...miEdicion].filter(m => !miPlano.has(m));
  const sinEnEdicion = [...miPlano].filter(m => !miEdicion.has(m));
  if (!miPlano.size) añadir("mi", "REVISAR", "No se encontró matrícula en los planos", "");
  else if (!sinEnPlano.length && !sinEnEdicion.length) añadir("mi", "OK", "Matrículas coinciden", [...miPlano].join(", "));
  else añadir("mi", "ERROR", "Matrículas no coinciden", `Solo en edición: ${sinEnPlano.join(", ") || "-"}; solo en plano: ${sinEnEdicion.join(", ") || "-"}`);

  // 4. Niveles y total de pisos
  const pisosPlano = new Set(), ramadasPlano = new Set();
  planos.filter(p => !p.planta_general).forEach(p => p.pisos.forEach(n => (p.ramada ? ramadasPlano : pisosPlano).add(n)));
  const labelGeneral = planos.find(p => p.label_total);
  const totalPlano = pisosPlano.size + ramadasPlano.size;
  const totalUC = [...new Set(ucs.map(f => +prop(f, sf.uconstruccion.total_pisos)))];
  if (!ucs.length) añadir("pisos", "REVISAR", "No hay unidades de construcción para el CBML", "");
  else if (totalUC.length === 1 && totalUC[0] === totalPlano)
    añadir("pisos", "OK", "Total de niveles coincide (ramada cuenta como nivel)", `Plano: ${pisosPlano.size} pisos + ${ramadasPlano.size} ramada(s) = ${totalPlano}; edición: ${totalUC.join("/")}`);
  else añadir("pisos", "ERROR", "Total de niveles no coincide", `Plano: ${pisosPlano.size} pisos + ${ramadasPlano.size} ramada(s) = ${totalPlano}; edición: ${totalUC.join("/")}`);
  if (labelGeneral && labelGeneral.label_total) {
    const esperado = labelGeneral.label_total.pisos + labelGeneral.label_total.ramadas;
    if (esperado !== totalPlano) añadir("label", "REVISAR", "La planta general indica otro número de niveles", `Rótulo: ${labelGeneral.label_total.pisos}P+${labelGeneral.label_total.ramadas}R; pisos por página: ${totalPlano}`);
  }

  // 5. Uso por unidad, contra la página del piso correspondiente
  for (const f of ucs) {
    const planta = +prop(f, sf.uconstruccion.planta);
    const uso = String(prop(f, sf.uconstruccion.uso));
    const esRamada = uso === REGLAS.uso_ramada;
    const pag = planos.find(p => !p.planta_general && (esRamada ? p.ramada : (!p.ramada && p.pisos.includes(planta))));
    const id = "uso-" + prop(f, sf.uconstruccion.identificador);
    if (!pag || !pag.uso) añadir(id, "REVISAR", `Sin uso legible en el plano para ${prop(f, sf.uconstruccion.identificador)}`, `Piso ${planta}`);
    else if (String(+pag.uso) === String(+uso)) añadir(id, "OK", `Uso coincide en ${prop(f, sf.uconstruccion.identificador)}`, `Plano ${pag.uso} = edición ${uso}`);
    else añadir(id, "ERROR", `Uso no coincide en ${prop(f, sf.uconstruccion.identificador)}`, `Plano ${pag.uso}, edición ${uso}`);
  }

  // 6. Lote: área redondeada al entero, sin tolerancia
  if (lotes.length) {
    const L = lotes[0];
    const areaGeom = prop(L, "shape_Area") ?? poligonos(L.geometry).reduce((s, p) => s + areaPoligono(p), 0);
    const areaCampo = prop(L, sf.lote.area_lote);
    if (redondeoEntero(areaGeom) === Math.round(areaCampo))
      añadir("area-lote", "OK", "Área de lote coincide con la geometría (redondeo entero)", `Geometría ${areaGeom.toFixed(2)} m² → ${redondeoEntero(areaGeom)}; campo ${areaCampo}`);
    else añadir("area-lote", "ERROR", "Área de lote no coincide con la geometría", `Geometría ${areaGeom.toFixed(2)} m² → ${redondeoEntero(areaGeom)}; campo ${areaCampo}`);
  }

  // 7. Códigos de tipo de construcción válidos
  const validos = new Set(REGLAS.codigos_tipo_construccion_validos);
  const invalidos = constr.filter(f => !validos.has(String(prop(f, sf.construccion.tipo))));
  if (invalidos.length) añadir("dominio", "ERROR", "Código de tipo de construcción no válido", invalidos.map(f => prop(f, sf.construccion.tipo)).join(", "));
  else añadir("dominio", "OK", "Códigos de tipo de construcción válidos", [...new Set(constr.map(f => prop(f, sf.construccion.tipo)))].join(", "));

  // 8. Balcones rotulados
  const hayBalcon = constr.some(f => ["B", "FL"].includes(String(prop(f, sf.construccion.tipo))));
  const rotuloBalcon = planos.some(p => p.balcon);
  if (hayBalcon && !rotuloBalcon) añadir("balcon-rotulo", "REVISAR", "Hay balcón en la edición y el plano no lo rotula", "¿Debe aparecer en el anexo?", { pregunta: "¿El balcón debe figurar en el anexo?", tipo: "rotulo" });

  // 9. Construcciones que salen del lote (paramento inferido en la ortofoto)
  if (lotes.length) {
    const loteAnillos = anillosExteriores(lotes[0].geometry);
    const lotePoly = poligonos(lotes[0].geometry);
    for (const f of constr) {
      const tipo = String(prop(f, sf.construccion.tipo));
      if (tipo === "AL") continue;
      const id = "fuera-" + (prop(f, sf.construccion.id) || tipo) + "-" + f.id;
      let fuera = [];
      try {
        fuera = polygonClipping.difference(poligonos(f.geometry), lotePoly);
      } catch (e) { fuera = []; }
      const areaFuera = fuera.reduce((s, poly) => s + areaPoligono(poly), 0);
      if (areaFuera < REGLAS.tolerancias.area_fuera_lote_m2_minima) continue;
      const verts = anillosExteriores(f.geometry).flat().filter(v => !loteAnillos.some(r => dentroAnillo(v, r)));
      const maxDist = verts.reduce((m, v) => Math.max(m, ...loteAnillos.map(r => distPuntoAnillo(v, r))), 0);
      const det = `Tipo ${tipo}; área fuera del lote ${areaFuera.toFixed(2)} m²; distancia máxima ${maxDist.toFixed(2)} m`;
      if (maxDist > REGLAS.tolerancias.fuera_lote_m)
        añadir(id, "ERROR", "Construcción sobresale más de 1 m del lote", det);
      else
        añadir(id, "REVISAR", "Construcción sobresale del lote: verificar en la ortofoto 2024", det,
          { pregunta: "¿El recorte muestra techo bajo esta construcción (no acera, calzada ni antejardín)?", tipo: "techo" });
    }
  }

  renderizar();
}

// ---------- Interfaz ----------
const ETIQUETAS = {
  atendida: [["Sí, atendida", "OK"], ["No", "ERROR"]],
  rotulo:   [["Sí, debe figurar", "OK"], ["No debe figurar", "ERROR"], ["No sé", "REVISAR"]],
  techo:    [["Sí, sobre techo", "OK"], ["No, fuera de techo", "ERROR"], ["No sé", "REVISAR"]],
};

function responder(id, idx) {
  const c = CHECKS.find(x => x.id === id);
  const op = ETIQUETAS[c.tipo][idx];
  c.respuesta = op[0];
  c.estado = op[1];
  renderizar();
}

function renderizar() {
  $("btnRevisar").disabled = false;
  $("btnExportar").disabled = !CHECKS.length;
  const cuenta = { OK: 0, ERROR: 0, REVISAR: 0, PENDIENTE: 0 };
  CHECKS.forEach(c => cuenta[c.estado]++);
  $("resumen").innerHTML = `CBML ${esc(CONTEXTO.cbml || "-")} · <span class="OK">OK ${cuenta.OK}</span>
     <span class="ERROR">ERROR ${cuenta.ERROR}</span><span class="REVISAR">REVISAR ${cuenta.REVISAR}</span>
     <span class="PENDIENTE">PENDIENTE ${cuenta.PENDIENTE}</span>`;
  const tb = $("tabla").querySelector("tbody");
  tb.innerHTML = CHECKS.map(c => {
    let acciones = "";
    if (c.pregunta) {
      const opciones = ETIQUETAS[c.tipo];
      acciones = `<div class="small">${esc(c.pregunta)}</div>` +
        opciones.map((o, i) => `<button onclick="responder('${esc(c.id)}', ${i})">${esc(o[0])}</button>`).join("");
    }
    const resp = c.respuesta ? `<div class="small">Respuesta: ${esc(c.respuesta)}</div>` : "";
    return `<tr><td class="estado ${c.estado}">${c.estado}</td><td>${esc(c.texto)}</td>
            <td class="small">${esc(c.detalle)}</td><td>${acciones}${resp}</td></tr>`;
  }).join("");
}

function exportar() {
  const reporte = {
    version_reglas: REGLAS.version,
    fecha: new Date().toISOString(),
    cbml: CONTEXTO.cbml,
    resultados: CHECKS.map(c => ({ id: c.id, estado: c.estado, verificacion: c.texto, detalle: c.detalle, respuesta_operador: c.respuesta }))
  };
  const blob = new Blob([JSON.stringify(reporte, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `revision_${CONTEXTO.cbml || "tramite"}.json`;
  a.click();
}

window.responder = responder;
window.addEventListener("DOMContentLoaded", async () => {
  REGLAS = await (await fetch("reglas.json")).json();
  $("btnRevisar").addEventListener("click", () => revisar().catch(e => { alert("Error: " + e.message); $("btnRevisar").disabled = false; }));
  $("btnExportar").addEventListener("click", exportar);
});
