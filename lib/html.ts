import { AGENTES } from "./acciones";
import { escaparHtml, esLinkPermitido, resumen } from "./texto";
import type { Bandeja, Checks, Grupo, Item, PrItem, Tarjeta } from "./tipos";

const FRANJAS = [
  ["ahora", "Ahora"],
  ["hoy", "Hoy"],
  ["cuando", "Cuando puedas"],
] as const;

const MAX_RESUMEN = 300;
const MAX_ARCHIVOS = 20;

const e = escaparHtml;

function antiguedad(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function textoChecks(c: Checks): string {
  if (c === null) return "sin checks";
  if (c === "SUCCESS") return "verdes";
  if (c === "FAILURE" || c === "ERROR") return "en rojo";
  return "corriendo";
}

function boton(texto: string, a: Record<string, string | number>, clase = ""): string {
  const attrs = Object.entries(a).map(([k, v]) => ` data-${k}="${e(String(v))}"`).join("");
  return `<button type="button"${clase ? ` class="${clase}"` : ""}${attrs}>${e(texto)}</button>`;
}

function enlace(texto: string, url: string): string {
  if (!esLinkPermitido(url)) return "";
  return `<a class="boton" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(texto)}</a>`;
}

function textoLinkComercial(url: string): string {
  if (url.startsWith("https://wa.me")) return "Abrir WhatsApp";
  if (url.startsWith("mailto:")) return "Abrir mail";
  return "Abrir enlace";
}

const destino = (i: Item) => ({ repo: i.repo, numero: i.numero });

function accionesComercial(t: Tarjeta, i: Item): string {
  return [
    t.link ? enlace(textoLinkComercial(t.link), t.link) : "",
    boton("Enviado", { accion: "enviado", ...destino(i) }),
    t.subtipo === "respondio" ? "" : boton("Respondió", { accion: "respondio", ...destino(i) }),
  ].join("");
}

const accionesEsperando = (i: Item) => boton("Respondió", { accion: "respondio", ...destino(i) });

function accionesPr(i: PrItem): string {
  const cambios = `<form class="cambios" hidden>`
    + `<input type="text" maxlength="200" required aria-label="Qué cambios pedís (una línea)" placeholder="Qué hay que cambiar">`
    + boton("Enviar", { accion: "pedir_cambios", ...destino(i), comentario: "" }).replace("<button type=\"button\"", "<button type=\"submit\"")
    + `</form>`;
  return [
    boton("Mergear", { accion: "mergear", ...destino(i), sha: i.sha }, "peligro"),
    `<button type="button" data-abrir="cambios">Pedir cambios</button>`,
    enlace("Ver en GitHub", i.url),
    cambios,
  ].join("");
}

function accionesPedido(i: Item): string {
  const opciones = AGENTES.map((a) => `<option value="${e(a)}">${e(a)}</option>`).join("");
  return `<select aria-label="Agente">${opciones}</select>`
    + boton("Aceptar y asignar", { accion: "asignar", ...destino(i), agente: AGENTES[0] })
    + boton("Cotizar extra", { accion: "cotizar_extra", ...destino(i) })
    + boton("Cerrar", { accion: "cerrar", ...destino(i) }, "peligro");
}

function detallePr(i: PrItem): string {
  const mostrados = i.archivos.slice(0, MAX_ARCHIVOS);
  const mas = Math.max(i.archivosTotal - mostrados.length, 0);
  const lista = mostrados.map((a) => `<li>${e(a)}</li>`).join("") + (mas > 0 ? `<li>y ${mas} más</li>` : "");
  const conflicto = i.mergeable === "CONFLICTING" ? " · con conflictos" : "";
  return `<p class="checks">Checks: ${textoChecks(i.checks)}${conflicto}</p>`
    + (lista ? `<ul class="archivos">${lista}</ul>` : "");
}

// En lo comercial, la línea "Link:" ya es el botón y las citas ("> ") son el mensaje: se muestra solo el texto.
const textoComercial = (c: string) => c.replace(/^Link: .*$/gm, "").replace(/^> ?/gm, "");

function cuerpo(i: Item, comercial = false): string {
  const r = resumen(comercial ? textoComercial(i.cuerpo) : i.cuerpo, MAX_RESUMEN);
  return r ? `<p class="resumen">${e(r)}</p>` : "";
}

function renderTarjeta(t: Tarjeta, cliente: string): string {
  const agrupada = t.id.startsWith("aviso:");
  const primero = t.items[0];
  const id = agrupada ? `aviso-${cliente}` : `t=${primero.repo}-${primero.numero}`;
  const titulo = agrupada && t.items.length > 1 ? `${t.items.length} avisos de mantenimiento` : primero.titulo;

  if (t.tipo === "aviso") {
    const unico = t.items.length === 1;
    const filas = t.items.map((i) =>
      `<div class="aviso">${unico ? "" : `<p>${e(i.titulo)}</p>`}`
      + `<div class="acciones">${enlace("Ver detalle", i.url)}${boton("Resuelto", { accion: "resuelto", ...destino(i) })}</div></div>`);
    return articulo(id, t, cliente, titulo, unico ? cuerpo(primero) : "", filas.join(""));
  }
  let detalle: string;
  let acciones: string;
  if (t.tipo === "pr" && primero.clase === "pr") {
    detalle = cuerpo(primero) + detallePr(primero);
    acciones = accionesPr(primero);
  } else if (t.tipo === "pedido") {
    detalle = cuerpo(primero);
    acciones = accionesPedido(primero);
  } else {
    detalle = cuerpo(primero, true);
    acciones = t.subtipo === "esperando" ? accionesEsperando(primero) : accionesComercial(t, primero);
  }
  return articulo(id, t, cliente, titulo, detalle, `<div class="acciones">${acciones}</div>`);
}

function articulo(id: string, t: Tarjeta, cliente: string, titulo: string, detalle: string, acciones: string): string {
  return `<article id="${e(id)}" class="tarjeta" data-tipo="${e(t.tipo)}">`
    + `<header><a class="titulo" href="#${e(id)}">${e(titulo)}</a><span class="edad">${e(antiguedad(t.antiguedadMs))}</span></header>`
    + `<div class="detalle"><div class="detalle-cab"><p class="detalle-titulo">${e(titulo)}</p>`
    + `<p class="detalle-meta">${e(cliente)} · ${e(antiguedad(t.antiguedadMs))}</p></div>${detalle}</div>`
    + acciones
    + `<p class="motivo" role="alert" hidden></p>`
    + `</article>`;
}

function renderGrupo(g: Grupo): string {
  return `<h3>${e(g.cliente)}</h3>` + g.tarjetas.map((t) => renderTarjeta(t, g.cliente)).join("");
}

// Las tarjetas "esperando" van aparte, plegadas, al final de su franja.
function renderFranja(grupos: Grupo[]): string {
  const normales: Grupo[] = [];
  const esperando: Grupo[] = [];
  for (const g of grupos) {
    const [en, resto] = [g.tarjetas.filter((t) => t.subtipo === "esperando"), g.tarjetas.filter((t) => t.subtipo !== "esperando")];
    if (resto.length > 0) normales.push({ ...g, tarjetas: resto });
    if (en.length > 0) esperando.push({ ...g, tarjetas: en });
  }
  const total = esperando.reduce((n, g) => n + g.tarjetas.length, 0);
  const plegado = total > 0
    ? `<details class="esperando"><summary>Esperando respuesta (${total})</summary>${esperando.map(renderGrupo).join("")}</details>`
    : "";
  return normales.map(renderGrupo).join("") + plegado;
}

export function renderBandeja(b: Bandeja, _ahora: Date): string {
  const secciones = FRANJAS
    .filter(([f]) => b[f].length > 0)
    .map(([f, titulo]) => `<section data-franja="${f}"><h2>${titulo}</h2>${renderFranja(b[f])}</section>`);
  const vacia = secciones.length === 0;

  const notas: string[] = [];
  if (vacia && b.primerosRestantes === 0 && !b.truncado) notas.push(`<p class="vacio">Nada pendiente. Bien ahí.</p>`);
  if (b.primerosRestantes > 0) notas.push(`<p class="nota">y ${b.primerosRestantes} primeros contactos más en la cola</p>`);
  if (b.truncado) notas.push(`<p class="nota">Hay más en GitHub de lo que entra acá</p>`);
  return secciones.join("") + notas.join("");
}
