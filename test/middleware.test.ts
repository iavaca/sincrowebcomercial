import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import middleware from "../middleware.js";
import { COOKIE, USUARIO_PERMITIDO, sellar, type Sesion } from "../lib/sesion.js";

const APP = "https://panel.example.com";
const CLAVE = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const HORA = 3_600_000;

function sesion(extra: Partial<Sesion> = {}): Sesion {
  const ahora = Date.now();
  return { uid: USUARIO_PERMITIDO, token: "ghu_x", tokenVence: ahora + 8 * HORA, refresh: "ghr_x", refreshVence: ahora + 100 * HORA, inicio: ahora, ...extra };
}

const pedir = (cookie?: string) => middleware(new Request(`${APP}/finanzas.html`, { headers: cookie ? { cookie } : {} }));
const esLogin = (r: Response) => r.status === 302 && r.headers.get("location") === "/api/login";

beforeEach(() => {
  for (const [k, v] of Object.entries({ GITHUB_APP_CLIENT_ID: "Iv1.x", GITHUB_APP_CLIENT_SECRET: "s", SESSION_KEY: CLAVE, APP_ORIGIN: APP })) vi.stubEnv(k, v);
});
afterEach(() => vi.unstubAllEnvs());

describe("middleware de páginas", () => {
  it("sin cookie redirige al login antes de servir la página", async () => {
    expect(esLogin(await pedir())).toBe(true);
  });

  it("cookie inválida, vencida o de otro usuario → login", async () => {
    expect(esLogin(await pedir(`${COOKIE}=basura`))).toBe(true);
    expect(esLogin(await pedir(`${COOKIE}=${await sellar(sesion({ inicio: Date.now() - 8 * 24 * HORA }), CLAVE)}`))).toBe(true);
    expect(esLogin(await pedir(`${COOKIE}=${await sellar(sesion({ uid: 1 }), CLAVE)}`))).toBe(true);
  });

  it("con sesión válida deja pasar", async () => {
    const r = await pedir(`${COOKIE}=${await sellar(sesion(), CLAVE)}`);
    expect(esLogin(r)).toBe(false);
    expect(r.headers.get("x-middleware-next")).toBe("1");
  });

  it("solo corre en las páginas, no en /api ni en los assets", async () => {
    const { config } = await import("../middleware.js");
    expect(config.matcher).toEqual(["/", "/index.html", "/finanzas.html"]);
  });
});
