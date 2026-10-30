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

function cuerpo(i: Item): string {
  const r = resumen(i.cuerpo, MAX_RESUMEN);
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
    return articulo(id, t, titulo, unico ? cuerpo(primero) : "", filas.join(""));
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
    detalle = cuerpo(primero);
    acciones = accionesComercial(t, primero);
  }
  return articulo(id, t, titulo, detalle, `<div class="acciones">${acciones}</div>`);
}

function articulo(id: string, t: Tarjeta, titulo: string, detalle: string, acciones: string): string {
  return `<article id="${e(id)}" class="tarjeta" data-tipo="${e(t.tipo)}">`
    + `<header><a class="titulo" href="#${e(id)}">${e(titulo)}</a><span class="edad">${e(antiguedad(t.antiguedadMs))}</span></header>`
    + (detalle ? `<div class="detalle">${detalle}</div>` : "")
    + acciones
    + `<p class="motivo" role="alert" hidden></p>`
    + `</article>`;
}

function renderGrupo(g: Grupo): string {
  return `<h3>${e(g.cliente)}</h3>` + g.tarjetas.map((t) => renderTarjeta(t, g.cliente)).join("");
}

export function renderBandeja(b: Bandeja, _ahora: Date): string {
  const secciones = FRANJAS
    .filter(([f]) => b[f].length > 0)
    .map(([f, titulo]) => `<section data-franja="${f}"><h2>${titulo}</h2>${b[f].map(renderGrupo).join("")}</section>`);
  const vacia = secciones.length === 0;

  const notas: string[] = [];
  if (vacia && b.primerosRestantes === 0 && !b.truncado) notas.push(`<p class="vacio">Nada pendiente. Bien ahí.</p>`);
  if (b.primerosRestantes > 0) notas.push(`<p class="nota">y ${b.primerosRestantes} primeros contactos más en la cola</p>`);
  if (b.truncado) notas.push(`<p class="nota">Hay más en GitHub de lo que entra acá</p>`);
  return secciones.join("") + notas.join("");
}
