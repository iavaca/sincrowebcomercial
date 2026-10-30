import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../api/accion";
import { TEXTO_MOTIVO } from "../lib/merge";
import { COOKIE, USUARIO_PERMITIDO, abrir, sellar, type Env, type Sesion } from "../lib/sesion";

const APP = "https://bandeja.example.com";
const CLAVE = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ENV: Env = { GITHUB_APP_CLIENT_ID: "Iv1.cliente", GITHUB_APP_CLIENT_SECRET: "secreto_app", SESSION_KEY: CLAVE, APP_ORIGIN: APP };
const HORA = 3_600_000;
const SHA = "a".repeat(40);
const OTRO_SHA = "b".repeat(40);
const API = "https://api.github.com";

type Llamada = { metodo: string; url: string; cuerpo: unknown; auth: string | undefined };
type Manejador = (l: Llamada) => Response | Promise<Response>;

let errores: ReturnType<typeof vi.spyOn>;
let llamadas: Llamada[];
let rutas: Record<string, Manejador>;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const issue = (labels: string[], extra: Record<string, unknown> = {}) => (l: Llamada) =>
  json({ number: Number(l.url.split("/").pop()), state: "open", labels: labels.map((name) => ({ name })), ...extra });
const pr = (extra: Record<string, unknown> = {}, rollup: unknown = { state: "SUCCESS" }) => () =>
  json({ data: { repository: { pullRequest: { number: 7, state: "OPEN", isDraft: false, headRefOid: SHA, mergeable: "MERGEABLE",
    commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] }, ...extra } } } });

function sesion(extra: Partial<Sesion> = {}): Sesion {
  const ahora = Date.now();
  return { uid: USUARIO_PERMITIDO, token: "ghu_viejo", tokenVence: ahora + 8 * HORA, refresh: "ghr_viejo", refreshVence: ahora + 100 * HORA, inicio: ahora, ...extra };
}

type Opciones = { origen?: string | null; tipoContenido?: string; s?: Sesion | null; cuerpoCrudo?: string };
async function pedir(accion: unknown, o: Opciones = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": o.tipoContenido ?? "application/json" };
  const origen = o.origen === undefined ? APP : o.origen;
  if (origen !== null) headers.origin = origen;
  const s = o.s === undefined ? sesion() : o.s;
  if (s) headers.cookie = `${COOKIE}=${await sellar(s, CLAVE)}`;
  return POST(new Request(`${APP}/api/accion`, { method: "POST", headers, body: o.cuerpoCrudo ?? JSON.stringify(accion) }));
}

const aGitHub = () => llamadas.filter((l) => l.url.startsWith(API));
const rechazo = (motivo: keyof typeof TEXTO_MOTIVO) => ({ ok: false, motivo, texto: TEXTO_MOTIVO[motivo] });

