import { FalloFinanzas, guardar, leer } from "../lib/almacen-finanzas.js";
import { CATEGORIAS, CLIENTES, PERSONAS, calcularSaldo, personaDeUid, validarNuevo, type Movimiento, type Persona } from "../lib/finanzas.js";
import { COOKIE, abrir, cookieBorrar, leerCookie, leerEnv, origenValido, tokenVigente, type Sesion } from "../lib/sesion.js";

const MAX_CUERPO = 2000;

export const TEXTO: Record<string, string> = {
  sesion_vencida: "Tu sesión venció",
  no_permitido: "No tenés acceso a Finanzas",
  datos_invalidos: "Revisá los datos: falta algo o hay un valor que no corresponde",
  no_existe: "Ese movimiento ya no existe, recargá",
  conflicto: "Alguien cargó algo al mismo tiempo. Recargá y probá de nuevo.",
  github_sin_permiso: "GitHub no dejó guardar: falta permiso de escritura en sincroweb-pedidos",
  github_error: "GitHub no respondió, probá de nuevo",
  config_invalida: "El panel está mal configurado",
};

function responder(cuerpo: unknown, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(cuerpo), { status, headers });
}

const rechazar = (status: number, motivo: string, cookies: string[] = []) => responder({ ok: false, motivo, texto: TEXTO[motivo] }, status, cookies);

type Acceso = { ok: true; sesion: Sesion; persona: Persona; cookies: string[] } | { ok: false; respuesta: Response };

async function acceso(request: Request): Promise<Acceso> {
  const env = leerEnv();
  if (!env) {
    console.error("finanzas: faltan o están mal las variables de entorno");
    return { ok: false, respuesta: rechazar(500, "config_invalida") };
  }
  const ahora = Date.now();
  const valor = leerCookie(request, COOKIE);
  const sesion = valor ? await abrir(valor, env.SESSION_KEY, ahora) : null;
  if (!sesion) return { ok: false, respuesta: rechazar(401, "sesion_vencida") };
  const vigente = await tokenVigente(sesion, ahora, env);
  if (!vigente) return { ok: false, respuesta: rechazar(401, "sesion_vencida", [cookieBorrar()]) };
  const cookies = vigente.renovada ? [vigente.cookieNueva] : [];
  const persona = personaDeUid(vigente.sesion.uid);
  if (!persona) return { ok: false, respuesta: rechazar(403, "no_permitido", cookies) };
  return { ok: true, sesion: vigente.sesion, persona, cookies };
}

function fallo(error: unknown, que: string, cookies: string[]): Response {
  if (error instanceof FalloFinanzas) {
    if (error.motivo === "sesion_vencida") return rechazar(401, "sesion_vencida", [cookieBorrar()]);
    return rechazar(error.status, error.motivo, cookies);
  }
  // Nunca montos, conceptos ni cuerpos de GitHub en el log.
  const msj = error instanceof Error ? (/^(github_|respuesta_invalida|finanzas_)/.test(error.message) ? error.message.slice(0, 80) : error.name) : "desconocido";
  console.error(`finanzas: falló ${que}`, msj);
  return rechazar(502, "github_error", cookies);
}

const ordenados = (movs: Movimiento[]) => [...movs].sort((a, b) => (a.fecha === b.fecha ? b.cargadoEn.localeCompare(a.cargadoEn) : b.fecha.localeCompare(a.fecha)));

export async function GET(request: Request): Promise<Response> {
  const a = await acceso(request);
  if (!a.ok) return a.respuesta;
  try {
    const { movs } = await leer(a.sesion.token);
    const personas = Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, v.nombre]));
    return responder({ yo: a.persona, personas, clientes: CLIENTES, categorias: CATEGORIAS, movimientos: ordenados(movs), saldo: calcularSaldo(movs) }, 200, a.cookies);
  } catch (error) {
    return fallo(error, "lectura", a.cookies);
  }
}

function esJson(request: Request): boolean {
  const tipo = request.headers.get("content-type");
  return tipo !== null && tipo.split(";")[0].trim().toLowerCase() === "application/json";
}

async function leerCuerpo(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_CUERPO) return undefined;
  const texto = await request.text();
  if (new TextEncoder().encode(texto).length > MAX_CUERPO) return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
}

type Operacion = { op: "agregar"; mov: Movimiento } | { op: "borrar"; id: string };

// Aplica la operación sobre la lista actual; null = el id a borrar no está.
function aplicar(movs: Movimiento[], o: Operacion): Movimiento[] | null {
  if (o.op === "agregar") return [...movs, o.mov];
  if (!movs.some((m) => m.id === o.id)) return null;
  return movs.filter((m) => m.id !== o.id);
}

function mensaje(o: Operacion, movs: Movimiento[], persona: Persona): string {
  const m = o.op === "agregar" ? o.mov : movs.find((x) => x.id === o.id);
  return `Finanzas: ${o.op === "agregar" ? "agrega" : "borra"} ${m?.tipo ?? "movimiento"} (${PERSONAS[persona].nombre})`;
}

export async function POST(request: Request): Promise<Response> {
  const env = leerEnv();
  if (!env) return rechazar(500, "config_invalida");
  if (!origenValido(request, env.APP_ORIGIN)) return rechazar(403, "no_permitido");
  if (!esJson(request)) return rechazar(400, "datos_invalidos");
  const cuerpo = await leerCuerpo(request);
  if (typeof cuerpo !== "object" || cuerpo === null) return rechazar(400, "datos_invalidos");

  const a = await acceso(request);
  if (!a.ok) return a.respuesta;

  const c = cuerpo as Record<string, unknown>;
  let operacion: Operacion;
  if (c.op === "agregar") {
    const v = validarNuevo(c.movimiento, a.persona, new Date(), crypto.randomUUID());
    if (!v.ok) return rechazar(400, "datos_invalidos", a.cookies);
    operacion = { op: "agregar", mov: v.mov };
  } else if (c.op === "borrar" && typeof c.id === "string" && c.id.length > 0 && c.id.length <= 64) {
    operacion = { op: "borrar", id: c.id };
  } else {
    return rechazar(400, "datos_invalidos", a.cookies);
  }

  // Un reintento si alguien escribió entre la lectura y el guardado.
  for (let intento = 0; ; intento++) {
    try {
      const lectura = await leer(a.sesion.token);
      const nuevos = aplicar(lectura.movs, operacion);
      if (!nuevos) return rechazar(404, "no_existe", a.cookies);
      await guardar(a.sesion.token, nuevos, lectura, mensaje(operacion, lectura.movs, a.persona));
      return responder({ ok: true }, 200, a.cookies);
    } catch (error) {
      if (error instanceof FalloFinanzas && error.motivo === "conflicto" && intento === 0) continue;
      return fallo(error, operacion.op, a.cookies);
    }
  }
}
