---
title: "Matriz de compatibilidade"
version: 3.8.54
lastUpdated: 2026-09-14
---

# Matriz de compatibilidade

🌐 **Idiomas:** 🇺🇸 [English](../../../../reference/COMPATIBILITY_MATRIX.md) · 🇧🇷 Português (Brasil)

> **Leia primeiro.** Cada linha diz **como** sabemos. Uma linha só é "testada em CI" quando um workflow em `.github/workflows/` a executa; o resto é declarado ou não verificado. Quando um workflow muda, esta página precisa mudar junto.

## Legenda

| Status                    | Significado                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Testado (por PR)**      | Roda no `ci.yml` / `quality.yml` em pull requests e pushes.                                                                |
| **Testado (noturno)**     | Roda de forma agendada (`nightly-*.yml`) contra o branch de release ativo, não em todo PR.                                 |
| **Construído no release** | Construído (e em alguns casos com smoke test) por um workflow de release/publicação; não passa pelas suítes de teste.      |
| **Melhor esforço**        | Roda em CI com `continue-on-error`, então uma falha não bloqueia.                                                          |
| **Declarado**             | Permitido pelo `engines` do `package.json`, por verificações de runtime ou pela documentação, mas nenhum workflow executa. |
| **Não suportado**         | Rejeitado pela verificação de runtime ou explicitamente fora de escopo.                                                    |

---

## Node.js e outros runtimes

Faixa declarada (`engines` do `package.json`): `>=22.22.2 <23 || >=24.0.0 <27`. A mesma faixa e o mínimo seguro por linha principal (22.22.2, 24.0.0, 25.0.0, 26.0.0) são aplicados por `bin/nodeRuntimeSupport.mjs`; `npm run check:node-runtime` (`scripts/check/check-supported-node-runtime.ts`) sai com erro fora dela. Versão recomendada nesse arquivo: `24.14.1`.

| Runtime                      | Status                                                       | Evidência                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24.x                 | **Testado (por PR)**                                         | O `ci.yml` define CI_NODE_VERSION como `"24"` para build, shards de testes unitários e shards de E2E; `build.yml`, `api-route-typecheck.yml` e `dast-smoke.yml` usam `node-version: "24"`; o `electron-release.yml` compila com Node 24.                                                                                  |
| Node.js 26.x                 | **Testado (noturno)**                                        | `nightly-compat.yml`: `compat-tests` roda a suíte unitária (4 shards) em Node 24 e 26 mais `npm run check:node-runtime`; `compat-build-26` roda `npm run build` em Node 26 com `OMNIROUTE_USE_TURBOPACK=0` (fallback para webpack). A imagem base de runtime Docker é Node 26 (`Dockerfile`, `FROM node:26-trixie-slim`). |
| Node.js 25.x                 | **Declarado**                                                | Dentro da faixa do `engines` e listado em `bin/nodeRuntimeSupport.mjs`; nenhum workflow usa Node 25.                                                                                                                                                                                                                      |
| Node.js 22.x (>= 22.22.2)    | **Declarado**                                                | Dentro da faixa do `engines`; nenhum workflow em `.github/workflows/` usa Node 22.                                                                                                                                                                                                                                        |
| Node.js 23.x, <= 21.x, >= 27 | **Não suportado**                                            | Fora da faixa do `engines`; rejeitado por `check:node-runtime`.                                                                                                                                                                                                                                                           |
| Bun (caminho SQLite)         | **Testado (por PR)** no Linux, **Melhor esforço** no Windows | O job `test-bun-sqlite` do `ci.yml` roda em `ubuntu-latest` e `windows-latest`, com `continue-on-error` no Windows. O `bin/nodeRuntimeSupport.mjs` considera o Bun suportado a partir da versão 1.1.                                                                                                                      |

## Sistemas operacionais