const MERGEAR = { tipo: "mergear", repo: "claude-agents", numero: 7, sha: SHA };
const PUT_MERGE = `PUT ${API}/repos/iavaca/claude-agents/pulls/7/merge`;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  llamadas = [];
  rutas = {
    [`GET ${API}/repos/iavaca/claude-agents/issues/7`]: issue([], { pull_request: { url: "x" } }),
    [`POST ${API}/graphql`]: pr(),
    [PUT_MERGE]: () => json({ merged: true, sha: "c".repeat(40) }),
    "POST https://github.com/login/oauth/access_token": () =>
      json({ access_token: "ghu_nuevo", expires_in: 28800, refresh_token: "ghr_nuevo", refresh_token_expires_in: 15897600 }),
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const l: Llamada = { metodo: init?.method ?? "GET", url: String(url), cuerpo: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body, auth: headers.authorization };
    llamadas.push(l);
    const m = rutas[`${l.metodo} ${l.url}`];
    if (!m) throw new Error(`fetch inesperado: ${l.metodo} ${l.url}`);
    return m(l);
  }));
  errores = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  const logs = JSON.stringify(errores.mock.calls);
  for (const secreto of ["ghu_", "ghr_", "secreto_app", CLAVE]) expect(logs).not.toContain(secreto);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/accion: entrada", () => {
  it("sin Origin o con otro Origin → 403 y ninguna llamada a GitHub", async () => {
    for (const origen of [null, "null", "https://otro.example.com", `${APP}.evil.com`]) {
      const res = await pedir(MERGEAR, { origen });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(rechazo("no_permitido"));
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(llamadas).toEqual([]);
  });

  it("content-type no JSON, cuerpo > 2000 bytes o JSON roto → 400 accion_invalida sin GitHub", async () => {
    for (const o of [
      { tipoContenido: "text/plain" },
      { tipoContenido: "application/x-www-form-urlencoded" },
      { cuerpoCrudo: JSON.stringify({ ...MERGEAR, relleno: "x".repeat(2000) }) },
      { cuerpoCrudo: "{no es json" },
    ]) {
      const res = await pedir(MERGEAR, o);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(rechazo("accion_invalida"));
    }
    expect(llamadas).toEqual([]);
  });

  it("application/json; charset=utf-8 se acepta", async () => {
    const res = await pedir(MERGEAR, { tipoContenido: "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
  });

  it("sin sesión → 401 sesion_vencida", async () => {
    const res = await pedir(MERGEAR, { s: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(rechazo("sesion_vencida"));
    expect(llamadas).toEqual([]);
  });

  it("refresh imposible → 401 y borra la cookie", async () => {
    const res = await pedir(MERGEAR, { s: sesion({ tokenVence: Date.now() + 60_000, refreshVence: Date.now() - 1000 }) });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(new RegExp(`^${COOKIE}=;.*Max-Age=0`))]);
    expect(aGitHub()).toEqual([]);
  });

  it("acción inválida → 400 accion_invalida sin GitHub", async () => {
    for (const a of [{ tipo: "borrar_repo", repo: "claude-agents", numero: 7 }, { ...MERGEAR, sha: "corto" }, { ...MERGEAR, repo: "sincroweb-pedidos" }]) {
      const res = await pedir(a);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(rechazo("accion_invalida"));
    }
    expect(aGitHub()).toEqual([]);
  });

  it("sin variables de entorno → 500 sin GitHub", async () => {
    vi.stubEnv("SESSION_KEY", "");
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(llamadas).toEqual([]);
  });
});

describe("POST /api/accion: permiso según lo que dice GitHub", () => {
  it("cerrar un issue de sincroweb-pedidos sin cliente:* → 403 no_permitido", async () => {
    rutas[`GET ${API}/repos/iavaca/sincroweb-pedidos/issues/12`] = issue(["cliente:", "otra"]);
    const res = await pedir({ tipo: "cerrar", repo: "sincroweb-pedidos", numero: 12 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(rechazo("no_permitido"));
    expect(aGitHub().map((l) => l.metodo)).toEqual(["GET"]);
  });

  it("resuelto sobre un issue bandeja:comercial → 403 no_permitido", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = issue(["bandeja:comercial"]);
    const res = await pedir({ tipo: "resuelto", repo: "claude-agents", numero: 9 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(rechazo("no_permitido"));
    expect(aGitHub().map((l) => l.metodo)).toEqual(["GET"]);
  });

  it("las labels del navegador no cuentan: valen las que relee de GitHub", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = issue([]);
    const res = await pedir({ tipo: "resuelto", repo: "claude-agents", numero: 9, labels: ["bandeja:mantenimiento"] });
    expect(res.status).toBe(403);
  });

  it("enviado sobre un número que en GitHub es un PR → 403 no_permitido", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/7`] = issue(["bandeja:comercial"], { pull_request: { url: "x" } });
    const res = await pedir({ tipo: "enviado", repo: "claude-agents", numero: 7 });
    expect(res.status).toBe(403);
    expect(aGitHub()).toHaveLength(1);
  });

  it("mergear sobre un número que en GitHub es un issue → 403 sin PUT", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/7`] = issue([]);
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(403);
    expect(llamadas.map((l) => `${l.metodo} ${l.url}`)).not.toContain(PUT_MERGE);
  });

  it("issue ya cerrado → 403 no_permitido", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = issue(["bandeja:mantenimiento"], { state: "closed" });
    const res = await pedir({ tipo: "resuelto", repo: "claude-agents", numero: 9 });
    expect(res.status).toBe(403);
    expect(aGitHub()).toHaveLength(1);
  });

  it("respuesta de issue rara (sin labels) → 502 sin escribir", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = () => json({ number: 9, state: "open" });
    const res = await pedir({ tipo: "resuelto", repo: "claude-agents", numero: 9 });
    expect(res.status).toBe(502);
    expect(aGitHub()).toHaveLength(1);
  });
});

