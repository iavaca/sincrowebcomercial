import { armarBandeja } from "../lib/clasificar";
import { consultarGraphQL, CONSULTA, normalizar } from "../lib/github";
import type { Bandeja } from "../lib/tipos";
import { COOKIE, abrir, cookieBorrar, leerCookie, leerEnv, tokenVigente } from "../lib/sesion";

function responder(cuerpo: unknown, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(cuerpo), { status, headers });
}

// Único punto que decide el formato de salida: la Task 6 lo cambia a HTML.
function responderBandeja(bandeja: Bandeja, cookies: string[]): Response {
  return responder(bandeja, 200, cookies);
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
    const { items, truncado } = normalizar(await consultarGraphQL(vigente.sesion.token, CONSULTA));
    return responderBandeja(armarBandeja(items, new Date(ahora), truncado), cookies);
  } catch (error) {
    console.error("bandeja: falló la lectura de GitHub", error instanceof Error ? error.message.slice(0, 80) : "desconocido");
    return responder({ error: "github_error" }, 502, cookies);
  }
}
