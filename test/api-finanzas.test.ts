import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../api/finanzas.js";
import { RAMA, RUTA, VERCEL_RAMA } from "../lib/almacen-finanzas.js";
import { serializar, type Movimiento } from "../lib/finanzas.js";
import { COOKIE, sellar, type Env, type Sesion } from "../lib/sesion.js";

const APP = "https://panel.example.com";
const CLAVE = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ENV: Env = { GITHUB_APP_CLIENT_ID: "Iv1.cliente", GITHUB_APP_CLIENT_SECRET: "secreto_app", SESSION_KEY: CLAVE, APP_ORIGIN: APP };
const HORA = 3_600_000;
const R = "https://api.github.com/repos/iavaca/sincroweb-pedidos";
const CONTENTS = `${R}/contents/${RUTA}`;

type Llamada = { metodo: string; url: string; cuerpo: any };
let llamadas: Llamada[];
let rutas: Record<string, (l: Llamada) => Response>;
let errores: ReturnType<typeof vi.spyOn>;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const desdeB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

const MOV: Movimiento = { id: "m1", tipo: "cobro", fecha: "2026-11-10", monto: 100000, persona: "ivan", cliente: "cecal", concepto: "Abono", cargadoPor: "ivan", cargadoEn: "2026-11-10T12:00:00.000Z" };
const archivo = (movs: Movimiento[], sha = "s1") => () => json({ sha, encoding: "base64", content: b64(serializar(movs)) });

function sesion(uid = 100360837): Sesion {
  const ahora = Date.now();
  return { uid, token: "ghu_x", tokenVence: ahora + 8 * HORA, refresh: "ghr_x", refreshVence: ahora + 100 * HORA, inicio: ahora };
}

async function pedirGet(s: Sesion | null = sesion()) {
  const headers: Record<string, string> = {};
  if (s) headers.cookie = `${COOKIE}=${await sellar(s, CLAVE)}`;
  return GET(new Request(`${APP}/api/finanzas`, { headers }));
}

async function pedirPost(body: unknown, o: { origen?: string; s?: Sesion } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: o.origen ?? APP, cookie: `${COOKIE}=${await sellar(o.s ?? sesion(), CLAVE)}` };
  return POST(new Request(`${APP}/api/finanzas`, { method: "POST", headers, body: JSON.stringify(body) }));
}

const NUEVO = { tipo: "gasto", fecha: "2026-11-18", monto: 20000, persona: "isabella", categoria: "Dominios", concepto: "sincroweb.com.ar" };
const escrituras = () => llamadas.filter((l) => l.metodo !== "GET");

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  llamadas = [];
  rutas = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const l: Llamada = { metodo: init?.method ?? "GET", url: String(url), cuerpo: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    llamadas.push(l);
    const m = rutas[`${l.metodo} ${l.url}`];
    if (!m) throw new Error(`fetch inesperado: ${l.metodo} ${l.url}`);
    return m(l);
  }));
  errores = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  errores.mockRestore();
});

describe("GET /api/finanzas", () => {
  it("sin rama devuelve lista vacía y saldo en cero", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = () => json({ message: "No commit found" }, 404);
    rutas[`GET ${R}/git/ref/heads/${RAMA}`] = () => json({ message: "Not Found" }, 404);
    rutas[`GET ${R}`] = () => json({ private: true });
    const res = await pedirGet();
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.yo).toBe("ivan");
    expect(d.movimientos).toEqual([]);
    expect(d.saldo.transferir).toBeNull();
    expect(d.clientes.length).toBe(14);
  });

  it("con datos calcula el saldo", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = archivo([MOV]);
    const d = await (await pedirGet(sesion(75735426))).json();
    expect(d.yo).toBe("isabella");
    expect(d.saldo.transferir).toEqual({ de: "ivan", para: "isabella", monto: 50000 });
  });

  it("sin acceso al repo privado (404 en todo) → github_sin_permiso, no 'sin movimientos'", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = () => json({}, 404);
    rutas[`GET ${R}/git/ref/heads/${RAMA}`] = () => json({}, 404);
    rutas[`GET ${R}`] = () => json({ message: "Not Found" }, 404);
    const res = await pedirGet(sesion(75735426));
    expect(res.status).toBe(502);
    expect((await res.json()).motivo).toBe("github_sin_permiso");
  });

  it("archivo de más de 1 MB: lo lee del blob", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = () => json({ sha: "s1", encoding: "none", content: "" });
    rutas[`GET ${R}/git/blobs/s1`] = () => json({ sha: "s1", encoding: "base64", content: b64(serializar([MOV])) });
    const d = await (await pedirGet()).json();
    expect(d.movimientos).toEqual([MOV]);
  });

  it("un cliente que ya no está en la lista no rompe la lectura", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = archivo([{ ...MOV, cliente: "cliente-viejo" }]);
    expect((await pedirGet()).status).toBe(200);
  });

  it("archivo corrupto → 502 sin datos", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = () => json({ sha: "s1", encoding: "base64", content: b64("{roto") });
    const res = await pedirGet();
    expect(res.status).toBe(502);
  });

  it("sin sesión → 401; usuario fuera de la allowlist → 401", async () => {
    expect((await pedirGet(null)).status).toBe(401);
    expect((await pedirGet(sesion(1))).status).toBe(401);
    expect(llamadas).toEqual([]);
  });
});

