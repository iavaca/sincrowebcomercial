import type { TEXTO_MOTIVO } from "./merge.js";

export type MotivoRespuesta = keyof typeof TEXTO_MOTIVO;

// Corta el flujo con una respuesta concreta; cualquier otro error termina en 502.
export class Rechazo extends Error {
  constructor(readonly status: number, readonly motivo: MotivoRespuesta) {
    super(motivo);
  }
}

// 401 = token revocado: sesión vencida. 403 = permiso de la App o rate limit: la sesión sigue siendo válida.
export function rechazoPorStatus(status: number): Rechazo | null {
  if (status === 401) return new Rechazo(401, "sesion_vencida");
  if (status === 403) return new Rechazo(502, "github_sin_permiso");
  return null;
}

// consultarGraphQL falla con `github_http_<status>` cuando GitHub responde no-2xx.
export function statusDeError(error: unknown): number | undefined {
  const m = error instanceof Error ? /^github_http_(\d{3})$/.exec(error.message)?.[1] : undefined;
  return m ? Number(m) : undefined;
}
