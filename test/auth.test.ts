import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as login } from "../api/login.js";
import { GET as callback } from "../api/callback.js";
import { POST as logout } from "../api/logout.js";
import {
  COOKIE,
  COOKIE_ESTADO,
  USUARIO_PERMITIDO,
  abrir,
  abrirEstado,
  sellar,
  sellarEstado,
  tokenVigente,
  type Env,
  type Sesion,
} from "../lib/sesion.js";

const APP = "https://bandeja.example.com";
const CLAVE = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ENV: Env = { GITHUB_APP_CLIENT_ID: "Iv1.cliente", GITHUB_APP_CLIENT_SECRET: "secreto_app", SESSION_KEY: CLAVE, APP_ORIGIN: APP };
const MIN = 60_000;

type Llamada = { url: string; init?: RequestInit };
let llamadas: Llamada[];
let respuestas: Record<string, () => Response>;
let errores: ReturnType<typeof vi.spyOn>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const TOKEN_OK = { access_token: "ghu_nuevo", expires_in: 28800, refresh_token: "ghr_nuevo", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" };

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  llamadas = [];
  respuestas = {
    "https://github.com/login/oauth/access_token": () => json(TOKEN_OK),
    "https://api.github.com/user": () => json({ id: USUARIO_PERMITIDO, login: "iavaca" }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      llamadas.push({ url: u, init });
      const r = respuestas[u];
      if (!r) throw new Error(`fetch inesperado: ${u}`);
      return r();
    }),
  );
  errores = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Ningún log puede llevar tokens, secretos, el code ni cookies.
  const logs = JSON.stringify(errores.mock.calls);
  for (const secreto of ["ghu_", "ghr_", "secreto_app", "code_123", CLAVE]) expect(logs).not.toContain(secreto);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}
function valorCookie(res: Response, nombre: string): string | undefined {
  const c = setCookies(res).find((x) => x.startsWith(`${nombre}=`));
  return c?.slice(nombre.length + 1).split(";")[0];
}
function atributos(c: string): string[] {
  return c.split(";").slice(1).map((p) => p.trim());
}

async function empezarLogin(volver?: string): Promise<{ estado: string; cookie: string; res: Response }> {
  const q = volver === undefined ? "" : `?volver=${encodeURIComponent(volver)}`;
  const res = await login(new Request(`${APP}/api/login${q}`));
  const estado = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { estado, cookie: valorCookie(res, COOKIE_ESTADO)!, res };
}

function pedirCallback(params: Record<string, string>, cookieEstado?: string): Promise<Response> {
  const headers: Record<string, string> = cookieEstado ? { cookie: `otra=1; ${COOKIE_ESTADO}=${cookieEstado}` } : {};
  return callback(new Request(`${APP}/api/callback?${new URLSearchParams(params)}`, { headers }));
}

