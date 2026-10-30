// Declaración mínima para no sumar @types/node solo por leer variables.
declare const process: { env: Record<string, string | undefined> };

export const USUARIO_PERMITIDO = 100360837;
export const COOKIE = "__Host-bandeja"; // Path=/, sin Domain
// __Host- exige Path=/; la de estado va acotada a /api, así que usa __Secure-.
export const COOKIE_ESTADO = "__Secure-bandeja-estado";
export const MAX_SESION_MS = 7 * 24 * 3600 * 1000;
export const MAX_ESTADO_MS = 10 * 60 * 1000;
const MARGEN_REFRESH_MS = 5 * 60 * 1000;
const URL_TOKEN = "https://github.com/login/oauth/access_token";
const TIMEOUT_MS = 8000;

export type Sesion = { uid: number; token: string; tokenVence: number; refresh: string; refreshVence: number; inicio: number };
export type EstadoOAuth = { estado: string; volver: string; vence: number };
export type Env = { GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string; SESSION_KEY: string; APP_ORIGIN: string };
export type TokenGitHub = { token: string; tokenVence: number; refresh: string; refreshVence: number };
export type Vigente = { sesion: Sesion; renovada: false } | { sesion: Sesion; renovada: true; cookieNueva: string };

// El propósito va como dato autenticado: un sello de estado no abre como sesión ni al revés.
const AAD_SESION = new TextEncoder().encode("bandeja:sesion");
const AAD_ESTADO = new TextEncoder().encode("bandeja:estado");

function aB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function desdeB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function desdeB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return desdeB64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
}

function bytesDeClave(claveB64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = desdeB64(claveB64);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

async function importarClave(claveB64: string): Promise<CryptoKey> {
  const bytes = bytesDeClave(claveB64);
  if (!bytes) throw new Error("SESSION_KEY no son 32 bytes en base64");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sellarDatos(datos: unknown, claveB64: string, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const clave = await importarClave(claveB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plano = new TextEncoder().encode(JSON.stringify(datos));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, clave, plano));
  const todo = new Uint8Array(iv.length + ct.length);
  todo.set(iv);
  todo.set(ct, iv.length);
  return aB64url(todo);
}

async function abrirDatos(valor: string, claveB64: string, aad: Uint8Array<ArrayBuffer>): Promise<unknown> {
  const bytes = desdeB64url(valor);
  if (!bytes || bytes.length < 12 + 16) return null;
  try {
    const clave = await importarClave(claveB64);
    const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad }, clave, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plano));
  } catch {
    return null;
  }
}

const esTexto = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const esNumero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export async function sellar(s: Sesion, claveB64: string): Promise<string> {
  const { uid, token, tokenVence, refresh, refreshVence, inicio } = s;
  return sellarDatos({ uid, token, tokenVence, refresh, refreshVence, inicio }, claveB64, AAD_SESION);
}

export async function abrir(valor: string, claveB64: string, ahora: number): Promise<Sesion | null> {
  const d = await abrirDatos(valor, claveB64, AAD_SESION);
  if (typeof d !== "object" || d === null) return null;
  const { uid, token, tokenVence, refresh, refreshVence, inicio } = d as Record<string, unknown>;
  if (uid !== USUARIO_PERMITIDO) return null;
  if (!esTexto(token) || !esTexto(refresh) || !esNumero(tokenVence) || !esNumero(refreshVence) || !esNumero(inicio)) return null;
  if (ahora - inicio > MAX_SESION_MS) return null;
  return { uid, token, tokenVence, refresh, refreshVence, inicio };
}

export async function sellarEstado(e: EstadoOAuth, claveB64: string): Promise<string> {
  return sellarDatos({ estado: e.estado, volver: e.volver, vence: e.vence }, claveB64, AAD_ESTADO);
}

export async function abrirEstado(valor: string, claveB64: string, ahora: number): Promise<EstadoOAuth | null> {
  const d = await abrirDatos(valor, claveB64, AAD_ESTADO);
  if (typeof d !== "object" || d === null) return null;
  const { estado, volver, vence } = d as Record<string, unknown>;
  if (!esTexto(estado) || typeof volver !== "string" || !esNumero(vence) || ahora > vence) return null;
  return { estado, volver, vence };
}

export function estadoAlAzar(): string {
  return aB64url(crypto.getRandomValues(new Uint8Array(32)));
}