describe("POST /api/accion: mergear", () => {
  it("mergear con SHA viejo → 409 'El PR cambió, revisalo de nuevo' y no llama al PUT de merge", async () => {
    rutas[`POST ${API}/graphql`] = pr({ headRefOid: OTRO_SHA });
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(b).toEqual(rechazo("pr_cambio"));
    expect(b.texto).toBe("El PR cambió, revisalo de nuevo");
    expect(llamadas.map((l) => `${l.metodo} ${l.url}`)).not.toContain(PUT_MERGE);
  });

  it("mergear con checks FAILURE → 409 checks_rojos sin PUT", async () => {
    rutas[`POST ${API}/graphql`] = pr({}, { state: "FAILURE" });
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(rechazo("checks_rojos"));
    expect(llamadas.map((l) => `${l.metodo} ${l.url}`)).not.toContain(PUT_MERGE);
  });

  it("borrador, conflicto, calculando, estado de checks desconocido o PR cerrado → 409 sin PUT", async () => {
    const casos: [Manejador, keyof typeof TEXTO_MOTIVO][] = [
      [pr({ isDraft: true }), "no_mergeable"],
      [pr({ isDraft: undefined }), "no_mergeable"],
      [pr({ mergeable: "CONFLICTING" }), "no_mergeable"],
      [pr({ mergeable: "UNKNOWN" }), "calculando"],
      [pr({}, { state: "RARO" }), "checks_rojos"],
      [pr({ state: "MERGED" }), "pr_cambio"],
    ];
    for (const [m, motivo] of casos) {
      rutas[`POST ${API}/graphql`] = m;
      const res = await pedir(MERGEAR);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(rechazo(motivo));
    }
    expect(llamadas.map((l) => `${l.metodo} ${l.url}`)).not.toContain(PUT_MERGE);
  });

  it("mergear OK → PUT /pulls/7/merge con el sha recibido", async () => {
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const gql = aGitHub().find((l) => l.url === `${API}/graphql`)!;
    expect(gql.cuerpo).toMatchObject({ variables: { numero: 7 } });
    const put = aGitHub().filter((l) => l.metodo === "PUT");
    expect(put).toHaveLength(1);
    expect(put[0].url).toBe(`${API}/repos/iavaca/claude-agents/pulls/7/merge`);
    expect(put[0].cuerpo).toEqual({ sha: SHA, merge_method: "merge" });
    expect(put[0].auth).toBe("Bearer ghu_viejo");
  });

  it("PR sin checks (rollup null) se puede mergear", async () => {
    rutas[`POST ${API}/graphql`] = pr({}, null);
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(200);
  });

  it("GitHub responde 409 al PUT de merge → 409 pr_cambio", async () => {
    rutas[PUT_MERGE] = () => json({ message: "Head branch was modified" }, 409);
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(rechazo("pr_cambio"));
  });

  it("GitHub responde 405 al PUT de merge → 409 no_mergeable", async () => {
    rutas[PUT_MERGE] = () => json({ message: "Pull Request is not mergeable" }, 405);
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(rechazo("no_mergeable"));
  });

  it("PUT 200 sin merged:true → 502 (no se da por mergeado)", async () => {
    rutas[PUT_MERGE] = () => json({ merged: false });
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(rechazo("github_error"));
  });

  it("GraphQL con errors → 502 sin PUT", async () => {
    rutas[`POST ${API}/graphql`] = () => json({ errors: [{ message: "x" }] });
    const res = await pedir(MERGEAR);
    expect(res.status).toBe(502);
    expect(llamadas.map((l) => `${l.metodo} ${l.url}`)).not.toContain(PUT_MERGE);
  });
});

