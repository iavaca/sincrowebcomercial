# Finanzas en el panel — diseño corto (18/11/2026)

## Para qué
Iván e Isabella (socios 50/50) cargan lo que gasta cada uno, lo que paga cada cliente y a quién le entró, y el panel les dice cuánto le tiene que transferir uno al otro para quedar mitad y mitad. La transferencia también se registra.

## Metas / no metas
- Metas: cargar gastos, cobros y transferencias desde el celular o la PC; ver el saldo al instante; borrar un movimiento mal cargado.
- No metas (por ahora): dólares u otras monedas (todo en pesos), facturación/impuestos, reportes contables, editar en el lugar (se borra y se vuelve a cargar).
- Anti-metas: datos financieros en un repo público; que una carga pise a otra sin avisar.

## Enfoques considerados
1. **Archivo JSON en el repo privado iavaca/sincroweb-pedidos, rama `finanzas`** — elegido por Iván. Sin infra ni claves nuevas, historial por commit, Isabella ya tiene (o tendrá) acceso.
2. Tabla en Supabase — más robusta, pero proyecto nuevo + clave secreta en Vercel; de más para el volumen.
3. Repo privado nuevo — separación limpia, pero requiere crear repo, instalar la App e invitar a Isabella.

## Diseño
- **Datos**: `finanzas/movimientos.json` en la rama `finanzas` (huérfana) de sincroweb-pedidos, más un `vercel.json` en esa rama con deploys desactivados para que las cargas no disparen builds. Lista de movimientos `{id, tipo: gasto|cobro|transferencia, fecha, monto (entero en pesos), persona (quien pagó / a quién le entró / quien transfirió), para (solo transferencia), cliente (slug, en cobro obligatorio, en gasto opcional), concepto, cargadoPor, cargadoEn}`.
- **Escritura**: Contents API de GitHub con el token del usuario logueado y el `sha` del archivo (si otro cargó en el medio, 409 → releer y reintentar una vez). Cada carga es un commit con autor real.
- **Cálculo**: neto de cada uno = cobrado − gastado − transferido + recibido (la plata de Sincroweb que tiene en mano). Ganancia total = cobros − gastos; a cada uno le toca la mitad. Si el neto de Iván supera la mitad, Iván transfiere la diferencia a Isabella (y al revés). Con saldo 0 muestra "Están al 50%".
- **Pantalla**: pestaña nueva **Finanzas** en el panel: arriba el saldo ("Iván le transfiere $X a Isabella" con botón "Registrar esta transferencia"), totales (cobros, gastos, ganancia, mitad de cada uno), formulario con tres solapas (Gasto / Cobro / Transferencia; "quién" arranca en la persona logueada) y la lista de movimientos del mes con filtro por mes y botón borrar.
- **Clientes**: los 13 de sincroweb-pedidos copiados como constante en el panel + opción "Otro" con nombre libre.
- **Acceso**: misma allowlist del panel; además cada uno necesita permiso de escritura en sincroweb-pedidos.

## Queda al constructor
Categorías de gasto (propuesta: Hosting y servidores, Dominios, Software y suscripciones, Publicidad, Otros), textos y estilo siguiendo los de la bandeja, tests de cálculo y validación.
