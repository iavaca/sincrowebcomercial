import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/graphql.json";
import { CONSULTA, consultarGraphQL, llamarGitHub, mapearChecks, normalizar } from "../lib/github.js";

const datos = () => structuredClone(fixture.data) as Record<string, any>;

afterEach(() => vi.unstubAllGlobals());

describe("CONSULTA", () => {
  it("es una sola consulta que lee cada repositorio directo, sin search", () => {
    expect(CONSULTA).not.toContain("search(");
    expect(CONSULTA).toContain('agentes: repository(owner: "iavaca", name: "claude-agents")');
    expect(CONSULTA).toContain('pedidos: repository(owner: "iavaca", name: "sincroweb-pedidos")');
    expect(CONSULTA).toContain("prs: pullRequests(states: OPEN, first: 100) { totalCount nodes {");
    expect(CONSULTA).toContain('comercial: issues(states: OPEN, first: 100, labels: ["bandeja:comercial"]) { totalCount');
    expect(CONSULTA).toContain('mantenimiento: issues(states: OPEN, first: 100, labels: ["bandeja:mantenimiento"]) { totalCount');
    expect(CONSULTA).toContain("issues: issues(states: OPEN, first: 100) { totalCount nodes {");
    expect(CONSULTA).not.toContain("... on ");
  });
});

describe("normalizar", () => {
  it("devuelve PRs e issues con los campos de Item", () => {
    const { items, truncado } = normalizar(datos());
    expect(truncado).toBe(false);
    expect(items.map((i) => `${i.repo}#${i.numero}`)).toEqual([
      "claude-agents#12", "claude-agents#13", "claude-agents#5", "claude-agents#7", "sincroweb-pedidos#30",
    ]);
    expect(items[0]).toEqual({
      clase: "pr", repo: "claude-agents", numero: 12, titulo: "Agente nuevo de ejemplo", cuerpo: "Suma un agente",
      creado: "2026-10-28T10:00:00Z", url: "https://github.com/iavaca/claude-agents/pull/12", sha: "abc123",
      mergeable: "MERGEABLE", checks: "SUCCESS", archivos: ["agentes/uno.md", "agentes/dos.md"], archivosTotal: 2, borrador: false,
    });
    expect(items[3]).toEqual({
      clase: "issue", repo: "claude-agents", numero: 7, titulo: "Sitio caído de Ferretería Ejemplo", cuerpo: "",
      creado: "2026-10-30T08:00:00Z", url: "https://github.com/iavaca/claude-agents/issues/7",
      labels: ["bandeja:mantenimiento", "cliente:ferreteria-ejemplo", "nivel:rojo"],
    });
  });

  it("deja afuera los issues de sincroweb-pedidos sin cliente:*", () => {
    const { items } = normalizar(datos());
    expect(items.some((i) => i.repo === "sincroweb-pedidos" && i.numero === 31)).toBe(false);
  });

  it("statusCheckRollup null → checks null, y el borrador se marca", () => {
    const pr = normalizar(datos()).items[1];
    expect(pr).toMatchObject({ clase: "pr", checks: null, borrador: true, mergeable: "UNKNOWN" });
  });

  it("un issue con las dos labels bandeja:* aparece una sola vez", () => {
    const d = datos();
    d.agentes.mantenimiento.nodes.push(structuredClone(d.agentes.comercial.nodes[0]));
    expect(normalizar(d).items.filter((i) => i.numero === 5)).toHaveLength(1);
  });

  it("ignora nodos null o vacíos", () => {
    const d = datos();
    d.agentes.prs.nodes.push({}, null);
    expect(normalizar(d).items).toHaveLength(5);
  });

  it("trunca si un bloque tiene más resultados que los traídos", () => {
    const d = datos();
    d.pedidos.issues.totalCount = 101;
    expect(normalizar(d).truncado).toBe(true);
    const e = datos();
    e.agentes.comercial.totalCount = 3; // hay 1 nodo
    expect(normalizar(e).truncado).toBe(true);
  });

  it("trunca si un PR tiene más de 20 archivos y conserva el total", () => {
    const d = datos();
    d.agentes.prs.nodes[0].files.totalCount = 35;
    const r = normalizar(d);
    expect(r.truncado).toBe(true);
    expect(r.items[0]).toMatchObject({ archivosTotal: 35 });
  });

  it("lanza un error controlado ante {}, null o un bloque roto", () => {
    expect(() => normalizar({})).toThrow(/respuesta_invalida/);
    expect(() => normalizar(null)).toThrow(/respuesta_invalida/);
    expect(() => normalizar(undefined)).toThrow(/respuesta_invalida/);
    const d = datos();
    d.pedidos.issues.nodes[0].number = "x";
    expect(() => normalizar(d)).toThrow(/respuesta_invalida/);
    const e = datos();
    delete e.agentes.mantenimiento;
    expect(() => normalizar(e)).toThrow(/respuesta_invalida/);
    const f = datos();
    f.pedidos.issues.totalCount = "2";
    expect(() => normalizar(f)).toThrow(/respuesta_invalida/);
  });

  it("lanza si un repositorio viene null (sin acceso o inexistente), nunca devuelve vacío", () => {
    for (const repo of ["agentes", "pedidos"]) {
      const d = datos();
      d[repo] = null;
      expect(() => normalizar(d)).toThrow(/respuesta_invalida/);
    }
  });
});

describe("mapearChecks", () => {
  it("mapea cada estado conocido, null sin rollup y PENDING ante uno desconocido", () => {
    for (const s of ["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]) expect(mapearChecks({ state: s })).toBe(s);
    expect(mapearChecks(null)).toBeNull();
    expect(mapearChecks(undefined)).toBeNull();
    expect(mapearChecks({ state: "NUEVO" })).toBe("PENDING");
  });
});

describe("llamarGitHub / consultarGraphQL", () => {
  it("llama a la API REST con los headers y el timeout", async () => {
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    await llamarGitHub("ghu_x", "PUT", "/repos/iavaca/x/pulls/1/merge", { a: 1 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/iavaca/x/pulls/1/merge");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ authorization: "Bearer ghu_x", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "sincroweb-bandeja" });
  });

  it("devuelve data; lanza ante HTTP no OK o errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { ok: 1 } }))));
    expect(await consultarGraphQL("t", "query{}")).toEqual({ ok: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(consultarGraphQL("t", "q")).rejects.toThrow("github_http_500");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: null, errors: [{ message: "x" }] }))));
    await expect(consultarGraphQL("t", "q")).rejects.toThrow("github_graphql_errors");
  });
});