describe("POST /api/finanzas", () => {
  it("primera carga: crea la rama huérfana con el archivo y vercel.json", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = () => json({}, 404);
    rutas[`GET ${R}/git/ref/heads/${RAMA}`] = () => json({}, 404);
    rutas[`GET ${R}`] = () => json({ private: true });
    rutas[`POST ${R}/git/trees`] = () => json({ sha: "t1" }, 201);
    rutas[`POST ${R}/git/commits`] = () => json({ sha: "c1" }, 201);
    rutas[`POST ${R}/git/refs`] = () => json({ ref: "refs/heads/finanzas" }, 201);
    const res = await pedirPost({ op: "agregar", movimiento: NUEVO });
    expect(await res.json()).toEqual({ ok: true });
    const [arbol, commit, ref] = escrituras();
    expect(arbol.cuerpo.tree.map((t: any) => t.path)).toEqual([RUTA, "vercel.json"]);
    expect(arbol.cuerpo.tree[1].content).toBe(VERCEL_RAMA);
    const guardado = JSON.parse(arbol.cuerpo.tree[0].content);
    expect(guardado.movimientos[0]).toMatchObject({ ...NUEVO, cargadoPor: "ivan" });
    expect(commit.cuerpo).toMatchObject({ tree: "t1", parents: [] });
    expect(ref.cuerpo).toEqual({ ref: "refs/heads/finanzas", sha: "c1" });
  });

  it("con rama: PUT con el sha leído, agrega al final", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = archivo([MOV], "s9");
    rutas[`PUT ${CONTENTS}`] = () => json({ content: {} });
    await pedirPost({ op: "agregar", movimiento: NUEVO });
    const put = escrituras()[0];
    expect(put.cuerpo).toMatchObject({ sha: "s9", branch: "finanzas", message: "Finanzas: agrega gasto (Iván)" });
    const movs = JSON.parse(desdeB64(put.cuerpo.content)).movimientos;
    expect(movs.map((m: Movimiento) => m.monto)).toEqual([100000, 20000]);
  });

  it("conflicto: relee y reintenta una vez", async () => {
    let lecturas = 0;
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = (l) => archivo([MOV], `s${++lecturas}`)();
    let puts = 0;
    rutas[`PUT ${CONTENTS}`] = () => (++puts === 1 ? json({}, 409) : json({ content: {} }));
    expect(await (await pedirPost({ op: "agregar", movimiento: NUEVO })).json()).toEqual({ ok: true });
    expect(escrituras().map((e) => e.cuerpo.sha)).toEqual(["s1", "s2"]);
  });

  it("dos conflictos seguidos → 409 conflicto", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = archivo([MOV]);
    rutas[`PUT ${CONTENTS}`] = () => json({}, 409);
    const res = await pedirPost({ op: "agregar", movimiento: NUEVO });
    expect(res.status).toBe(409);
    expect((await res.json()).motivo).toBe("conflicto");
  });

  it("borrar quita el movimiento; id inexistente → 404 sin escribir", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = archivo([MOV]);
    rutas[`PUT ${CONTENTS}`] = () => json({ content: {} });
    expect((await pedirPost({ op: "borrar", id: "nada" })).status).toBe(404);
    expect(escrituras()).toEqual([]);
    await pedirPost({ op: "borrar", id: "m1" });
    expect(JSON.parse(desdeB64(escrituras()[0].cuerpo.content)).movimientos).toEqual([]);
    expect(escrituras()[0].cuerpo.message).toBe("Finanzas: borra cobro (Iván)");
  });

  it("sin permiso de escritura en GitHub → github_sin_permiso", async () => {
    rutas[`GET ${CONTENTS}?ref=${RAMA}`] = archivo([MOV]);
    rutas[`PUT ${CONTENTS}`] = () => json({}, 403);
    const res = await pedirPost({ op: "agregar", movimiento: NUEVO }, { s: sesion(75735426) });
    expect((await res.json()).motivo).toBe("github_sin_permiso");
  });

  it("rechaza origen ajeno, datos inválidos y op desconocida sin tocar GitHub", async () => {
    expect((await pedirPost({ op: "agregar", movimiento: NUEVO }, { origen: "https://malo.example" })).status).toBe(403);
    expect((await pedirPost({ op: "agregar", movimiento: { ...NUEVO, monto: -1 } })).status).toBe(400);
    expect((await pedirPost({ op: "editar" })).status).toBe(400);
    expect(llamadas.filter((l) => l.url.startsWith("https://api.github.com"))).toEqual([]);
  });
});
