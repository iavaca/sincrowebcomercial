import type { PrItem } from "./tipos";

export type Motivo = "pr_cambio" | "checks_rojos" | "no_mergeable" | "calculando";

export const TEXTO_MOTIVO: Record<Motivo | "github_error" | "sesion_vencida" | "no_permitido" | "accion_invalida" | "config_invalida", string> = {
  pr_cambio: "El PR cambió, revisalo de nuevo",
  checks_rojos: "Checks en rojo o sin terminar",
  no_mergeable: "El PR tiene conflictos o GitHub no lo deja mergear",
  calculando: "GitHub todavía está calculando, probá en unos segundos",
  github_error: "GitHub no respondió, probá de nuevo",
  sesion_vencida: "Tu sesión venció",
  no_permitido: "Esta acción no corresponde a esta tarjeta",
  accion_invalida: "La acción no es válida, recargá la bandeja",
  config_invalida: "La bandeja está mal configurada",
};

// Decide si se puede mergear lo que Iván vio (shaVisto) contra el estado actual del PR.
// Falla cerrado: cualquier valor que no sea explícitamente bueno bloquea el merge.
// Orden: SHA → borrador/conflicto → calculando → checks; el primero que falla da el motivo.
export function puedeMergear(
  pr: Pick<PrItem, "sha" | "mergeable" | "checks" | "borrador">,
  shaVisto: string,
): { ok: true } | { ok: false; motivo: Motivo } {
  if (pr.sha === "" || shaVisto === "" || pr.sha !== shaVisto) return { ok: false, motivo: "pr_cambio" };
  if (pr.borrador !== false) return { ok: false, motivo: "no_mergeable" };
  if (pr.mergeable === "UNKNOWN") return { ok: false, motivo: "calculando" };
  if (pr.mergeable !== "MERGEABLE") return { ok: false, motivo: "no_mergeable" };
  // null = el repo no tiene checks (decisión 3): se permite.
  if (pr.checks !== null && pr.checks !== "SUCCESS") return { ok: false, motivo: "checks_rojos" };
  return { ok: true };
}
