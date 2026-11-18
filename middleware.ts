// Antes de servir las páginas del panel: sin sesión válida, directo al login de GitHub.
// Sin esto, el HTML estático se veía unos segundos hasta que el JS recibía el 401.
import { next } from "@vercel/functions";
import { COOKIE, abrir, leerCookie, leerEnv } from "./lib/sesion.js";

export const config = { matcher: ["/", "/index.html", "/finanzas.html"] };

const aLogin = () => new Response(null, { status: 302, headers: { location: "/api/login", "cache-control": "no-store" } });

export default async function middleware(request: Request): Promise<Response> {
  const env = leerEnv();
  // Mal configurado: que la página siga y el API muestre el error, en vez de un bucle de redirecciones.
  if (!env) return next({ headers: { "x-panel-sesion": "sin-config" } });
  const valor = leerCookie(request, COOKIE);
  const sesion = valor ? await abrir(valor, env.SESSION_KEY, Date.now()) : null;
  // El header permite comprobar desde afuera que el middleware corrió (no revela nada de la sesión).
  return sesion ? next({ headers: { "x-panel-sesion": "ok" } }) : aLogin();
}
