import type { Checks, IssueItem, Item, PrItem, Repo } from "./tipos.js";

const TIMEOUT_MS = 8000;
const MAX_RESULTADOS = 100;
const MAX_ARCHIVOS = 20;
const API = "https://api.github.com";

const CAMPOS_ISSUE = "number title body createdAt url labels(first: 20) { nodes { name } }";
const CAMPOS_PR = `number title body createdAt url isDraft headRefOid mergeable
  files(first: ${MAX_ARCHIVOS}) { totalCount nodes { path } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

// `filtro` va dentro de los argumentos de la conexión (p. ej. labels).
const bloque = (alias: string, conexion: string, filtro: string, campos: string) =>
  `${alias}: ${conexion}(states: OPEN, first: ${MAX_RESULTADOS}${filtro}) { totalCount nodes { ${campos} } }`;

// Una sola request leyendo cada repositorio directo: `search` devuelve 0 resultados con el token de usuario de la GitHub App.
// Comercial y mantenimiento van en bloques separados, uno por bandeja; un issue con las dos labels se deduplica al normalizar.
export const CONSULTA = `query Bandeja {
  agentes: repository(owner: "iavaca", name: "claude-agents") {
    ${bloque("prs", "pullRequests", "", CAMPOS_PR)}
    ${bloque("comercial", "issues", ', labels: ["bandeja:comercial"]', CAMPOS_ISSUE)}
    ${bloque("mantenimiento", "issues", ', labels: ["bandeja:mantenimiento"]', CAMPOS_ISSUE)}
  }
  pedidos: repository(owner: "iavaca", name: "sincroweb-pedidos") {
    ${bloque("issues", "issues", "", CAMPOS_ISSUE)}
  }
}`;

const ESTADOS_CHECKS = ["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"] as const;

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function invalido(que: string): never {
  throw new Error(`respuesta_invalida: ${que}`);
}

// Sin rollup (el PR no tiene checks) → null. Un estado desconocido cuenta como PENDING: nunca como verde.
// La Task 7 reutiliza esta función para leer un solo PR.
export function mapearChecks(rollup: unknown): Checks {
  if (!esObjeto(rollup)) return null;
  const estado = rollup.state;
  return ESTADOS_CHECKS.find((e) => e === estado) ?? "PENDING";
}

function texto(v: unknown, campo: string): string {
  if (typeof v !== "string") invalido(campo);
  return v;
}

function numero(v: unknown, campo: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) invalido(campo);
  return v;
}

function lista(v: unknown, campo: string): unknown[] {
  if (!Array.isArray(v)) invalido(campo);
  return v;
}

function basePr(n: Record<string, unknown>): PrItem {
  const files = esObjeto(n.files) ? n.files : invalido("files");
  const commits = lista(esObjeto(n.commits) ? n.commits.nodes : undefined, "commits");
  const ultimo = esObjeto(commits[0]) && esObjeto(commits[0].commit) ? commits[0].commit : undefined;
  const mergeable = n.mergeable === "MERGEABLE" || n.mergeable === "CONFLICTING" ? n.mergeable : "UNKNOWN";
  return {
    clase: "pr",
    repo: "claude-agents",
    numero: numero(n.number, "number"),
    titulo: texto(n.title, "title"),
    cuerpo: typeof n.body === "string" ? n.body : "",
    creado: texto(n.createdAt, "createdAt"),
    url: texto(n.url, "url"),
    sha: texto(n.headRefOid, "headRefOid"),
    mergeable,
    checks: mapearChecks(ultimo?.statusCheckRollup),
    archivos: lista(files.nodes, "files.nodes").map((f) => texto(esObjeto(f) ? f.path : undefined, "path")),
    archivosTotal: numero(files.totalCount, "files.totalCount"),
    borrador: n.isDraft === true,
  };
}

function baseIssue(n: Record<string, unknown>, repo: Repo): IssueItem {
  const nodos = lista(esObjeto(n.labels) ? n.labels.nodes : undefined, "labels");
  return {
    clase: "issue",
    repo,
    numero: numero(n.number, "number"),
    titulo: texto(n.title, "title"),
    cuerpo: typeof n.body === "string" ? n.body : "",
    labels: nodos.map((l) => texto(esObjeto(l) ? l.name : undefined, "label")),
    creado: texto(n.createdAt, "createdAt"),
    url: texto(n.url, "url"),
  };
}

type Busqueda = { nodos: Record<string, unknown>[]; truncada: boolean };

// `repository: null` (sin acceso o inexistente) lanza como cualquier bloque faltante.
function leerRepositorio(data: Record<string, unknown>, alias: string): Record<string, unknown> {
  const r = data[alias];
  if (!esObjeto(r)) invalido(alias);
  return r;
}

function leerBusqueda(repo: Record<string, unknown>, alias: string): Busqueda {
  const b = repo[alias];
  if (!esObjeto(b)) invalido(alias);
  const nodos = lista(b.nodes, `${alias}.nodes`);
  const total = numero(b.totalCount, `${alias}.totalCount`);
  // Un nodo null o vacío (p. ej. un ítem sin acceso) no es un ítem: se ignora.
  return { nodos: nodos.filter((n): n is Record<string, unknown> => esObjeto(n) && "number" in n), truncada: total > MAX_RESULTADOS || total > nodos.length };
}

// Una respuesta incompleta lanza: devolver [] se leería como "no hay nada pendiente".
export function normalizar(data: unknown): { items: Item[]; truncado: boolean } {
  if (!esObjeto(data)) invalido("data");
  const repoAgentes = leerRepositorio(data, "agentes");
  const repoPedidos = leerRepositorio(data, "pedidos");
  const prs = leerBusqueda(repoAgentes, "prs");
  const comercial = leerBusqueda(repoAgentes, "comercial");
  const mantenimiento = leerBusqueda(repoAgentes, "mantenimiento");
  const pedidos = leerBusqueda(repoPedidos, "issues");

  const prItems = prs.nodos.map(basePr);
  const vistos = new Set<number>();
  const agentes: IssueItem[] = [];
  for (const n of [...comercial.nodos, ...mantenimiento.nodos]) {
    const item = baseIssue(n, "claude-agents");
    if (vistos.has(item.numero)) continue; // un issue con las dos labels sale en ambas búsquedas
    vistos.add(item.numero);
    agentes.push(item);
  }
  const deClientes = pedidos.nodos.map((n) => baseIssue(n, "sincroweb-pedidos")).filter((i) => i.labels.some((l) => l.startsWith("cliente:")));

  const truncado = [prs, comercial, mantenimiento, pedidos].some((b) => b.truncada) || prItems.some((p) => p.archivosTotal > MAX_ARCHIVOS);
  return { items: [...prItems, ...agentes, ...deClientes], truncado };
}

export async function llamarGitHub(token: string, metodo: string, ruta: string, cuerpo?: unknown): Promise<Response> {
  return fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "sincroweb-bandeja",
      ...(cuerpo === undefined ? {} : { "content-type": "application/json" }),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// Devuelve `data`. Lanza ante HTTP no OK, timeout, cuerpo ilegible o `errors` (GraphQL responde 200 con errores).
export async function consultarGraphQL(token: string, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const respuesta = await llamarGitHub(token, "POST", "/graphql", { query, variables });
  if (!respuesta.ok) throw new Error(`github_http_${respuesta.status}`);
  const cuerpo: unknown = await respuesta.json();
  if (!esObjeto(cuerpo)) invalido("cuerpo");
  if (Array.isArray(cuerpo.errors) && cuerpo.errors.length > 0) throw new Error("github_graphql_errors");
  return cuerpo.data;
}