describe("POST /api/accion: pasos sobre issues", () => {
  it("enviado → POST labels y comentario 'Enviado: <fecha BA>' en ese orden", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 02:30 UTC del 3 de noviembre = 23:30 del 2 en Buenos Aires.
    vi.setSystemTime(new Date("2026-11-03T02:30:00Z"));
    try {
      rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = issue(["bandeja:comercial"]);
      rutas[`POST ${API}/repos/iavaca/claude-agents/issues/9/labels`] = () => json([], 200);
      rutas[`POST ${API}/repos/iavaca/claude-agents/issues/9/comments`] = () => json({}, 201);
      const res = await pedir({ tipo: "enviado", repo: "claude-agents", numero: 9 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(aGitHub().map((l) => [l.metodo, l.url.slice(API.length), l.cuerpo])).toEqual([
        ["GET", "/repos/iavaca/claude-agents/issues/9", undefined],
        ["POST", "/repos/iavaca/claude-agents/issues/9/labels", { labels: ["estado:enviado"] }],
        ["POST", "/repos/iavaca/claude-agents/issues/9/comments", { body: "Enviado: 2026-11-02" }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cerrar un pedido con cliente:acme → PATCH state closed", async () => {
    rutas[`GET ${API}/repos/iavaca/sincroweb-pedidos/issues/12`] = issue(["cliente:acme"]);
    rutas[`PATCH ${API}/repos/iavaca/sincroweb-pedidos/issues/12`] = () => json({}, 200);
    const res = await pedir({ tipo: "cerrar", repo: "sincroweb-pedidos", numero: 12 });
    expect(res.status).toBe(200);
    expect(aGitHub().at(-1)).toMatchObject({ metodo: "PATCH", cuerpo: { state: "closed" } });
  });

  it("pedir_cambios sobre un PR → comenta en el PR", async () => {
    rutas[`POST ${API}/repos/iavaca/claude-agents/issues/7/comments`] = () => json({}, 201);
    const res = await pedir({ tipo: "pedir_cambios", repo: "claude-agents", numero: 7, comentario: "Falta el test" });
    expect(res.status).toBe(200);
    expect(aGitHub().at(-1)).toMatchObject({ metodo: "POST", cuerpo: { body: "Falta el test" } });
  });

  it("GitHub caído en el paso 2 → 502 github_error", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = issue(["bandeja:comercial"]);
    rutas[`POST ${API}/repos/iavaca/claude-agents/issues/9/labels`] = () => json([], 200);
    rutas[`POST ${API}/repos/iavaca/claude-agents/issues/9/comments`] = () => new Response("", { status: 500 });
    const res = await pedir({ tipo: "enviado", repo: "claude-agents", numero: 9 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(rechazo("github_error"));
  });

  it("timeout al releer → 502 y no escribe", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = () => { throw new DOMException("timeout", "TimeoutError"); };
    const res = await pedir({ tipo: "resuelto", repo: "claude-agents", numero: 9 });
    expect(res.status).toBe(502);
    expect(aGitHub()).toHaveLength(1);
  });
});

describe("POST /api/accion: cookies y token", () => {
  it("token renovado → usa el nuevo y manda la cookie nueva, también en un error", async () => {
    rutas[`POST ${API}/graphql`] = pr({ headRefOid: OTRO_SHA });
    const res = await pedir(MERGEAR, { s: sesion({ tokenVence: Date.now() + 60_000 }) });
    expect(res.status).toBe(409);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const nueva = await abrir(cookies[0].slice(COOKIE.length + 1).split(";")[0], CLAVE, Date.now());
    expect(nueva).toMatchObject({ token: "ghu_nuevo", refresh: "ghr_nuevo" });
    expect(aGitHub().every((l) => l.auth === "Bearer ghu_nuevo")).toBe(true);
  });

  it("token renovado y acción OK → cookie nueva", async () => {
    const res = await pedir(MERGEAR, { s: sesion({ tokenVence: Date.now() + 60_000 }) });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  it("sin renovar → sin Set-Cookie", async () => {
    const res = await pedir(MERGEAR);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  const LLAMADAS_MERGE = [`GET ${API}/repos/iavaca/claude-agents/issues/7`, `POST ${API}/graphql`, PUT_MERGE];

  it("GitHub 401 (token revocado) en cualquier llamada → 401 y borra la cookie", async () => {
    const borrar = expect.stringMatching(new RegExp(`^${COOKIE}=;.*Max-Age=0`));
    for (const ruta of LLAMADAS_MERGE) {
      const original = rutas[ruta];
      rutas[ruta] = () => json({ message: "Bad credentials" }, 401);
      const res = await pedir(MERGEAR, { s: sesion({ tokenVence: Date.now() + 60_000 }) });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(rechazo("sesion_vencida"));
      expect(res.headers.getSetCookie()).toEqual([borrar]);
      rutas[ruta] = original;
    }
  });

  it("GitHub 403 (permiso o límite) en cualquier llamada → 502 github_sin_permiso sin borrar la sesión", async () => {
    for (const renovar of [false, true]) {
      for (const ruta of LLAMADAS_MERGE) {
        const original = rutas[ruta];
        rutas[ruta] = () => json({ message: "Resource not accessible by integration" }, 403);
        const res = await pedir(MERGEAR, { s: sesion(renovar ? { tokenVence: Date.now() + 60_000 } : {}) });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual(rechazo("github_sin_permiso"));
        const cookies = res.headers.getSetCookie();
        expect(cookies.some((c) => /Max-Age=0/.test(c))).toBe(false);
        // Si había renovado, la cookie nueva tiene que llegar igual.
        expect(cookies).toHaveLength(renovar ? 1 : 0);
        rutas[ruta] = original;
      }
    }
  });

  it("GitHub 403 en un paso de issue → 502 github_sin_permiso", async () => {
    rutas[`GET ${API}/repos/iavaca/claude-agents/issues/9`] = issue(["bandeja:mantenimiento"]);
    rutas[`PATCH ${API}/repos/iavaca/claude-agents/issues/9`] = () => json({}, 403);
    const res = await pedir({ tipo: "resuelto", repo: "claude-agents", numero: 9 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(rechazo("github_sin_permiso"));
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("nunca devuelve el token en la respuesta", async () => {
    rutas[`POST ${API}/graphql`] = () => new Response("ghu_viejo", { status: 500 });
    const res = await pedir(MERGEAR);
    expect(await res.text()).not.toContain("ghu_");
  });
});
