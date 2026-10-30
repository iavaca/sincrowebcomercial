import type { Item } from "./tipos";

// Los 21 agentes de iavaca/claude-agents (*.md con frontmatter).
export const AGENTES: readonly string[] = [
  "ai-engineer",
  "code-reviewer",
  "data-layer-engineer",
  "devops-platform-engineer",
  "documentation-engineer",
  "engineering-manager",
  "fullstack-engineer",
  "growth-engineer",
  "observability-sre",
  "payments-engineer",
  "performance-engineer",
  "product-manager",
  "prospect-web-auditor",
  "qa-test-engineer",
  "sales-copywriter",
  "sales-prospector",
  "security-auditor",
  "seo-engineer",
  "tech-lead-architect",
  "ux-designer",
  "web-art-director",
];

export type Accion =
  | { tipo: "enviado" | "respondio" | "resuelto"; repo: "claude-agents"; numero: number }
  | { tipo: "mergear"; repo: "claude-agents"; numero: number; sha: string }
  | { tipo: "pedir_cambios"; repo: "claude-agents"; numero: number; comentario: string }
  | { tipo: "asignar"; repo: "sincroweb-pedidos"; numero: number; agente: string }
  | { tipo: "cotizar_extra" | "cerrar"; repo: "sincroweb-pedidos"; numero: number };

export type Paso = { metodo: "POST" | "PATCH" | "PUT"; ruta: string; cuerpo: unknown };

const INVALIDA = { ok: false, error: "accion_invalida" } as const;
const DUENO = "iavaca";
const SHA_40_HEX = /^[0-9a-f]{40}$/;
// Saltos de línea y caracteres de control (incluye \u2028/\u2029 y DEL).
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const REPO_DE_TIPO: Record<Accion["tipo"], Accion["repo"]> = {
  enviado: "claude-agents",
  respondio: "claude-agents",
  resuelto: "claude-agents",
  mergear: "claude-agents",
  pedir_cambios: "claude-agents",
  asignar: "sincroweb-pedidos",
  cotizar_extra: "sincroweb-pedidos",
  cerrar: "sincroweb-pedidos",
};

function esTipo(t: unknown): t is Accion["tipo"] {
  return typeof t === "string" && Object.prototype.hasOwnProperty.call(REPO_DE_TIPO, t);
}

// Reconstruye la acción con solo los campos conocidos: lo que sobre en el body se descarta.
export function validarAccion(body: unknown): { ok: true; accion: Accion } | { ok: false; error: "accion_invalida" } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return INVALIDA;
  const b = body as Record<string, unknown>;
  const { tipo, repo, numero } = b;
  if (!esTipo(tipo) || repo !== REPO_DE_TIPO[tipo]) return INVALIDA;
  if (typeof numero !== "number" || !Number.isSafeInteger(numero) || numero <= 0) return INVALIDA;

  switch (tipo) {
    case "enviado":
    case "respondio":
    case "resuelto":
      return { ok: true, accion: { tipo, repo: "claude-agents", numero } };
    case "cotizar_extra":
    case "cerrar":
      return { ok: true, accion: { tipo, repo: "sincroweb-pedidos", numero } };
    case "mergear":
      if (typeof b.sha !== "string" || !SHA_40_HEX.test(b.sha)) return INVALIDA;
      return { ok: true, accion: { tipo, repo: "claude-agents", numero, sha: b.sha } };
    case "pedir_cambios": {
      const c = b.comentario;
      if (typeof c !== "string" || c.trim() === "" || CONTROL.test(c) || Array.from(c).length > 200) return INVALIDA;
      return { ok: true, accion: { tipo, repo: "claude-agents", numero, comentario: c } };
    }
    case "asignar":
      if (typeof b.agente !== "string" || !AGENTES.includes(b.agente)) return INVALIDA;
      return { ok: true, accion: { tipo, repo: "sincroweb-pedidos", numero, agente: b.agente } };
  }
}

// `clase` es lo que el servidor leyó de GitHub (PR o issue), nunca lo que dijo el cliente.
export function accionPermitida(accion: Accion, labels: string[], clase: Item["clase"]): boolean {
  switch (accion.tipo) {
    case "mergear":
    case "pedir_cambios":
      return clase === "pr";
    case "enviado":
    case "respondio":
      return clase === "issue" && labels.includes("bandeja:comercial");
    case "resuelto":
      return clase === "issue" && labels.includes("bandeja:mantenimiento");
    case "asignar":
    case "cotizar_extra":
    case "cerrar":
      return clase === "issue" && labels.some((l) => l.startsWith("cliente:") && l.length > "cliente:".length);
  }
}

// Las labels se suman con POST .../labels; nunca se usa el reemplazo (PUT) que pisaría las existentes.
export function pasosDeAccion(accion: Exclude<Accion, { tipo: "mergear" }>, hoy: string): Paso[] {
  const issue = `/repos/${DUENO}/${accion.repo}/issues/${accion.numero}`;
  const sumarLabel = (label: string): Paso => ({ metodo: "POST", ruta: `${issue}/labels`, cuerpo: { labels: [label] } });
  const comentar = (body: string): Paso => ({ metodo: "POST", ruta: `${issue}/comments`, cuerpo: { body } });
  const cerrarIssue: Paso = { metodo: "PATCH", ruta: issue, cuerpo: { state: "closed" } };
  const fechaOk = (): string => {
    if (!FECHA.test(hoy)) throw new Error("fecha_invalida");
    return hoy;
  };

  switch (accion.tipo) {
    case "enviado":
      return [sumarLabel("estado:enviado"), comentar(`Enviado: ${fechaOk()}`)];
    case "respondio":
      return [sumarLabel("estado:respondio"), comentar(`Respondió: ${fechaOk()}`)];
    case "asignar":
      return [sumarLabel(`agente:${accion.agente}`)];
    case "cotizar_extra":
      return [sumarLabel("extra cotizado")];
    case "cerrar":
    case "resuelto":
      return [cerrarIssue];
    case "pedir_cambios":
      return [comentar(accion.comentario)];
  }
}
