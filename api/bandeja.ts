import { armarBandeja } from "../lib/clasificar.js";
import { renderBandeja } from "../lib/html.js";
import { consultarGraphQL, CONSULTA, normalizar } from "../lib/github.js";
import type { Bandeja } from "../lib/tipos.js";
import { rechazoPorStatus, statusDeError } from "../lib/rechazo.js";
import { COOKIE, abrir, cookieBorrar, leerCookie, leerEnv, tokenVigente } from "../lib/sesion.js";

function responder(cuerpo: unknown, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(cuerpo), { status, headers });
}

// HTML escapado (fragmento) por defecto; `?formato=json` devuelve la bandeja cruda.
function responderBandeja(bandeja: Bandeja, ahora: Date, json: boolean, cookies: string[]): Response {
  if (json) return responder(bandeja, 200, cookies);
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(renderBandeja(bandeja, ahora), { status: 200, headers });
}

export async function GET(request: Request): Promise<Response> {
  const env = leerEnv();
  if (!env) {
    console.error("bandeja: faltan o están mal las variables de entorno");
    return responder({ error: "config_invalida" }, 500);
  }

  const ahora = Date.now();
  const valor = leerCookie(request, COOKIE);
  const sesion = valor ? await abrir(valor, env.SESSION_KEY, ahora) : null;
  if (!sesion) return responder({ error: "sesion_vencida" }, 401);

  const vigente = await tokenVigente(sesion, ahora, env);
  if (!vigente) return responder({ error: "sesion_vencida" }, 401, [cookieBorrar()]);
  const cookies = vigente.renovada ? [vigente.cookieNueva] : [];

  try {
    const data = await consultarGraphQL(vigente.sesion.token, CONSULTA);
    const { items, truncado } = normalizar(data);
    const json = new URL(request.url).searchParams.get("formato") === "json";
    return responderBandeja(armarBandeja(items, new Date(ahora), truncado), new Date(ahora), json, cookies);
  } catch (error) {
    const status = statusDeError(error);
    if (status !== undefined && rechazoPorStatus(status)?.motivo === "sesion_vencida") {
      return responder({ error: "sesion_vencida" }, 401, [cookieBorrar()]);
    }
    console.error("bandeja: falló la lectura de GitHub", error instanceof Error ? error.message.slice(0, 80) : "desconocido");
    return responder({ error: "github_error" }, 502, cookies);
  }
}
