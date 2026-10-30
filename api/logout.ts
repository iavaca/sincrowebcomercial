import { cookieBorrar, leerEnv, origenValido } from "../lib/sesion";

export async function POST(request: Request): Promise<Response> {
  const env = leerEnv();
  if (!env || !origenValido(request, env.APP_ORIGIN)) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, { status: 204, headers: { "set-cookie": cookieBorrar(), "cache-control": "no-store" } });
}
