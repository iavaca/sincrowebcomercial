// Finanzas de los dos socios: tipos, validación y cálculo del saldo 50/50. Todo en pesos enteros.

export type Persona = "ivan" | "isabella";
export type TipoMovimiento = "gasto" | "cobro" | "transferencia";

export const PERSONAS: Record<Persona, { uid: number; nombre: string }> = {
  ivan: { uid: 100360837, nombre: "Iván" },
  isabella: { uid: 75735426, nombre: "Isabella" },
};
const CLAVES_PERSONA = Object.keys(PERSONAS) as Persona[];

export function personaDeUid(uid: number): Persona | null {
  return CLAVES_PERSONA.find((p) => PERSONAS[p].uid === uid) ?? null;
}

// Copia de sincroweb-pedidos/lib/clientes.ts; al sumar un cliente allá, sumarlo acá.
export const CLIENTES: readonly { slug: string; nombre: string }[] = [
  { slug: "rucula", nombre: "Rucula Digital Academy" },
  { slug: "cecal", nombre: "CECAL" },
  { slug: "freedom-capital", nombre: "Freedom Capital" },
  { slug: "global-wifi", nombre: "Global Wifi" },
  { slug: "icat", nombre: "ICAT Argentina" },
  { slug: "iser", nombre: "Iser" },
  { slug: "multias", nombre: "Multias" },
  { slug: "mutual", nombre: "Mutual BPN" },
  { slug: "patagonia-services", nombre: "Patagonia Services" },
  { slug: "tapiceria-coeti", nombre: "Tapiceria Coeti" },
  { slug: "numa-boa-hostel", nombre: "Numa Boa Hostel" },
  { slug: "alfajores-pegote", nombre: "Alfajores Pegote" },
  { slug: "andesitica", nombre: "Andesitica" },
  { slug: "otro", nombre: "Otro" },
];

export const CATEGORIAS: readonly string[] = ["Hosting y servidores", "Dominios", "Software y suscripciones", "Publicidad", "Otros"];

export type Movimiento = {
  id: string;
  tipo: TipoMovimiento;
  fecha: string; // YYYY-MM-DD
  monto: number; // pesos enteros
  persona: Persona; // quien pagó / a quién le entró / quien transfirió
  para?: Persona; // solo transferencia
  cliente?: string; // slug; obligatorio en cobro, opcional en gasto
  clienteNombre?: string; // solo con cliente "otro"
  categoria?: string; // solo gasto
  concepto: string;
  cargadoPor: Persona;
  cargadoEn: string; // ISO
};

export const MONTO_MAX = 1_000_000_000;
const MAX_CONCEPTO = 200;
const MAX_NOMBRE = 80;

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const esPersona = (v: unknown): v is Persona => typeof v === "string" && (CLAVES_PERSONA as string[]).includes(v);
const esMonto = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MONTO_MAX;
const esCliente = (v: unknown): v is string => typeof v === "string" && CLIENTES.some((c) => c.slug === v);

function esFecha(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const textoCorto = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length <= max ? t : null;
};

const NO = { ok: false } as const;

// Arma un movimiento nuevo a partir de lo que mandó el navegador; id y autoría los pone el servidor.
// `listas = false` (movimientos ya guardados): no exige que cliente y categoría sigan en las listas de hoy,
// para que renombrar o quitar un cliente no deje Finanzas sin poder leer el archivo.
export function validarNuevo(body: unknown, cargadoPor: Persona, ahora: Date, id: string, listas = true): { ok: true; mov: Movimiento } | { ok: false } {
  if (!esObjeto(body)) return NO;
  const { tipo, fecha, monto, persona } = body;
  if ((tipo !== "gasto" && tipo !== "cobro" && tipo !== "transferencia") || !esFecha(fecha) || !esMonto(monto) || !esPersona(persona)) return NO;
  const concepto = textoCorto(body.concepto, MAX_CONCEPTO);
  if (concepto === null) return NO;
  const mov: Movimiento = { id, tipo, fecha, monto, persona, concepto, cargadoPor, cargadoEn: ahora.toISOString() };

  if (tipo === "transferencia") {
    if (!esPersona(body.para) || body.para === persona) return NO;
    mov.para = body.para;
  } else {
    const conCliente = body.cliente !== undefined && body.cliente !== null && body.cliente !== "";
    if (tipo === "cobro" && !conCliente) return NO;
    if (conCliente) {
      if (listas ? !esCliente(body.cliente) : typeof body.cliente !== "string" || body.cliente.length > MAX_NOMBRE) return NO;
      mov.cliente = body.cliente as string;
      if (body.cliente === "otro") {
        const nombre = textoCorto(body.clienteNombre, MAX_NOMBRE);
        if (!nombre) return NO;
        mov.clienteNombre = nombre;
      }
    }
    if (tipo === "gasto") {
      if (typeof body.categoria !== "string" || (listas && !CATEGORIAS.includes(body.categoria)) || body.categoria.length > MAX_NOMBRE || concepto === "") return NO;
      mov.categoria = body.categoria;
    }
  }
  return { ok: true, mov: ordenar(mov) };
}

