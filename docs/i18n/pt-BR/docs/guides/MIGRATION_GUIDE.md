---
title: "Guia de atualização e migração"
version: 3.8.53
lastUpdated: 2026-09-14
---

# Guia de atualização e migração

🌐 **Idiomas:** 🇺🇸 [English](../../../../guides/MIGRATION_GUIDE.md) · 🇧🇷 Português (Brasil)

> **Resumo:** leia o changelog → faça backup do diretório de dados e da chave de criptografia → atualize pelo mesmo método usado na instalação → deixe o OmniRoute aplicar as migrações do banco na inicialização → verifique. Para voltar: restaure o backup feito antes da atualização **e** rode a versão anterior.

---

## 1. Antes de atualizar

1. **Anote o que roda hoje:** `omniroute --version` (a partir do código-fonte: `node bin/omniroute.mjs --version`), ou a tag **e o digest** da imagem Docker.
2. **Leia o que mudou** entre a sua versão e a versão alvo: [CHANGELOG](../../CHANGELOG.md) (a seção `## [Unreleased]` e uma seção por versão publicada). Atenção a variáveis de ambiente removidas ou renomeadas ([ENVIRONMENT.md](../reference/ENVIRONMENT.md)), provedores removidos ([REMOVED_PROVIDERS.md](../../../../reference/REMOVED_PROVIDERS.md), em inglês) e requisitos de runtime ([Matriz de compatibilidade](../reference/COMPATIBILITY_MATRIX.md)).
3. **Faça backup** do diretório de dados e guarde a `STORAGE_ENCRYPTION_KEY`: [Backup e restauração](../ops/BACKUP_RESTORE.md). Se você nunca definiu a chave, ela fica em `<diretório-de-dados>/server.env`, que o `omniroute backup create` não copia ([detalhes](../ops/BACKUP_RESTORE.md#segredos-e-a-chave-de-criptografia)). O OmniRoute também tira o próprio snapshot pré-migração (abaixo), mas ele cobre apenas o arquivo principal do banco.
4. **Planeje o alvo do rollback:** mantenha disponível a tag/digest da imagem anterior, a tag git ou o instalador.

---

## 2. O que acontece na primeira inicialização de uma nova versão

As migrações do banco rodam **automaticamente na inicialização**; não existe um comando de migração separado.

- `src/lib/db/core.ts` chama `runMigrations` de `src/lib/db/migrationRunner.ts` ao abrir o banco.
- Os arquivos de migração são os SQL numerados em `src/lib/db/migrations/` (`OMNIROUTE_MIGRATIONS_DIR` troca o local; `OMNIROUTE_EXTRA_MIGRATIONS_DIRS` adiciona diretórios extras).
- Antes de tocar um banco **existente**, o executor grava um snapshot endereçado por conteúdo `db_backups/db_state-<sha256>_pre-migration.sqlite` (`src/lib/db/migrationRunner/preMigrationBackup.ts`) e se recusa a migrar se esse snapshot mudar antes do uso.
- Cada migração pendente roda na própria transação e é registrada na tabela `_omniroute_migrations`. Uma migração que falha é desfeita, não é registrada, aborta a inicialização e imprime uma linha `Restore point (...)` com o nome do arquivo de snapshot.
- Verificações de segurança abortam a inicialização em vez de adivinhar: migrações renumeradas (nome aplicado diferente do arquivo em disco) são reportadas como críticas, e um número anormalmente grande de migrações pendentes num banco existente (o caso "tabela de controle apagada") é recusado, a menos que você defina `OMNIROUTE_MAX_PENDING_MIGRATIONS=0`.
- As migrações são **só para frente**: não há scripts de reversão.

Mais detalhes: [DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#migrations) (em inglês).

---

## 3. Caminhos de atualização

### Docker

Imagens: `ghcr.io/lmprado-dz23/omniroute`, com os canais e variantes listados na [Matriz de compatibilidade](../reference/COMPATIBILITY_MATRIX.md#imagens-docker-e-arquiteturas). Em produção fixe `X.Y.Z` (ou um digest); `latest`, `next` e `main` mudam.

```bash
docker pull ghcr.io/lmprado-dz23/omniroute:X.Y.Z
docker stop omniroute && docker rm omniroute          # remove o contêiner, não o volume
docker run -d --name omniroute -p 127.0.0.1:20128:20128 \
  -v omniroute-data:/app/data \
  ghcr.io/lmprado-dz23/omniroute:X.Y.Z
docker logs -f omniroute                               # acompanhe as migrações e a inicialização
```

Reutilize o mesmo volume e o mesmo ambiente (`STORAGE_ENCRYPTION_KEY`, `INITIAL_PASSWORD`, …).

**Compose:** os serviços do `docker-compose.yml` do repositório usam `build:` e marcam imagens locais (`omniroute:base`, `omniroute:web`, …). Atualizá-los significa atualizar o checkout (veja "A partir do código-fonte" abaixo para escolher a tag) e reconstruir, por exemplo `docker compose build` seguido de `docker compose up -d` com o perfil que você usa. Se o seu próprio arquivo compose aponta para a imagem do registry, troque a tag e rode `docker compose pull` e depois `docker compose up -d`.

### A partir do código-fonte

```bash
git fetch --tags
git checkout vX.Y.Z
npm ci
npm run check:node-runtime
npm run build
# reinicie o processo (npm start, seu gerenciador de serviços, PM2, …)
```

O `npm ci` é obrigatório porque as dependências mudam entre versões.

### Instalação global via npm

O nome de pacote npm `omniroute` é compartilhado com o projeto original ([Início rápido](../getting-started/QUICK-START.md#passo-1-instalar-o-omniroute)). O atualizador embutido protege contra instalar outro fork: `omniroute update --apply` só confia no "latest" do npm quando o manifesto do registry aponta para `LMPrado-DZ23/OmniRoute` (`bin/cli/commands/update.mjs`).

```bash
omniroute update --check        # sai com 0 se atualizado, 1 se desatualizado
omniroute update --dry-run      # mostra o que seria executado
omniroute update --apply        # cria um backup antes, a menos que use --no-backup
```

### App desktop (Electron)

O app usa `electron-updater` com as GitHub Releases deste repositório ([ELECTRON_GUIDE.md](../../../../guides/ELECTRON_GUIDE.md#auto-update), em inglês). Ele não baixa automaticamente; depois que você aceita, instala ao sair. Antes de instalar, grava `db_backups/pre-update-<versão>-<timestamp>/` com o banco, `server.env`, `.env` e preferências, mantendo os 3 mais recentes (`electron/lib/preUpdateSnapshot.js`).

---

## 4. Verificar a atualização

1. O log de inicialização não mostra erro de migração e o servidor continua de pé.
2. `omniroute --version` (ou a barra lateral do painel) mostra a versão alvo.
3. `curl -s http://localhost:20128/healthz` responde.
4. `curl -s http://localhost:20128/v1/models -H "Authorization: Bearer sk-your-omniroute-key"` lista seus modelos.
5. Um teste de conexão de provedor passa e uma requisição de teste aparece em **Logs** (`/dashboard/logs`).

---

## Rollback

Iniciar a versão **mais nova** de novo sobre um banco restaurado apenas reaplica as mesmas migrações, então todo rollback tem duas partes:

1. **Pare o OmniRoute.**
2. **Restaure os dados de antes da atualização:**
   - o snapshot `db_state-<sha256>_pre-migration.sqlite` citado no erro, seguindo o [DATABASE_GUIDE.md](../../../../ops/DATABASE_GUIDE.md#rolling-back-a-failed-migration), ou
   - o seu próprio backup, seguindo [Backup e restauração](../ops/BACKUP_RESTORE.md#3-procedimentos-de-restauração), ou
   - no app desktop, os arquivos em `db_backups/pre-update-<versão>-<timestamp>/`.
3. **Rode a versão anterior:**
   - Docker: inicie a tag ou digest anterior com o volume restaurado.
   - Código-fonte: `git checkout v<anterior>`, `npm ci`, `npm run build`, reinicie.
   - Servidores implantados com as ferramentas de operação: `bin/rollback.sh [<versão>] [--method npm|docker]`. Sem versão, escolhe a maior versão publicada abaixo da versão atual do `package.json`. O método `docker` remarca uma imagem `omniroute:<versão>` que já precisa existir localmente e recria o serviço a partir do `docker-compose.prod.yml`.

Se o banco restaurado veio de um estado em que o registro de migrações foi apagado, a proteção contra migrações pendentes pode abortar a inicialização; a mensagem de erro explica `OMNIROUTE_MAX_PENDING_MIGRATIONS`.

---

## Onde as mudanças incompatíveis são anunciadas

| Fonte                                                                 | O que procurar                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [CHANGELOG](../../CHANGELOG.md)                                       | Seções por versão; a seção `## [Unreleased]` para a próxima versão. |
| `changelog.d/`                                                        | Fragmentos de mudanças ainda não incorporadas ao changelog.         |
| [GitHub Releases](https://github.com/LMPrado-DZ23/OmniRoute/releases) | Notas e arquivos de cada tag.                                       |
| [ENVIRONMENT.md](../reference/ENVIRONMENT.md)                         | Variáveis de ambiente adicionadas, renomeadas ou removidas.         |
| [REMOVED_PROVIDERS.md](../../../../reference/REMOVED_PROVIDERS.md)    | Provedores que deixaram de existir (em inglês).                     |
| [Matriz de compatibilidade](../reference/COMPATIBILITY_MATRIX.md)     | Mudanças de runtime, sistema operacional e imagens.                 |
| [BRANCHING_MODEL.md](../../../../ops/BRANCHING_MODEL.md)              | De qual branch/tag vem cada versão (em inglês).                     |

Encontrou uma regressão depois de atualizar? Abra uma issue **Regression** (`.github/ISSUE_TEMPLATE/regression.yml`) informando a última versão que funcionava.
