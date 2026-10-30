import { COOKIE, abrir, cookieBorrar, leerCookie, leerEnv, origenValido, type Env } from "../lib/sesion.js";

const TIMEOUT_MS = 8000;

// Revoca el token en GitHub para que salir no deje un token vivo. Falle lo que falle se sigue:
// la cookie se borra igual, y no se loguea nada (ni el token ni la respuesta).
async function revocarToken(request: Request, env: Env): Promise<void> {
  const valor = leerCookie(request, COOKIE);
  const sesion = valor ? await abrir(valor, env.SESSION_KEY, Date.now()) : null;
  if (!sesion) return;
  try {
    await fetch(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_APP_CLIENT_ID)}/token`, {
      method: "DELETE",
      headers: {
        authorization: `Basic ${btoa(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET}`)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "sincroweb-bandeja",
      },
      body: JSON.stringify({ access_token: sesion.token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Sin red o timeout: el token vence solo (8 h) y la cookie se borra igual.
  }
}

export async function POST(request: Request): Promise<Response> {
  const env = leerEnv();
  if (!env || !origenValido(request, env.APP_ORIGIN)) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  await revocarToken(request, env);
  return new Response(null, { status: 204, headers: { "set-cookie": cookieBorrar(), "cache-control": "no-store" } });
}