| SO                   | Status                             | Evidência                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (x64)          | **Testado (por PR)**               | Os jobs de teste, build e E2E do `ci.yml` rodam em `ubuntu-latest` (ou no runner Linux self-hosted de build, quando habilitado).                                                                                                                                                                              |
| Windows (x64)        | **Testado (por PR)**, parcial      | O `electron-package-smoke` do `ci.yml` roda em `windows-latest` (preparação do bundle, incluindo a verificação do prebuild do `better-sqlite3`; o empacotamento completo e o smoke headless rodam no Ubuntu). O `test-bun-sqlite` no Windows é melhor esforço. As suítes unitária e E2E não rodam no Windows. |
| macOS (Intel, arm64) | **Construído no release**          | Só o `electron-release.yml` usa runners macOS (`macos-15-intel`, `macos-latest`). O smoke em arm64 é `continue-on-error`. Não há job macOS por PR.                                                                                                                                                            |
| Linux arm64          | **Construído no release** (Docker) | O `docker-publish.yml` constrói imagens `linux/arm64` em `ubuntu-24.04-arm`. Nenhuma suíte de teste roda em arm64.                                                                                                                                                                                            |
| Android (Termux)     | **Declarado**                      | Documentado no [TERMUX_GUIDE.md](../../../../guides/TERMUX_GUIDE.md) (em inglês); nenhum workflow.                                                                                                                                                                                                            |

## Métodos de instalação

| Método                                           | Status                                          | Evidência / observações                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Código-fonte (`npm ci && npm run build`)         | **Testado (por PR)**                            | Job de build do `ci.yml` em Node 24.                                                                                                                                                                                                                                                                                                                 |
| Imagem Docker (`ghcr.io/lmprado-dz23/omniroute`) | **Construído no release**, com checagem de boot | O `docker-publish.yml` constrói e publica a imagem, depois a inicia e exige que `http://127.0.0.1:20128/healthz` responda antes de manter a tag publicada.                                                                                                                                                                                           |
| App desktop Electron                             | **Construído no release**                       | O `electron-release.yml` gera Windows, macOS (Intel e arm64) e Linux; o smoke no Windows e no macOS arm64 é melhor esforço. O [Início rápido](../getting-started/QUICK-START.md) informa que os instaladores ainda não estão publicados nas Releases deste fork.                                                                                     |
| npm global (`npm install -g omniroute`)          | **Declarado / não é este fork**                 | O nome de pacote npm `omniroute` é compartilhado com o projeto original e, segundo o [Início rápido](../getting-started/QUICK-START.md), instala o projeto original. O `npm-publish.yml` existe neste repositório; `omniroute update --apply` só confia no registry quando o manifesto aponta para este repositório (`bin/cli/commands/update.mjs`). |
| pnpm, AUR, template Void, Podman                 | **Declarado**                                   | Documentados no [SETUP_GUIDE.md](../../../../guides/SETUP_GUIDE.md) (em inglês) e em `contrib/`; nenhum workflow.                                                                                                                                                                                                                                    |

## Imagens Docker e arquiteturas

Fonte: `.github/workflows/docker-publish.yml` e `scripts/ci/resolve-docker-publish-version.sh`.

| Variante (sufixo da tag) | Dockerfile / target                   | Arquiteturas                 | Status                                                           |
| ------------------------ | ------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| _(nenhum)_               | `Dockerfile`                          | `linux/amd64`, `linux/arm64` | **Construído no release**, checagem de boot em `/healthz`        |
| `-web`                   | `Dockerfile`, target `runner-web`     | `linux/amd64`, `linux/arm64` | **Construído no release**                                        |
| `-bun`                   | `Dockerfile.bun`                      | `linux/amd64`, `linux/arm64` | **Construído no release**, opcional (a publicação segue sem ela) |
| `-web-bun`               | `Dockerfile.bun`, target `runner-web` | `linux/amd64`, `linux/arm64` | **Construído no release**, opcional                              |

Canais (a tag antes do sufixo):

| Tag      | Gerada quando                                                                       | Mutável |
| -------- | ----------------------------------------------------------------------------------- | ------- |
| `X.Y.Z`  | Push de uma tag `v*`, uma GitHub Release ou um disparo manual com versão            | Não     |
| `latest` | Promovida apenas para SemVer estável (identificadores de pré-release são ignorados) | Sim     |
| `next`   | Push no branch `release/v*` que é o branch padrão atual do repositório              | Sim     |
| `main`   | Push no `main`                                                                      | Sim     |

