import { accionPermitida, pasosDeAccion, validarAccion, type Accion } from "../lib/acciones";
import { consultarGraphQL, llamarGitHub, mapearChecks } from "../lib/github";
import { puedeMergear, TEXTO_MOTIVO } from "../lib/merge";
import { COOKIE, abrir, cookieBorrar, leerCookie, leerEnv, origenValido, tokenVigente } from "../lib/sesion";
import type { Item, PrItem } from "../lib/tipos";

type MotivoRespuesta = keyof typeof TEXTO_MOTIVO;

const MAX_CUERPO = 2000;
const DUENO = "iavaca";
const FECHA_BA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

const CONSULTA_PR = `query PR($numero: Int!) {
  repository(owner: "${DUENO}", name: "claude-agents") { pullRequest(number: $numero) {
    number state isDraft headRefOid mergeable
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }
}`;

// Corta el flujo con una respuesta concreta; cualquier otro error termina en 502.
class Rechazo extends Error {
  constructor(readonly status: number, readonly motivo: MotivoRespuesta) {
    super(motivo);
  }
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function invalida(que: string): never {
  throw new Error(`respuesta_invalida: ${que}`);
}

function responder(cuerpo: unknown, status: number, cookies: string[]): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(cuerpo), { status, headers });
}

const rechazar = (status: number, motivo: MotivoRespuesta, cookies: string[] = []) =>
  responder({ ok: false, motivo, texto: TEXTO_MOTIVO[motivo] }, status, cookies);

// 401 = token revocado: sesión vencida. 403 = permiso de la App o rate limit: la sesión sigue siendo válida.
function rechazoPorStatus(status: number): Rechazo | null {
  if (status === 401) return new Rechazo(401, "sesion_vencida");
  if (status === 403) return new Rechazo(502, "github_sin_permiso");
  return null;
}

async function pedirGitHub(token: string, metodo: string, ruta: string, cuerpo?: unknown): Promise<Response> {
  const res = await llamarGitHub(token, metodo, ruta, cuerpo);
  const rechazo = rechazoPorStatus(res.status);
  if (rechazo) throw rechazo;
  return res;
}

async function leerJson(res: Response, que: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`github_http_${res.status}: ${que}`);
  const cuerpo: unknown = await res.json();
  return esObjeto(cuerpo) ? cuerpo : invalida(que);
}

// El endpoint de issues de REST también devuelve PRs (con `pull_request`): de ahí sale la clase.
async function releerItem(token: string, accion: Accion): Promise<{ clase: Item["clase"]; labels: string[]; abierto: boolean }> {
  const d = await leerJson(await pedirGitHub(token, "GET", `/repos/${DUENO}/${accion.repo}/issues/${accion.numero}`), "issue");
  if (d.number !== accion.numero) invalida("issue.number");
  if (!Array.isArray(d.labels)) invalida("issue.labels");
  const labels = d.labels.map((l) => (esObjeto(l) && typeof l.name === "string" ? l.name : invalida("issue.label")));
  const clase = d.pull_request === undefined ? "issue" : esObjeto(d.pull_request) ? "pr" : invalida("issue.pull_request");
  return { clase, labels, abierto: d.state === "open" };
}

async function releerPr(token: string, numero: number): Promise<Pick<PrItem, "sha" | "mergeable" | "checks" | "borrador"> & { abierto: boolean }> {
  let data: unknown;
  try {
    data = await consultarGraphQL(token, CONSULTA_PR, { numero });
  } catch (error) {
    const status = error instanceof Error ? /^github_http_(\d{3})$/.exec(error.message)?.[1] : undefined;
    throw (status && rechazoPorStatus(Number(status))) || error;
  }
  const pr = esObjeto(data) && esObjeto(data.repository) && esObjeto(data.repository.pullRequest) ? data.repository.pullRequest : invalida("pullRequest");
  if (pr.number !== numero) invalida("pullRequest.number");
  if (typeof pr.headRefOid !== "string") invalida("headRefOid");
  const nodos = esObjeto(pr.commits) && Array.isArray(pr.commits.nodes) ? pr.commits.nodes : invalida("commits");
  // Un PR siempre tiene commits: sin el último no hay cómo saber los checks, y null se leería como "sin checks".
  const commit = esObjeto(nodos[0]) && esObjeto(nodos[0].commit) ? nodos[0].commit : invalida("commit");
  return {
    abierto: pr.state === "OPEN",
    sha: pr.headRefOid,
    mergeable: pr.mergeable === "MERGEABLE" || pr.mergeable === "CONFLICTING" ? pr.mergeable : "UNKNOWN",
    borrador: pr.isDraft !== false,
    checks: mapearChecks(commit.statusCheckRollup),
  };
}