// Orden de claves estable para que el JSON guardado sea legible y los diffs chicos.
function ordenar(m: Movimiento): Movimiento {
  const { id, tipo, fecha, monto, persona, para, cliente, clienteNombre, categoria, concepto, cargadoPor, cargadoEn } = m;
  return { id, tipo, fecha, monto, persona, ...(para ? { para } : {}), ...(cliente ? { cliente } : {}), ...(clienteNombre ? { clienteNombre } : {}), ...(categoria ? { categoria } : {}), concepto, cargadoPor, cargadoEn };
}

function esMovimientoGuardado(v: unknown): v is Movimiento {
  if (!esObjeto(v) || typeof v.id !== "string" || v.id === "" || typeof v.cargadoEn !== "string" || !esPersona(v.cargadoPor)) return false;
  const r = validarNuevo(v, v.cargadoPor, new Date(), v.id, false);
  return r.ok;
}

export type Archivo = { version: 1; movimientos: Movimiento[] };

// Lanza si el archivo no es exactamente lo que escribe el panel: mejor no mostrar nada que calcular con basura.
export function parsearArchivo(texto: string): Movimiento[] {
  const d: unknown = JSON.parse(texto);
  if (!esObjeto(d) || d.version !== 1 || !Array.isArray(d.movimientos)) throw new Error("finanzas_archivo_invalido");
  if (!d.movimientos.every(esMovimientoGuardado)) throw new Error("finanzas_movimiento_invalido");
  return d.movimientos as Movimiento[];
}

export function serializar(movs: Movimiento[]): string {
  const archivo: Archivo = { version: 1, movimientos: movs };
  return JSON.stringify(archivo, null, 2) + "\n";
}

export type Saldo = {
  cobros: number;
  gastos: number;
  ganancia: number;
  mitad: number;
  neto: Record<Persona, number>;
  transferir: { de: Persona; para: Persona; monto: number } | null;
};

// neto = lo que tiene cada uno en mano por Sincroweb: cobrado − gastado − transferido + recibido.
// Si los dos tienen lo mismo (ganancia/2 cada uno), no hay nada que transferir.
export function calcularSaldo(movs: readonly Movimiento[]): Saldo {
  const neto: Record<Persona, number> = { ivan: 0, isabella: 0 };
  let cobros = 0;
  let gastos = 0;
  for (const m of movs) {
    if (m.tipo === "cobro") {
      cobros += m.monto;
      neto[m.persona] += m.monto;
    } else if (m.tipo === "gasto") {
      gastos += m.monto;
      neto[m.persona] -= m.monto;
    } else if (m.para) {
      neto[m.persona] -= m.monto;
      neto[m.para] += m.monto;
    }
  }
  const ganancia = cobros - gastos;
  const mitad = ganancia / 2;
  const dif = Math.round(neto.ivan - mitad);
  const transferir = dif > 0 ? { de: "ivan" as const, para: "isabella" as const, monto: dif } : dif < 0 ? { de: "isabella" as const, para: "ivan" as const, monto: -dif } : null;
  return { cobros, gastos, ganancia, mitad, neto, transferir };
}
