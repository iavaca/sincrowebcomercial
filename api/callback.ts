import {
  COOKIE_ESTADO,
  USUARIO_PERMITIDO,
  abrirEstado,
  cookieEstadoBorrar,
  cookieSesion,
  leerCookie,
  leerEnv,
  mismoEstado,
  pedirTokenGitHub,
  sellar,
  volverSeguro,
} from "../lib/sesion";

// La cookie de estado se borra en toda respuesta: un state sirve para un solo intento.
function texto(status: number, cuerpo: string): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  headers.append("set-cookie", cookieEstadoBorrar());
  return new Response(cuerpo, { status, headers });
}

// 200 con meta refresh en vez de 302: así la navegación a "/" sale del propio sitio
// y el navegador manda la cookie SameSite=Strict recién creada. Sin scripts (CSP).
function entrar(destino: string, cookie: string): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${destino}"><title>Bandeja</title></head><body><a href="${destino}">Entrar a la bandeja</a></body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  headers.append("set-cookie", cookie);
  headers.append("set-cookie", cookieEstadoBorrar());
  return new Response(html, { status: 200, headers });
}

export async function GET(request: Request): Promise<Response> {
  const env = leerEnv();
  if (!env) {
    console.error("callback: faltan o están mal las variables de entorno");
    return texto(500, "Falta configurar la bandeja");
  }

  const ahora = Date.now();
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const sellado = leerCookie(request, COOKIE_ESTADO);
  const estado = sellado ? await abrirEstado(sellado, env.SESSION_KEY, ahora) : null;
  if (!code || !state || !estado || !mismoEstado(state, estado.estado)) {
    return texto(400, "El login venció o no empezó acá. Volvé a entrar.");
  }

  const t = await pedirTokenGitHub({ code, redirect_uri: `${env.APP_ORIGIN}/api/callback` }, env, ahora);
  if (!t) return texto(502, "GitHub no respondió, probá de nuevo");

  let uid: unknown;
  try {
    const respuesta = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${t.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sincroweb-bandeja",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!respuesta.ok) {
      console.error(`callback: GitHub respondió ${respuesta.status} en /user`);
      return texto(502, "GitHub no respondió, probá de nuevo");
    }
    uid = ((await respuesta.json()) as { id?: unknown } | null)?.id;
  } catch (error) {
    console.error("callback: falló la llamada a /user", error instanceof Error ? error.name : "desconocido");
    return texto(502, "GitHub no respondió, probá de nuevo");
  }

  if (uid !== USUARIO_PERMITIDO) return texto(403, "Esta bandeja es privada");

  const sesion = await sellar({ uid: USUARIO_PERMITIDO, ...t, inicio: ahora }, env.SESSION_KEY);
  return entrar(`/${volverSeguro(estado.volver)}`, cookieSesion(sesion));
}
