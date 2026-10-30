import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COOKIE,
  MAX_SESION_MS,
  USUARIO_PERMITIDO,
  abrir,
  abrirEstado,
  cookieBorrar,
  cookieSesion,
  leerCookie,
  leerEnv,
  necesitaRefresh,
  origenValido,
  sellar,
  sellarEstado,
  type Sesion,
} from "../lib/sesion.js";

function claveNueva(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

const CLAVE = claveNueva();
const AHORA = 1_800_000_000_000;
const MIN = 60_000;
const sesion: Sesion = {
  uid: USUARIO_PERMITIDO,
  token: "ghu_secreto",
  tokenVence: AHORA + 8 * 60 * MIN,
  refresh: "ghr_secreto",
  refreshVence: AHORA + 180 * 24 * 60 * MIN,
  inicio: AHORA,
};

function desdeB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
function aB64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("sellar/abrir", () => {
  it("sellar/abrir ida y vuelta", async () => {
    const sellado = await sellar(sesion, CLAVE);
    expect(sellado).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await abrir(sellado, CLAVE, AHORA + MIN)).toEqual(sesion);
  });

  it("usa un iv distinto en cada sellado", async () => {
    const a = await sellar(sesion, CLAVE);
    const b = await sellar(sesion, CLAVE);
    expect(a).not.toBe(b);
    expect(a.slice(0, 16)).not.toBe(b.slice(0, 16));
  });

  it("abrir devuelve null si se toca un byte, con otra clave o con basura", async () => {
    const sellado = await sellar(sesion, CLAVE);
    const bytes = desdeB64url(sellado);
    for (const i of [0, 11, 12, bytes.length - 1]) {
      const tocado = bytes.slice();
      tocado[i] ^= 1;
      expect(await abrir(aB64url(tocado), CLAVE, AHORA)).toBeNull();
    }
    expect(await abrir(sellado, claveNueva(), AHORA)).toBeNull();
    for (const basura of ["", "x", "!!!", "a".repeat(40), sellado.slice(0, 20), sellado + "€"]) {
      expect(await abrir(basura, CLAVE, AHORA)).toBeNull();
    }
  });

  it("abrir devuelve null con una clave mal formada en lugar de tirar", async () => {
    const sellado = await sellar(sesion, CLAVE);
    expect(await abrir(sellado, "corta", AHORA)).toBeNull();
    await expect(sellar(sesion, "corta")).rejects.toThrow();
  });

  it("abrir rechaza uid distinto de 100360837", async () => {
    const otro = await sellar({ ...sesion, uid: 1 }, CLAVE);
    expect(await abrir(otro, CLAVE, AHORA)).toBeNull();
  });

  it("abrir rechaza sesiones de más de 7 días", async () => {
    const sellado = await sellar(sesion, CLAVE);
    expect(await abrir(sellado, CLAVE, AHORA + MAX_SESION_MS)).not.toBeNull();
    expect(await abrir(sellado, CLAVE, AHORA + MAX_SESION_MS + 1)).toBeNull();
  });

  it("abrir rechaza un sello de estado OAuth usado como sesión", async () => {
    const estado = await sellarEstado({ estado: "abc", volver: "", vence: AHORA + 10 * MIN }, CLAVE);
    expect(await abrir(estado, CLAVE, AHORA)).toBeNull();
    const s = await sellar(sesion, CLAVE);
    expect(await abrirEstado(s, CLAVE, AHORA)).toBeNull();
  });

  it("el valor sellado no contiene el token en claro", async () => {
    const sellado = await sellar(sesion, CLAVE);
    expect(sellado).not.toContain("ghu_secreto");
    expect(sellado).not.toContain(btoa("ghu_secreto").slice(0, 8));
  });
});

describe("estado OAuth sellado", () => {
  it("ida y vuelta y vence a los 10 minutos", async () => {
    const e = { estado: "abc", volver: "#t=claude-agents-7", vence: AHORA + 10 * MIN };
    const sellado = await sellarEstado(e, CLAVE);
    expect(await abrirEstado(sellado, CLAVE, AHORA)).toEqual(e);
    expect(await abrirEstado(sellado, CLAVE, AHORA + 10 * MIN + 1)).toBeNull();
  });
});

