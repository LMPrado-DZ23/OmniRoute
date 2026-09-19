---
title: "Backup e restauração"
version: 3.8.54
lastUpdated: 2026-09-18
---

# Backup e restauração

🌐 **Idiomas:** 🇺🇸 [English](../../../../ops/BACKUP_RESTORE.md) · 🇧🇷 Português (Brasil)

> **Resumo:** tudo o que o OmniRoute persiste fica em um único diretório de dados. Faça backup desse diretório (de forma consistente, porque o SQLite roda em modo WAL) **e** da sua chave de criptografia. Numa instalação padrão a chave é gerada automaticamente na primeira inicialização e fica **dentro** do diretório de dados, no `server.env` (veja [Segredos e a chave de criptografia](#segredos-e-a-chave-de-criptografia)); o `omniroute backup create` **não** copia esse arquivo, então faça backup dele separadamente e mantenha-o em segredo. Esquema, detalhes do SQLite e cenários de recuperação de desastre estão no [DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#backup-and-recovery) (em inglês); esta página é o roteiro de operação.

---

## 1. Onde ficam os dados

### O diretório de dados

O servidor resolve o caminho em `src/lib/dataPaths.ts` (a CLI repete a mesma lógica em `bin/cli/data-dir.mjs`):

1. `DATA_DIR`, quando definido e não vazio.
2. Senão, um diretório `~/.omniroute` já existente é mantido (atualizações nunca movem seus dados).
3. Senão, no Windows: `%APPDATA%\omniroute`.
4. Senão, quando `XDG_CONFIG_HOME` está definido: `$XDG_CONFIG_HOME/omniroute`.
5. Senão: `~/.omniroute`.

Se um `DATA_DIR` configurado não tiver permissão de escrita (`EACCES`/`EPERM`), a inicialização volta para o diretório padrão em vez de travar (`resolveWritableDataDir` no mesmo arquivo). Confira o log de inicialização se os dados parecerem "sumidos" depois de mudar permissões.

As imagens Docker definem `DATA_DIR=/app/data` (`Dockerfile`); o `docker-compose.yml` do repositório faz o mesmo e monta um volume ali.

### O que há dentro

| Caminho (relativo ao diretório de dados)   | Conteúdo                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.sqlite`                           | Banco principal: provedores, conexões, chaves, combos, configurações, uso.                                                            |
| `storage.sqlite-wal`, `storage.sqlite-shm` | Write-ahead log e memória compartilhada do SQLite. Escritas recentes podem existir só no WAL até um checkpoint.                       |
| outros arquivos `*.sqlite`                 | Bancos irmãos, quando existem. O `bin/snapshot-data.sh` também os copia.                                                              |
| `db_backups/`                              | Backups do servidor: cópias automáticas/manuais, snapshots pré-migração e snapshots pré-atualização do app desktop.                   |
| `backups/`                                 | Backups criados pelo comando de CLI `omniroute backup create`.                                                                        |
| `call_logs/`                               | Artefatos de payload de requisições, se habilitado ([DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#database-location)).        |
| `server.env`                               | **Segredo.** Segredos gerados automaticamente na primeira inicialização (veja abaixo). Escrito por `scripts/build/bootstrap-env.mjs`. |
| `.env`                                     | **Segredo, quando existe.** Sua própria configuração, ou uma cópia do `server.env` feita pela CLI na primeira execução.               |

### Segredos e a chave de criptografia

As colunas sensíveis do banco são criptografadas com a `STORAGE_ENCRYPTION_KEY` (alias legado `OMNIROUTE_CRYPT_KEY`). Um banco restaurado não serve para essas colunas sem a mesma chave ([DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#encryption-key)).

Onde a chave fica depende de como você a configurou:

- **Você não a definiu** (instalação padrão, app desktop, Docker sem `-e STORAGE_ENCRYPTION_KEY`). Na primeira inicialização o servidor gera `STORAGE_ENCRYPTION_KEY`, `STORAGE_ENCRYPTION_KEY_VERSION`, `JWT_SECRET` e `API_KEY_SECRET` e grava tudo em `<diretório-de-dados>/server.env` (`scripts/build/bootstrap-env.mjs`). A primeira execução da CLI `omniroute` também copia o `server.env` para `<diretório-de-dados>/.env` quando o `.env` não existe (`bin/omniroute.mjs`). Ou seja, a chave **fica dentro** do diretório de dados.
- **Você mesmo a definiu** (shell, unit de serviço, `docker run -e`, um `.env` fora do diretório de dados). Nesse caso ela fica onde você a colocou e **não** está no diretório de dados; faça o backup a partir de lá.

Consequências:

- Uma cópia completa do diretório de dados (tarball, backup de volume, imagem de disco) **contém a chave e os outros segredos**. Guarde-a criptografada e com acesso restrito, como uma senha.
- `omniroute backup create` copia só `storage.sqlite`, `settings.json`, `combos.json` e `providers.json` (`bin/cli/commands/backup.mjs`); o `bin/snapshot-data.sh` copia só os arquivos `*.sqlite`. **Nenhum dos dois inclui `server.env` nem `.env`.** Restaurar qualquer um desses backups em outra máquina sem restaurar também a chave deixa todas as credenciais criptografadas ilegíveis.

**Faça backup do `server.env` com segurança** (e do `.env`, se existir), sem exibir o conteúdo:

```bash
# Linux / macOS: copia com permissão só para o dono, para um local protegido
install -m 600 "<data-dir>/server.env" /path/to/secure-backup/omniroute-server.env
```

```powershell
# Windows (PowerShell): copia para um local protegido
Copy-Item "$env:APPDATA\omniroute\server.env" "D:\secure-backup\omniroute-server.env"
```

Nunca use `cat`, não cole nem faça commit do arquivo, e não o guarde junto de um backup do banco sem criptografia. Como alternativa, copie só a linha `STORAGE_ENCRYPTION_KEY` para um gerenciador de senhas.

Para restaurar em outra máquina, coloque o arquivo de volta como `<diretório-de-dados>/server.env` (ou passe os mesmos valores pelo ambiente) **antes** da primeira inicialização. Se o servidor iniciar sem a chave enquanto existem credenciais criptografadas, ele se recusa a gerar uma nova e informa os arquivos em que procurou.

### O que **não** está dentro

- Uma chave de criptografia ou outros segredos que **você** forneceu pelo ambiente ou por um `.env` fora do diretório de dados (veja acima).
- A configuração da sua implantação (arquivos compose, units de serviço, proxy reverso). Mantenha em controle de versão ou no seu cofre de segredos.

---

## 2. Mecanismos de backup

| Mecanismo                           | Onde grava                                          | Como disparar                                                                                                                 | Observações                                                                                                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cópias de segurança do servidor     | `db_backups/db_*.sqlite`                            | Automático antes de escritas/importações (`pre-write`, `pre-import`, `pre-json-import`, …) e manual via `PUT /api/db-backups` | Fonte: `src/lib/db/backup.ts`. As cópias automáticas são limitadas (no máximo uma a cada 60 minutos), puladas para um banco menor que 4096 bytes e desligadas por `DISABLE_SQLITE_AUTO_BACKUP=true` ou pela opção de backup automático do painel. Cópias manuais sempre rodam. |
| Snapshot pré-migração               | `db_backups/db_state-<sha256>_pre-migration.sqlite` | Automático, antes de as migrações tocarem um banco existente                                                                  | Endereçado por conteúdo; veja o [Guia de atualização e migração](../guides/MIGRATION_GUIDE.md) e `src/lib/db/migrationRunner/preMigrationBackup.ts`.                                                                                                                           |
| Backups agendados                   | Job do servidor                                     | `omniroute backup auto enable --cron "0 3 * * *"`; `omniroute backup auto status` / `disable`                                 | Semântica do agendamento e variáveis: [DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#automated-backups).                                                                                                                                                                |
| Backup pela CLI                     | `backups/omniroute-backup-<id>/`                    | `omniroute backup create [--name <nome>] [--encrypt --key-file <caminho>] [--exclude <padrão>] [--retention <n>]`             | Copia `storage.sqlite` e, quando existem, `settings.json`, `combos.json`, `providers.json`, com um `backup-info.json` (`bin/cli/commands/backup.mjs`). **Não** copia `server.env`/`.env`.                                                                                      |
| Script de snapshot de operação      | `db_backups/snapshot_<UTC>[_<rótulo>]/`             | `bin/snapshot-data.sh [--label <nome>] [--data-dir <caminho>]`                                                                | Usa `sqlite3 "VACUUM INTO"` (consistente com o servidor rodando) quando o `sqlite3` está instalado; senão copia arquivos, então **pare o OmniRoute antes**. Imprime o id do snapshot.                                                                                          |
| Snapshot pré-atualização do desktop | `db_backups/pre-update-<versão>-<timestamp>/`       | Automático antes de o app desktop instalar uma atualização                                                                    | Copia o banco com WAL/SHM, `server.env`, `.env` e `electron-preferences.json`; mantém os 3 mais recentes (`electron/lib/preUpdateSnapshot.js`).                                                                                                                                |
| Backup online do SQLite             | Onde você escolher                                  | `sqlite3 <diretório-de-dados>/storage.sqlite ".backup <destino>"`                                                             | Seguro com o banco em uso ([DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#sqlite-hot-backup)).                                                                                                                                                                          |

### Retenção de `db_backups/`

A limpeza mantém os `DB_BACKUP_MAX_FILES` arquivos mais recentes (padrão 20, `MAX_DB_BACKUPS` em `src/lib/db/backupRetention.ts`) com limite de idade vindo de `DB_BACKUP_RETENTION_DAYS` (padrão `0`). Precedência para ambos: variável de ambiente, depois o valor salvo no painel, depois o padrão. `GET /api/db-backups` lista os backups; `PATCH /api/db-backups` salva as configurações de retenção.

Os scripts em `bin/` respeitam a variável de ambiente `DB_BACKUPS_DIR` (`bin/_ops-common.sh`); o servidor sempre usa `<diretório-de-dados>/db_backups` (`src/lib/db/core.ts`). Se você definir `DB_BACKUPS_DIR` para os scripts, o painel não listará esses snapshots.

### Nunca copie só o arquivo de um banco em uso

Copiar apenas `storage.sqlite` com o OmniRoute rodando pode perder escritas que ainda estão em `storage.sqlite-wal`. Use uma destas opções: `VACUUM INTO` / `.backup`, o script de snapshot com `sqlite3` instalado, os backups do painel/API/CLI, ou pare o OmniRoute e copie o diretório de dados inteiro.

---

## 3. Procedimentos de restauração

Pare os clientes antes: uma restauração substitui o banco inteiro.

### A. Painel ou API (servidor rodando)

Escolha um backup na lista de backups do painel, ou chame a API com autenticação de gerenciamento:

```bash
curl -X POST http://localhost:20128/api/db-backups \
  -H "Authorization: Bearer $MANAGEMENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"backupId": "<backup file name from GET /api/db-backups>"}'
```

### B. Backups da CLI

```bash
omniroute restore --list          # backups em <diretório-de-dados>/backups
omniroute restore <backupId>      # adicione --yes para pular a confirmação
```

### C. Scripts de operação (servidor parado)

```bash
# 1. pare o OmniRoute (serviço, contêiner ou processo)
bin/restore-data.sh <snapshot-id> --yes     # --data-dir <caminho> para um local não padrão
# 2. inicie o OmniRoute de novo
```

O `bin/restore-data.sh` primeiro copia o banco atual para `db_backups/pre-restore_<UTC>/`, apaga os arquivos `-wal`/`-shm` antigos e então copia `storage.sqlite` e os `*.sqlite` irmãos do snapshot para o lugar. Sem `--yes` ele pede confirmação e se recusa a rodar sem supervisão.

### D. Cópia manual offline

O passo a passo de cópia de um snapshot pré-migração (incluindo remover os arquivos auxiliares do WAL) está no [DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#rolling-back-a-failed-migration). O mesmo procedimento vale para qualquer arquivo `.sqlite` de backup.

---

## 4. Verificar uma restauração

Siga nesta ordem; pare na primeira falha.

1. **Integridade do arquivo** (servidor parado, `sqlite3` instalado):

   ```bash
   sqlite3 "<data-dir>/storage.sqlite" "PRAGMA integrity_check;"   # esperado: ok
   ```

2. **Inicialização:** inicie o OmniRoute e leia o log. Um erro de migração informa um ponto de restauração; veja o [Guia de atualização e migração](../guides/MIGRATION_GUIDE.md#rollback).
3. **Disponibilidade:** `curl -s http://localhost:20128/healthz`.
4. **Saúde do banco** (autenticado): `GET /api/db/health` ([DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#health-check)).
5. **Dados:** entre no painel, confira se provedores, chaves de API e combos estão lá e rode um teste de conexão de provedor.
6. **Criptografia:** se as conexões existem mas falham com erro de descriptografia, a `STORAGE_ENCRYPTION_KEY` em uso é diferente da usada quando o backup foi feito. Restaure o `server.env` correspondente (ou o valor no ambiente) e reinicie.
7. **Ponta a ponta:** `curl -s http://localhost:20128/v1/models -H "Authorization: Bearer sk-your-omniroute-key"`.

---

## 5. Volumes Docker

Com o `DATA_DIR=/app/data` da imagem e um volume nomeado (por exemplo `-v omniroute-data:/app/data`):

**Backup** (pare o contêiner para a cópia ser consistente):

```bash
docker stop omniroute
docker run --rm -v omniroute-data:/data:ro -v "$PWD":/backup alpine \
  tar -czf /backup/omniroute-data-backup.tgz -C /data .
docker start omniroute
```

**Restaurar em um volume novo** (o volume antigo fica intacto até você confirmar que está tudo certo):

```bash
docker volume create omniroute-data-restored
docker run --rm -v omniroute-data-restored:/data -v "$PWD":/backup alpine \
  tar -xzf /backup/omniroute-data-backup.tgz -C /data
docker stop omniroute && docker rm omniroute
docker run -d --name omniroute -p 127.0.0.1:20128:20128 \
  -v omniroute-data-restored:/app/data ghcr.io/lmprado-dz23/omniroute:<same-tag-as-before>
```

Depois rode as verificações da [seção 4](#4-verificar-uma-restauração). Passe a mesma `STORAGE_ENCRYPTION_KEY` (e o restante do ambiente) que você usava. Se você nunca a definiu, a chave está no `server.env` dentro do volume, então esse tarball a contém: guarde o tarball criptografado.

Com um **bind mount** (por exemplo `./data:/app/data`) dá para usar os scripts de operação a partir do host: `bin/snapshot-data.sh --data-dir ./data` e `bin/restore-data.sh <id> --data-dir ./data --yes`, com o contêiner parado durante a restauração.

Para a lista de backups do próprio app não é preciso `docker exec`: use o painel ou `PUT`/`POST /api/db-backups` pela porta publicada.

---

## Relacionados

- [DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md): esquema, migrações, WAL, recuperação de desastre (em inglês)
- [Guia de atualização e migração](../guides/MIGRATION_GUIDE.md): atualizações e rollback
- [DOCKER_GUIDE.md](../../../../guides/DOCKER_GUIDE.md): volumes, perfis do compose (em inglês)
- [Desinstalação](../guides/UNINSTALL.md): o que cada modo de desinstalação mantém ou apaga
