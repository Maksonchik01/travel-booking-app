# ADR 0002: uv workspace і npm workspaces

- Статус: прийнято (етап 0)

## Рішення
- Python: uv workspace (`apps/api`, `apps/worker`) з одним `uv.lock`. Воркер залежить
  від `tickets-api` як від пакета.
- JS: npm workspaces (`apps/web`, `packages/shared`). Потрібен npm 11, бо npm 10.9
  падає з `Cannot read properties of null (reading 'edgesOut')` на резолві
  peer-залежностей.
- Версії закріплені точно. Нові пакети беремо щонайменше двотижневої давності
  (захист від скомпрометованих релізів), крім безпекових виправлень.