describe("cookies", () => {
  it("cookieSesion lleva HttpOnly, Secure, SameSite=Strict, Path=/ y Max-Age=604800", () => {
    const c = cookieSesion("valor");
    expect(c.startsWith(`${COOKIE}=valor;`)).toBe(true);
    expect(COOKIE).toBe("__Host-bandeja");
    const partes = c.split(";").map((p) => p.trim());
    expect(partes).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=604800"]));
    expect(c).not.toMatch(/Domain=/i);
  });

  it("cookieBorrar vacía la cookie de sesión con Max-Age=0 y los mismos atributos", () => {
    const partes = cookieBorrar().split(";").map((p) => p.trim());
    expect(partes[0]).toBe(`${COOKIE}=`);
    expect(partes).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=0"]));
  });

  it("leerCookie encuentra la cookie por nombre exacto", () => {
    const req = new Request("https://x.test/", { headers: { cookie: "otra=1; __Host-bandeja-estado=e; __Host-bandeja=abc_-1; z=" } });
    expect(leerCookie(req, "__Host-bandeja")).toBe("abc_-1");
    expect(leerCookie(req, "__Host-bandeja-estado")).toBe("e");
    expect(leerCookie(req, "falta")).toBeUndefined();
    expect(leerCookie(new Request("https://x.test/"), "__Host-bandeja")).toBeUndefined();
  });
});

describe("origenValido", () => {
  const APP = "https://bandeja.example.com";
  const con = (origin?: string) => new Request(`${APP}/api/logout`, { method: "POST", headers: origin === undefined ? {} : { origin } });
  it("origenValido: igual → true; otro, ausente o 'null' → false", () => {
    expect(origenValido(con(APP), APP)).toBe(true);
    expect(origenValido(con("https://evil.com"), APP)).toBe(false);
    expect(origenValido(con(`${APP}.evil.com`), APP)).toBe(false);
    expect(origenValido(con("http://bandeja.example.com"), APP)).toBe(false);
    expect(origenValido(con(), APP)).toBe(false);
    expect(origenValido(con("null"), APP)).toBe(false);
  });
});

describe("necesitaRefresh", () => {
  it("necesitaRefresh a 4 min del vencimiento sí, a 10 min no", () => {
    expect(necesitaRefresh({ ...sesion, tokenVence: AHORA + 4 * MIN }, AHORA)).toBe(true);
    expect(necesitaRefresh({ ...sesion, tokenVence: AHORA + 10 * MIN }, AHORA)).toBe(false);
    expect(necesitaRefresh({ ...sesion, tokenVence: AHORA - MIN }, AHORA)).toBe(true);
  });
});

describe("leerEnv", () => {
  afterEach(() => vi.unstubAllEnvs());
  const completo = {
    GITHUB_APP_CLIENT_ID: "Iv1.abc",
    GITHUB_APP_CLIENT_SECRET: "secreto",
    SESSION_KEY: CLAVE,
    APP_ORIGIN: "https://bandeja.example.com",
  };
  const poner = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  };

  it("devuelve las cuatro variables si están todas bien", () => {
    poner(completo);
    expect(leerEnv()).toEqual(completo);
  });

  it("null si falta alguna, si la clave no son 32 bytes o si APP_ORIGIN no es un origin https", () => {
    for (const k of Object.keys(completo)) {
      poner({ ...completo, [k]: "" });
      expect(leerEnv()).toBeNull();
    }
    for (const mala of ["corta", btoa("x".repeat(16)), "no es base64!"]) {
      poner({ ...completo, SESSION_KEY: mala });
      expect(leerEnv()).toBeNull();
    }
    for (const mala of ["https://bandeja.example.com/", "http://bandeja.example.com", "https://bandeja.example.com/x", "bandeja.example.com"]) {
      poner({ ...completo, APP_ORIGIN: mala });
      expect(leerEnv()).toBeNull();
    }
  });
});