describe("GET /api/login", () => {
  it("redirige a GitHub con client_id, state y redirect_uri, y deja la cookie de estado Lax en /api por 10 min", async () => {
    const { res, estado, cookie } = await empezarLogin("#t=claude-agents-7");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const destino = new URL(res.headers.get("location")!);
    expect(`${destino.origin}${destino.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(destino.searchParams.get("client_id")).toBe("Iv1.cliente");
    expect(destino.searchParams.get("redirect_uri")).toBe(`${APP}/api/callback`);
    expect(estado).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const c = setCookies(res).find((x) => x.startsWith(`${COOKIE_ESTADO}=`))!;
    expect(atributos(c)).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/api", "Max-Age=600"]));
    expect(c).not.toMatch(/Domain=/i);
    expect(c).not.toContain(estado);
    const abierto = await abrirEstado(cookie, CLAVE, Date.now());
    expect(abierto?.estado).toBe(estado);
    expect(abierto?.volver).toBe("#t=claude-agents-7");
    expect(llamadas).toHaveLength(0);
  });

  it("cada login usa un state distinto", async () => {
    const a = await empezarLogin();
    const b = await empezarLogin();
    expect(a.estado).not.toBe(b.estado);
  });

  it("descarta un volver que no es un ancla de la bandeja", async () => {
    for (const v of ["https://evil.com", "//evil.com", "#t=claude-agents-7x", "#aviso-<x>", "javascript:alert(1)"]) {
      const { cookie } = await empezarLogin(v);
      expect((await abrirEstado(cookie, CLAVE, Date.now()))?.volver).toBe("");
    }
  });

  it("sin variables de entorno → 500 sin cookie", async () => {
    vi.stubEnv("SESSION_KEY", "");
    const res = await login(new Request(`${APP}/api/login`));
    expect(res.status).toBe(500);
    expect(setCookies(res)).toHaveLength(0);
  });
});

describe("GET /api/callback", () => {
  it("callback con state distinto → 400 y no llama a GitHub", async () => {
    const { cookie } = await empezarLogin();
    const res = await pedirCallback({ code: "code_123", state: "otro" }, cookie);
    expect(res.status).toBe(400);
    expect(llamadas).toHaveLength(0);
    expect(valorCookie(res, COOKIE)).toBeUndefined();
  });

  it("callback sin cookie de estado, sin state, con estado vencido o con error de GitHub → 400 y no llama a GitHub", async () => {
    const { estado, cookie } = await empezarLogin();
    expect((await pedirCallback({ code: "code_123", state: estado })).status).toBe(400);
    expect((await pedirCallback({ code: "code_123" }, cookie)).status).toBe(400);
    expect((await pedirCallback({ state: estado }, cookie)).status).toBe(400);
    expect((await pedirCallback({ error: "access_denied", state: estado }, cookie)).status).toBe(400);
    const vencida = await sellarEstado({ estado, volver: "", vence: Date.now() - 1 }, CLAVE);
    expect((await pedirCallback({ code: "code_123", state: estado }, vencida)).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("callback de un usuario con id != 100360837 → 403 y sin cookie de sesión", async () => {
    respuestas["https://api.github.com/user"] = () => json({ id: 999, login: "otro" });
    const { estado, cookie } = await empezarLogin();
    const res = await pedirCallback({ code: "code_123", state: estado }, cookie);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Esta bandeja es privada");
    expect(valorCookie(res, COOKIE)).toBeUndefined();
    expect(setCookies(res).some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
  });

  it("callback de iavaca → 200 que navega a /#t=claude-agents-7 con Set-Cookie __Host-bandeja", async () => {
    const { estado, cookie } = await empezarLogin("#t=claude-agents-7");
    const antes = Date.now();
    const res = await pedirCallback({ code: "code_123", state: estado }, cookie);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain('<meta http-equiv="refresh" content="0;url=/#t=claude-agents-7">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("ghu_");

    const sello = valorCookie(res, COOKIE)!;
    const c = setCookies(res).find((x) => x.startsWith(`${COOKIE}=`))!;
    expect(atributos(c)).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=604800"]));
    const s = await abrir(sello, CLAVE, Date.now());
    expect(s).toMatchObject({ uid: USUARIO_PERMITIDO, token: "ghu_nuevo", refresh: "ghr_nuevo" });
    expect(s!.inicio).toBeGreaterThanOrEqual(antes);
    expect(s!.tokenVence - s!.inicio).toBe(28800 * 1000);
    expect(s!.refreshVence - s!.inicio).toBe(15897600 * 1000);

    // La cookie de estado se borra al usarla.
    const borrada = setCookies(res).find((x) => x.startsWith(`${COOKIE_ESTADO}=`))!;
    expect(borrada).toMatch(new RegExp(`^${COOKIE_ESTADO}=;`));
    expect(atributos(borrada)).toContain("Max-Age=0");

    // Canje del code: POST a GitHub con accept JSON, client secret y el redirect_uri.
    const canje = llamadas.find((l) => l.url === "https://github.com/login/oauth/access_token")!;
    expect(canje.init?.method).toBe("POST");
    expect(new Headers(canje.init?.headers).get("accept")).toBe("application/json");
    const cuerpo = new URLSearchParams(String(canje.init?.body));
    expect(Object.fromEntries(cuerpo)).toEqual({ client_id: "Iv1.cliente", client_secret: "secreto_app", code: "code_123", redirect_uri: `${APP}/api/callback` });
    const usuario = llamadas.find((l) => l.url === "https://api.github.com/user")!;
    expect(new Headers(usuario.init?.headers).get("authorization")).toBe("Bearer ghu_nuevo");
  });

  it("callback con volver malicioso (https://evil.com, //evil.com) → redirige a /", async () => {
    for (const volver of ["https://evil.com", "//evil.com", '#t=a-1"><script>', "#aviso-x\n"]) {
      const estado = "estado-fijo";
      const sellado = await sellarEstado({ estado, volver, vence: Date.now() + 10 * MIN }, CLAVE);
      const res = await pedirCallback({ code: "code_123", state: estado }, sellado);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta http-equiv="refresh" content="0;url=/">');
      expect(html).not.toContain("evil");
      expect(html).not.toContain("<script");
    }
  });

  it("acepta un volver de aviso", async () => {
    const { estado, cookie } = await empezarLogin("#aviso-cecal-2");
    const html = await (await pedirCallback({ code: "code_123", state: estado }, cookie)).text();
    expect(html).toContain('content="0;url=/#aviso-cecal-2"');
  });

  it("GitHub rechaza el code o falla → 502 sin cookie de sesión", async () => {
    const casos: Array<() => Response> = [
      () => json({ error: "bad_verification_code", error_description: "x" }),
      () => json({}, 500),
      () => json({ access_token: "ghu_x", token_type: "bearer" }), // sin refresh: la App no tiene tokens que vencen
    ];
    for (const caso of casos) {
      respuestas["https://github.com/login/oauth/access_token"] = caso;
      const { estado, cookie } = await empezarLogin();
      const res = await pedirCallback({ code: "code_123", state: estado }, cookie);
      expect(res.status).toBe(502);
      expect(valorCookie(res, COOKIE)).toBeUndefined();
    }
    respuestas["https://github.com/login/oauth/access_token"] = () => json(TOKEN_OK);
    respuestas["https://api.github.com/user"] = () => json({ message: "Bad credentials" }, 401);
    const { estado, cookie } = await empezarLogin();
    expect((await pedirCallback({ code: "code_123", state: estado }, cookie)).status).toBe(502);
    expect(errores).toHaveBeenCalled();
  });
});

describe("POST /api/logout", () => {
  it("con Origin válido borra la cookie de sesión", async () => {
    const res = await logout(new Request(`${APP}/api/logout`, { method: "POST", headers: { origin: APP } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const c = setCookies(res).find((x) => x.startsWith(`${COOKIE}=`))!;
    expect(c).toMatch(new RegExp(`^${COOKIE}=;`));
    expect(atributos(c)).toContain("Max-Age=0");
  });

  const URL_REVOCAR = `https://api.github.com/applications/${ENV.GITHUB_APP_CLIENT_ID}/token`;
  const sesionLogout: Sesion = { uid: USUARIO_PERMITIDO, token: "ghu_salir", tokenVence: Date.now() + 60 * MIN, refresh: "ghr_salir", refreshVence: Date.now() + 60 * MIN, inicio: Date.now() - MIN };
  const pedirLogout = async () =>
    logout(new Request(`${APP}/api/logout`, { method: "POST", headers: { origin: APP, cookie: `${COOKIE}=${await sellar(sesionLogout, CLAVE)}` } }));

  it("con sesión válida revoca el token en GitHub y borra la cookie", async () => {
    respuestas[URL_REVOCAR] = () => new Response(null, { status: 204 });
    const res = await pedirLogout();
    expect(res.status).toBe(204);
    expect(setCookies(res).find((x) => x.startsWith(`${COOKIE}=;`))).toBeDefined();

    expect(llamadas).toHaveLength(1);
    const [l] = llamadas;
    expect(l.url).toBe(URL_REVOCAR);
    expect(l.init?.method).toBe("DELETE");
    const headers = new Headers(l.init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("Iv1.cliente:secreto_app")}`);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(JSON.parse(String(l.init?.body))).toEqual({ access_token: "ghu_salir" });
  });

  it("si la revocación falla (red o status) igual borra la cookie", async () => {
    for (const r of [() => { throw new Error("red caída"); }, () => json({ message: "ghu_salir" }, 422)]) {
      respuestas[URL_REVOCAR] = r;
      const res = await pedirLogout();
      expect(res.status).toBe(204);
      expect(setCookies(res).find((x) => x.startsWith(`${COOKIE}=;`))).toBeDefined();
    }
    expect(llamadas).toHaveLength(2);
  });

  it("sin cookie o con cookie inválida no llama a GitHub", async () => {
    for (const headers of [{ origin: APP }, { origin: APP, cookie: `${COOKIE}=basura` }] as Record<string, string>[]) {
      const res = await logout(new Request(`${APP}/api/logout`, { method: "POST", headers }));
      expect(res.status).toBe(204);
    }
    expect(llamadas).toHaveLength(0);
  });

  it("con Origin ajeno o sin Origin → 403 y no toca la cookie", async () => {
    for (const headers of [{ origin: "https://evil.com" }, {}] as Record<string, string>[]) {
      const res = await logout(new Request(`${APP}/api/logout`, { method: "POST", headers }));
      expect(res.status).toBe(403);
      expect(setCookies(res)).toHaveLength(0);
    }
  });
});

describe("tokenVigente", () => {
  const AHORA = 1_800_000_000_000;
  const base: Sesion = { uid: USUARIO_PERMITIDO, token: "ghu_viejo", tokenVence: AHORA + 3 * MIN, refresh: "ghr_viejo", refreshVence: AHORA + 30 * 24 * 60 * MIN, inicio: AHORA - 60 * MIN };

  it("no llama a GitHub si al token le quedan más de 5 min", async () => {
    const s = { ...base, tokenVence: AHORA + 60 * MIN };
    expect(await tokenVigente(s, AHORA, ENV)).toEqual({ sesion: s, renovada: false });
    expect(llamadas).toHaveLength(0);
  });

  it("tokenVigente renueva con refresh_token y devuelve renovada: true", async () => {
    const r = await tokenVigente(base, AHORA, ENV);
    expect(r?.renovada).toBe(true);
    expect(r?.sesion).toEqual({ ...base, token: "ghu_nuevo", tokenVence: AHORA + 28800 * 1000, refresh: "ghr_nuevo", refreshVence: AHORA + 15897600 * 1000 });

    // La cookie nueva lleva el refresh token rotado, sellado.
    if (!r?.renovada) throw new Error("debía renovar");
    expect(r.cookieNueva.startsWith(`${COOKIE}=`)).toBe(true);
    expect(atributos(r.cookieNueva)).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=604800"]));
    expect(r.cookieNueva).not.toContain("ghr_nuevo");
    const sello = r.cookieNueva.slice(COOKIE.length + 1).split(";")[0];
    expect(await abrir(sello, CLAVE, AHORA)).toEqual(r.sesion);

    const [l] = llamadas;
    expect(l.url).toBe("https://github.com/login/oauth/access_token");
    expect(new Headers(l.init?.headers).get("accept")).toBe("application/json");
    expect(Object.fromEntries(new URLSearchParams(String(l.init?.body)))).toEqual({
      client_id: "Iv1.cliente",
      client_secret: "secreto_app",
      grant_type: "refresh_token",
      refresh_token: "ghr_viejo",
    });
  });

  it("tokenVigente devuelve null si GitHub rechaza el refresh", async () => {
    for (const caso of [() => json({ error: "bad_refresh_token" }), () => json({}, 500), () => json({ access_token: "ghu_x" })]) {
      respuestas["https://github.com/login/oauth/access_token"] = caso;
      expect(await tokenVigente(base, AHORA, ENV)).toBeNull();
    }
    respuestas["https://github.com/login/oauth/access_token"] = () => {
      throw new TypeError("fetch failed");
    };
    expect(await tokenVigente(base, AHORA, ENV)).toBeNull();
  });

  it("tokenVigente devuelve null sin llamar a GitHub si el refresh token venció", async () => {
    expect(await tokenVigente({ ...base, refreshVence: AHORA - 1 }, AHORA, ENV)).toBeNull();
    expect(llamadas).toHaveLength(0);
  });
});