async function mergear(token: string, accion: Extract<Accion, { tipo: "mergear" }>): Promise<void> {
  const pr = await releerPr(token, accion.numero);
  if (!pr.abierto) throw new Rechazo(409, "pr_cambio");
  const regla = puedeMergear(pr, accion.sha);
  if (!regla.ok) throw new Rechazo(409, regla.motivo);
  // Con `sha`, GitHub rechaza (409) si la cabeza cambió entre la relectura y el merge.
  const res = await pedirGitHub(token, "PUT", `/repos/${DUENO}/claude-agents/pulls/${accion.numero}/merge`, { sha: accion.sha, merge_method: "merge" });
  if (res.status === 409) throw new Rechazo(409, "pr_cambio");
  if (res.status === 405) throw new Rechazo(409, "no_mergeable");
  const d = await leerJson(res, "merge");
  if (d.merged !== true) invalida("merge.merged");
}

async function ejecutarPasos(token: string, accion: Exclude<Accion, { tipo: "mergear" }>, ahora: number): Promise<void> {
  for (const paso of pasosDeAccion(accion, FECHA_BA.format(new Date(ahora)))) {
    const res = await pedirGitHub(token, paso.metodo, paso.ruta, paso.cuerpo);
    if (!res.ok) throw new Error(`github_http_${res.status}: paso ${paso.metodo}`);
  }
}

function esJson(request: Request): boolean {
  const tipo = request.headers.get("content-type");
  return tipo !== null && tipo.split(";")[0].trim().toLowerCase() === "application/json";
}

async function leerCuerpo(request: Request): Promise<unknown> {
  const largo = Number(request.headers.get("content-length"));
  if (largo > MAX_CUERPO) return undefined;
  const texto = await request.text();
  if (new TextEncoder().encode(texto).length > MAX_CUERPO) return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
}

export async function POST(request: Request): Promise<Response> {
  const env = leerEnv();
  if (!env) {
    console.error("accion: faltan o están mal las variables de entorno");
    return rechazar(500, "config_invalida");
  }
  if (!origenValido(request, env.APP_ORIGIN)) return rechazar(403, "no_permitido");
  if (!esJson(request)) return rechazar(400, "accion_invalida");
  const cuerpo = await leerCuerpo(request);
  if (cuerpo === undefined) return rechazar(400, "accion_invalida");

  const ahora = Date.now();
  const valor = leerCookie(request, COOKIE);
  const sesion = valor ? await abrir(valor, env.SESSION_KEY, ahora) : null;
  if (!sesion) return rechazar(401, "sesion_vencida");
  const vigente = await tokenVigente(sesion, ahora, env);
  if (!vigente) return rechazar(401, "sesion_vencida", [cookieBorrar()]);
  const cookies = vigente.renovada ? [vigente.cookieNueva] : [];

  const validada = validarAccion(cuerpo);
  if (!validada.ok) return rechazar(400, "accion_invalida", cookies);
  const { accion } = validada;
  const token = vigente.sesion.token;

  try {
    const item = await releerItem(token, accion);
    if (!item.abierto || !accionPermitida(accion, item.labels, item.clase)) throw new Rechazo(403, "no_permitido");
    if (accion.tipo === "mergear") await mergear(token, accion);
    else await ejecutarPasos(token, accion, ahora);
    return responder({ ok: true }, 200, cookies);
  } catch (error) {
    if (error instanceof Rechazo) {
      if (error.motivo === "sesion_vencida") return rechazar(401, "sesion_vencida", [cookieBorrar()]);
      return rechazar(error.status, error.motivo, cookies);
    }
    // Solo el mensaje propio o el nombre del error: nunca cuerpos de GitHub ni tokens.
    console.error(`accion: falló ${accion.tipo}`, error instanceof Error ? (error.message.startsWith("github_") || error.message.startsWith("respuesta_invalida") ? error.message.slice(0, 80) : error.name) : "desconocido");
    return rechazar(502, "github_error", cookies);
  }
}
