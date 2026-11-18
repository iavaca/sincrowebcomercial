// Guarda los movimientos en un archivo de la rama huérfana `finanzas` del repo privado sincroweb-pedidos.
// Escribe con el token del usuario logueado: cada carga queda como un commit con su autor.
import { llamarGitHub } from "./github.js";
import { parsearArchivo, serializar, type Movimiento } from "./finanzas.js";

export const REPO = "/repos/iavaca/sincroweb-pedidos";
export const RAMA = "finanzas";
export const RUTA = "finanzas/movimientos.json";
// En la rama de datos Vercel no tiene que construir nada: cada carga dispararía un deploy de pedidos.
export const VERCEL_RAMA = JSON.stringify({ git: { deploymentEnabled: false } }, null, 2) + "\n";

export type Lectura = { movs: Movimiento[]; sha: string | null; rama: boolean };

// status: lo que el API responde; motivo: clave de texto para el usuario.
export class FalloFinanzas extends Error {
  constructor(readonly status: number, readonly motivo: "sesion_vencida" | "github_sin_permiso" | "conflicto") {
    super(motivo);
  }
}

async function pedir(token: string, metodo: string, ruta: string, cuerpo?: unknown): Promise<Response> {
  const res = await llamarGitHub(token, metodo, ruta, cuerpo);
  if (res.status === 401) throw new FalloFinanzas(401, "sesion_vencida");
  if (res.status === 403) throw new FalloFinanzas(502, "github_sin_permiso");
  return res;
}

async function cuerpoJson(res: Response, que: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`github_http_${res.status}: ${que}`);
  const d: unknown = await res.json();
  if (typeof d !== "object" || d === null) throw new Error(`respuesta_invalida: ${que}`);
  return d as Record<string, unknown>;
}

function base64Utf8(texto: string): string {
  let s = "";
  for (const b of new TextEncoder().encode(texto)) s += String.fromCharCode(b);
  return btoa(s);
}

function desdeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function leer(token: string): Promise<Lectura> {
  const res = await pedir(token, "GET", `${REPO}/contents/${RUTA}?ref=${RAMA}`);
  if (res.status === 404) {
    // 404 puede ser "no existe la rama" o "existe la rama pero no el archivo".
    const ref = await pedir(token, "GET", `${REPO}/git/ref/heads/${RAMA}`);
    if (ref.status === 404) {
      // GitHub responde 404 (no 403) cuando el token no ve un repo privado: sin esto se mostraría "sin movimientos".
      const repo = await pedir(token, "GET", REPO);
      if (repo.status === 404) throw new FalloFinanzas(502, "github_sin_permiso");
      await cuerpoJson(repo, "repo");
      return { movs: [], sha: null, rama: false };
    }
    await cuerpoJson(ref, "ref");
    return { movs: [], sha: null, rama: true };
  }
  const d = await cuerpoJson(res, "contents");
  if (typeof d.sha !== "string") throw new Error("respuesta_invalida: contents");
  let contenido = d.content;
  // Arriba de 1 MB la Contents API no trae el contenido (encoding "none"): se lee el blob por su sha.
  if (d.encoding === "none") {
    const blob = await cuerpoJson(await pedir(token, "GET", `${REPO}/git/blobs/${d.sha}`), "blob");
    if (blob.encoding !== "base64") throw new Error("respuesta_invalida: blob");
    contenido = blob.content;
  } else if (d.encoding !== "base64") {
    throw new Error("respuesta_invalida: contents");
  }
  if (typeof contenido !== "string") throw new Error("respuesta_invalida: contents");
  return { movs: parsearArchivo(desdeBase64Utf8(contenido)), sha: d.sha, rama: true };
}

// Lanza FalloFinanzas(409, "conflicto") si alguien escribió en el medio (sha viejo o rama creada a la vez).
export async function guardar(token: string, movs: Movimiento[], lectura: Lectura, mensaje: string): Promise<void> {
  const contenido = serializar(movs);
  if (lectura.rama) {
    const res = await pedir(token, "PUT", `${REPO}/contents/${RUTA}`, {
      message: mensaje,
      content: base64Utf8(contenido),
      branch: RAMA,
      ...(lectura.sha ? { sha: lectura.sha } : {}),
    });
    if (res.status === 409 || res.status === 422) throw new FalloFinanzas(409, "conflicto");
    await cuerpoJson(res, "put");
    return;
  }
  const arbol = await cuerpoJson(await pedir(token, "POST", `${REPO}/git/trees`, {
    tree: [
      { path: RUTA, mode: "100644", type: "blob", content: contenido },
      { path: "vercel.json", mode: "100644", type: "blob", content: VERCEL_RAMA },
    ],
  }), "tree");
  if (typeof arbol.sha !== "string") throw new Error("respuesta_invalida: tree");
  const commit = await cuerpoJson(await pedir(token, "POST", `${REPO}/git/commits`, { message: mensaje, tree: arbol.sha, parents: [] }), "commit");
  if (typeof commit.sha !== "string") throw new Error("respuesta_invalida: commit");
  const ref = await pedir(token, "POST", `${REPO}/git/refs`, { ref: `refs/heads/${RAMA}`, sha: commit.sha });
  if (ref.status === 422) throw new FalloFinanzas(409, "conflicto");
  await cuerpoJson(ref, "ref");
}
