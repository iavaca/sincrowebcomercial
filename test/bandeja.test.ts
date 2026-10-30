import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/graphql.json";
import { GET } from "../api/bandeja";
import { COOKIE, USUARIO_PERMITIDO, abrir, sellar, type Env, type Sesion } from "../lib/sesion";

const APP = "https://bandeja.example.com";
const CLAVE = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ENV: Env = { GITHUB_APP_CLIENT_ID: "Iv1.cliente", GITHUB_APP_CLIENT_SECRET: "secreto_app", SESSION_KEY: CLAVE, APP_ORIGIN: APP };
const HORA = 3_600_000;

let errores: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;
let graphql: () => Response | Promise<Response>;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function sesion(extra: Partial<Sesion> = {}): Sesion {
  const ahora = Date.now();
  return { uid: USUARIO_PERMITIDO, token: "ghu_viejo", tokenVence: ahora + 8 * HORA, refresh: "ghr_viejo", refreshVence: ahora + 100 * HORA, inicio: ahora, ...extra };
}
async function pedir(s?: Sesion): Promise<Response> {
  const headers: Record<string, string> = s ? { cookie: `${COOKIE}=${await sellar(s, CLAVE)}` } : {};
  return GET(new Request(`${APP}/api/bandeja`, { headers }));
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  graphql = () => json(fixture);
  fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://api.github.com/graphql") return graphql();
    if (u === "https://github.com/login/oauth/access_token") {
      return json({ access_token: "ghu_nuevo", expires_in: 28800, refresh_token: "ghr_nuevo", refresh_token_expires_in: 15897600 });
    }
    throw new Error(`fetch inesperado: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  errores = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  const logs = JSON.stringify(errores.mock.calls);
  for (const secreto of ["ghu_", "ghr_", "secreto_app", CLAVE]) expect(logs).not.toContain(secreto);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/bandeja", () => {
  it("sin cookie → 401 sesion_vencida, no-store, sin llamar a GitHub", async () => {
    const res = await pedir();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sesion_vencida" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cookie que no abre → 401", async () => {
    const res = await GET(new Request(`${APP}/api/bandeja`, { headers: { cookie: `${COOKIE}=basura` } }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sesión vigente → 200 con la bandeja, el token de la sesión y sin Set-Cookie", async () => {
    const res = await pedir(sesion());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    const b = (await res.json()) as Record<string, unknown>;
    expect(b).toEqual(expect.objectContaining({ ahora: expect.any(Array), hoy: expect.any(Array), cuando: expect.any(Array), truncado: false }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer ghu_viejo" });
    expect(JSON.parse(init.body as string).query).toContain("search(type: ISSUE");
  });

  it("token por vencer → refresca, usa el token nuevo y manda la cookie nueva", async () => {
    const res = await pedir(sesion({ tokenVence: Date.now() + 60_000 }));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(new RegExp(`^${COOKIE}=`));
    const nueva = await abrir(cookies[0].slice(COOKIE.length + 1).split(";")[0], CLAVE, Date.now());
    expect(nueva).toMatchObject({ token: "ghu_nuevo", refresh: "ghr_nuevo" });
    const gql = fetchMock.mock.calls.find((c) => c[0] === "https://api.github.com/graphql") as [string, RequestInit];
    expect(gql[1].headers).toMatchObject({ authorization: "Bearer ghu_nuevo" });
  });

  it("refresh imposible → 401 y borra la cookie", async () => {
    const res = await pedir(sesion({ tokenVence: Date.now() + 60_000, refreshVence: Date.now() - 1000 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sesion_vencida" });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(new RegExp(`^${COOKIE}=;.*Max-Age=0`));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GitHub 500 → 502 github_error", async () => {
    graphql = () => new Response("", { status: 500 });
    const res = await pedir(sesion());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "github_error" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("timeout o respuesta inválida → 502, y si había renovado conserva la cookie nueva", async () => {
    graphql = () => { throw new DOMException("timeout", "TimeoutError"); };
    expect((await pedir(sesion())).status).toBe(502);
    graphql = () => json({ data: {} });
    const res = await pedir(sesion({ tokenVence: Date.now() + 60_000 }));
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  it("sin variables de entorno → 500", async () => {
    vi.stubEnv("SESSION_KEY", "");
    const res = await pedir(sesion());
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