// Comparación de largo fijo para no filtrar por tiempo cuántos caracteres del state coinciden.
export function mismoEstado(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

// Solo anclas de tarjetas o avisos: nada que pueda sacar al navegador del sitio.
export function volverSeguro(volver: string | null | undefined): string {
  if (typeof volver !== "string") return "";
  return /^#t=[a-z-]+-\d+$/.test(volver) || /^#aviso-[a-z0-9-]+$/.test(volver) ? volver : "";
}

export function cookieSesion(valor: string): string {
  return `${COOKIE}=${valor}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`;
}

export function cookieBorrar(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// Lax: la vuelta desde github.com es una navegación cross-site y con Strict la cookie no viaja.
export function cookieEstado(valor: string): string {
  return `${COOKIE_ESTADO}=${valor}; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=600`;
}

export function cookieEstadoBorrar(): string {
  return `${COOKIE_ESTADO}=; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=0`;
}

export function leerCookie(request: Request, nombre: string): string | undefined {
  const cabecera = request.headers.get("cookie");
  if (!cabecera) return undefined;
  for (const parte of cabecera.split(";")) {
    const i = parte.indexOf("=");
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return undefined;
}

export function origenValido(request: Request, appOrigin: string): boolean {
  const origen = request.headers.get("origin");
  return origen !== null && origen !== "null" && origen === appOrigin;
}

export function necesitaRefresh(s: Sesion, ahora: number): boolean {
  return s.tokenVence - ahora < MARGEN_REFRESH_MS;
}

// POST al endpoint de tokens de GitHub (canje de code o refresh). null ante cualquier falla.
// Los logs llevan solo el status o el nombre del error: nunca tokens, code ni secretos.
export async function pedirTokenGitHub(params: Record<string, string>, env: Env, ahora: number): Promise<TokenGitHub | null> {
  let respuesta: Response;
  try {
    respuesta = await fetch(URL_TOKEN, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "sincroweb-bandeja" },
      body: new URLSearchParams({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, ...params }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error("sesion: falló la llamada de token a GitHub", error instanceof Error ? error.name : "desconocido");
    return null;
  }
  if (!respuesta.ok) {
    console.error(`sesion: GitHub respondió ${respuesta.status} al pedir token`);
    return null;
  }
  let d: Record<string, unknown>;
  try {
    const cuerpo: unknown = await respuesta.json();
    if (typeof cuerpo !== "object" || cuerpo === null) throw new TypeError("cuerpo no es objeto");
    d = cuerpo as Record<string, unknown>;
  } catch (error) {
    console.error("sesion: respuesta de token ilegible", error instanceof Error ? error.name : "desconocido");
    return null;
  }
  if (typeof d.error === "string") {
    // Códigos fijos de GitHub (bad_refresh_token, bad_verification_code…): no son secretos.
    console.error(`sesion: GitHub rechazó el token (${/^[a-z_]{1,40}$/.test(d.error) ? d.error : "otro"})`);
    return null;
  }
  const { access_token, expires_in, refresh_token, refresh_token_expires_in } = d;
  if (!esTexto(access_token) || !esTexto(refresh_token) || !esNumero(expires_in) || !esNumero(refresh_token_expires_in) || expires_in <= 0 || refresh_token_expires_in <= 0) {
    console.error("sesion: respuesta de token sin los campos de un token que vence");
    return null;
  }
  return { token: access_token, tokenVence: ahora + expires_in * 1000, refresh: refresh_token, refreshVence: ahora + refresh_token_expires_in * 1000 };
}

// El refresh token rota en cada renovación: si renovada, el handler tiene que mandar cookieNueva.
export async function tokenVigente(s: Sesion, ahora: number, env: Env): Promise<Vigente | null> {
  if (!necesitaRefresh(s, ahora)) return { sesion: s, renovada: false };
  if (s.refreshVence <= ahora) return null;
  const t = await pedirTokenGitHub({ grant_type: "refresh_token", refresh_token: s.refresh }, env, ahora);
  if (!t) return null;
  const sesion: Sesion = { ...s, ...t };
  return { sesion, renovada: true, cookieNueva: cookieSesion(await sellar(sesion, env.SESSION_KEY)) };
}

export function leerEnv(): Env | null {
  const { GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, SESSION_KEY, APP_ORIGIN } = process.env;
  if (!GITHUB_APP_CLIENT_ID || !GITHUB_APP_CLIENT_SECRET || !SESSION_KEY || !APP_ORIGIN) return null;
  if (!bytesDeClave(SESSION_KEY)) return null;
  try {
    const u = new URL(APP_ORIGIN);
    if (u.protocol !== "https:" || u.origin !== APP_ORIGIN) return null;
  } catch {
    return null;
  }
  return { GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, SESSION_KEY, APP_ORIGIN };
}
