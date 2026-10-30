import { MAX_ESTADO_MS, cookieEstado, estadoAlAzar, leerEnv, sellarEstado, volverSeguro } from "../lib/sesion";

export async function GET(request: Request): Promise<Response> {
  const env = leerEnv();
  if (!env) {
    console.error("login: faltan o están mal las variables de entorno");
    return new Response("Falta configurar la bandeja", { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }

  const estado = estadoAlAzar();
  const volver = volverSeguro(new URL(request.url).searchParams.get("volver"));
  const sellado = await sellarEstado({ estado, volver, vence: Date.now() + MAX_ESTADO_MS }, env.SESSION_KEY);

  const destino = new URL("https://github.com/login/oauth/authorize");
  destino.search = new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, state: estado, redirect_uri: `${env.APP_ORIGIN}/api/callback` }).toString();

  return new Response(null, {
    status: 302,
    headers: { location: destino.toString(), "set-cookie": cookieEstado(sellado), "cache-control": "no-store" },
  });
}