Pushes em um branch `release/v*` que não é o branch padrão não publicam nada. Mais detalhes: [DOCKER_GUIDE.md](../../../../guides/DOCKER_GUIDE.md#release-channels) (em inglês).

## Protocolos de cliente e endpoints

Todo endpoint abaixo tem um handler de rota em `src/app/api/`. `/v1/*` e `/v1beta/*` são reescritos para `/api/v1/*` e `/api/v1beta/*` pelo `next.config.mjs`. As duas colunas de teste vêm de uma busca textual pelo caminho em `tests/` e `tests/e2e/`: mostram que o caminho é **referenciado** por testes, não que todos os recursos do protocolo estejam cobertos.

| Protocolo / formato do cliente       | Endpoint(s)                                                                                               | Local da rota                              | Referenciado em `tests/`     | Referenciado em `tests/e2e/` |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------- | ---------------------------- |
| OpenAI Chat Completions              | `POST /v1/chat/completions`                                                                               | `src/app/api/v1/chat/completions/route.ts` | Sim                          | Sim                          |
| OpenAI Responses                     | `POST /v1/responses` (+ subcaminhos)                                                                      | `src/app/api/v1/responses/route.ts`        | Sim                          | Sim                          |
| Anthropic Messages                   | `POST /v1/messages`, `POST /v1/messages/count_tokens`                                                     | `src/app/api/v1/messages/route.ts`         | Sim                          | Sim                          |
| Listagem de modelos (formato OpenAI) | `GET /v1/models`                                                                                          | `src/app/api/v1/models/route.ts`           | Sim                          | Sim                          |
| Google Gemini (`v1beta`)             | `/v1beta/models/...`                                                                                      | `src/app/api/v1beta/models/`               | Sim                          | Não                          |
| OpenAI Completions (legado)          | `POST /v1/completions`                                                                                    | `src/app/api/v1/completions/route.ts`      | Sim                          | Não                          |
| Embeddings                           | `POST /v1/embeddings`                                                                                     | `src/app/api/v1/embeddings/route.ts`       | Sim                          | Não                          |
| Ponte WebSocket                      | `/v1/ws`                                                                                                  | `src/app/api/v1/ws/route.ts`               | Sim                          | Não                          |
| Chat no estilo Ollama                | `POST /v1/api/chat`                                                                                       | `src/app/api/v1/api/chat/route.ts`         | não verificado               | não verificado               |
| Imagens / áudio / moderação / rerank | `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/moderations`, `/v1/rerank` | `src/app/api/v1/`                          | não verificado               | não verificado               |
| MCP (Model Context Protocol)         | Transporte SSE em `/api/mcp/sse`; stdio via `bin/mcp-server.mjs`                                          | `src/app/api/mcp/`                         | Sim (`api/mcp`)              | Sim (`api/mcp`)              |
| A2A (Agent-to-Agent, JSON-RPC)       | `POST /a2a`                                                                                               | `src/app/a2a/route.ts`                     | Nenhuma ocorrência de `/a2a` | Não                          |

Detalhes dos protocolos: [Referência da API](API_REFERENCE.md), [openapi.yaml](../../../../openapi.yaml), [Servidor MCP](../frameworks/MCP-SERVER.md), [Servidor A2A](../frameworks/A2A-SERVER.md). A cobertura do lado dos provedores (quais upstreams existem) está no [PROVIDER_REFERENCE.md](../../../../reference/PROVIDER_REFERENCE.md) (em inglês).

---

## Reportar um problema de compatibilidade

Abra uma issue **Compatibility Problem** (`.github/ISSUE_TEMPLATE/compatibility.yml`) com o runtime exato, SO/arquitetura, método de instalação e comando. As linhas marcadas como **Declarado** são as mais úteis de confirmar ou refutar.
