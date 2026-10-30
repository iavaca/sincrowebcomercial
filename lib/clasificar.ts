import { extraerLink } from "./texto";
import type { Bandeja, Franja, Grupo, IssueItem, Item, Subtipo, Tarjeta } from "./tipos";

const LOTE_PRIMEROS_CONTACTOS = 5;
const SEPARADOR_TITULO = " · ";
const LABELS_PEDIDO_EXCLUIDOS = ["extra cotizado", "hecho", "actualizacion"];

const valorLabel = (labels: string[], prefijo: string) =>
  labels.find((l) => l.startsWith(prefijo))?.slice(prefijo.length);

function tarjeta(item: Item, ahora: Date, t: Pick<Tarjeta, "id" | "tipo" | "cliente" | "franja"> & Partial<Pick<Tarjeta, "subtipo" | "link">>): Tarjeta {
  return { ...t, antiguedadMs: ahora.getTime() - new Date(item.creado).getTime(), items: [item] };
}

function comercial(item: IssueItem, ahora: Date): Tarjeta | null {
  const i = item.titulo.indexOf(SEPARADOR_TITULO);
  if (i < 0) return null;
  const cliente = item.titulo.slice(0, i);
  const resto = item.titulo.slice(i + SEPARADOR_TITULO.length);
  const tiene = (l: string) => item.labels.includes(l);

  let subtipo: Subtipo;
  let franja: Franja;
  if (tiene("estado:respondio")) {
    subtipo = "respondio";
    franja = "hoy";
  } else if (item.labels.some((l) => l.startsWith("estado:"))) {
    return null; // enviado u otro estado: espera al prospecto
  } else if (/^primer contacto\b/i.test(resto)) {
    subtipo = "primer-contacto";
    franja = "cuando";
  } else if (/^seguimiento [12]\b/i.test(resto)) {
    subtipo = "seguimiento";
    franja = "hoy";
  } else {
    return null;
  }
  return tarjeta(item, ahora, { id: `${item.repo}#${item.numero}`, tipo: "comercial", subtipo, cliente, franja, link: extraerLink(item.cuerpo) });
}

function aviso(item: IssueItem, ahora: Date): Tarjeta {
  const cliente = valorLabel(item.labels, "cliente:") ?? "sin-cliente";
  if (item.labels.includes("nivel:rojo")) {
    return tarjeta(item, ahora, { id: `aviso:rojo:${item.repo}#${item.numero}`, tipo: "aviso", cliente, franja: "ahora" });
  }
  return tarjeta(item, ahora, { id: `aviso:${cliente}`, tipo: "aviso", cliente, franja: "cuando" });
}

function pedido(item: IssueItem, ahora: Date): Tarjeta | null {
  const cliente = valorLabel(item.labels, "cliente:");
  if (!cliente) return null;
  if (item.labels.some((l) => l.startsWith("agente:") || LABELS_PEDIDO_EXCLUIDOS.includes(l))) return null;
  return tarjeta(item, ahora, { id: `${item.repo}#${item.numero}`, tipo: "pedido", cliente, franja: item.labels.includes("urgente") ? "ahora" : "hoy" });
}

export function clasificar(item: Item, ahora: Date): Tarjeta | null {
  if (item.clase === "pr") {
    if (item.borrador) return null;
    return tarjeta(item, ahora, { id: `${item.repo}#${item.numero}`, tipo: "pr", cliente: "agentes", franja: "cuando" });
  }
  if (item.repo === "sincroweb-pedidos") return pedido(item, ahora);
  if (item.labels.includes("bandeja:comercial")) return comercial(item, ahora);
  if (item.labels.includes("bandeja:mantenimiento")) return aviso(item, ahora);
  return null;
}

// Más viejo primero; el número desempata para que el orden sea estable.
const masViejoPrimero = (a: Tarjeta, b: Tarjeta) =>
  b.antiguedadMs - a.antiguedadMs || a.items[0].numero - b.items[0].numero;

// Los avisos no rojos del mismo cliente comparten id ("aviso:<cliente>") y se fusionan en una tarjeta.
function fusionarAvisos(tarjetas: Tarjeta[]): Tarjeta[] {
  const resultado: Tarjeta[] = [];
  const avisos = new Map<string, Tarjeta>();
  for (const t of tarjetas) {
    const previa = t.tipo === "aviso" && t.franja === "cuando" ? avisos.get(t.id) : undefined;
    if (!previa) {
      resultado.push(t);
      if (t.tipo === "aviso" && t.franja === "cuando") avisos.set(t.id, t);
      continue;
    }
    previa.items.push(...t.items);
    previa.antiguedadMs = Math.max(previa.antiguedadMs, t.antiguedadMs);
  }
  for (const t of avisos.values()) t.items.sort((a, b) => new Date(a.creado).getTime() - new Date(b.creado).getTime() || a.numero - b.numero);
  return resultado;
}

function agrupar(tarjetas: Tarjeta[]): Grupo[] {
  const porCliente = new Map<string, Tarjeta[]>();
  for (const t of [...tarjetas].sort(masViejoPrimero)) {
    porCliente.set(t.cliente, [...(porCliente.get(t.cliente) ?? []), t]);
  }
  return [...porCliente].map(([cliente, ts]) => ({ cliente, tarjetas: ts })).sort((a, b) => masViejoPrimero(a.tarjetas[0], b.tarjetas[0]));
}

export function armarBandeja(items: Item[], ahora: Date, truncado: boolean): Bandeja {
  const todas = fusionarAvisos(items.map((i) => clasificar(i, ahora)).filter((t): t is Tarjeta => t !== null));

  const primeros = todas.filter((t) => t.subtipo === "primer-contacto").sort(masViejoPrimero);
  const fuera = new Set(primeros.slice(LOTE_PRIMEROS_CONTACTOS));
  const visibles = todas.filter((t) => !fuera.has(t));

  const franja = (f: Franja) => agrupar(visibles.filter((t) => t.franja === f));
  return { ahora: franja("ahora"), hoy: franja("hoy"), cuando: franja("cuando"), primerosRestantes: fuera.size, truncado };
}
