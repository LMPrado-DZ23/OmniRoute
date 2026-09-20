---
title: "Início rápido: OmniRoute funcionando em 3 minutos"
version: 3.8.51
lastUpdated: 2026-09-11
---

# Início rápido: OmniRoute funcionando em 3 minutos

🌐 **Idiomas:** 🇺🇸 [English](../../../../getting-started/QUICK-START.md) · 🇧🇷 Português (Brasil)

> **Resumo:** Instalar → Conectar um provedor gratuito → Apontar seu editor ou CLI para o OmniRoute. Pronto.

> ⚠️ **Antes de qualquer comando:** `npm install -g omniroute` instala o **projeto original** (`diegosouzapw/OmniRoute`, publicado no npm pelo autor upstream), **não** este fork (`LMPrado-DZ23/OmniRoute`). Este fork é distribuído **somente** pelos canais abaixo: instalador desktop nas Releases do GitHub, imagem Docker `ghcr.io/lmprado-dz23/omniroute` e código-fonte.

---

## Primeiro uso em 5 passos

Se você nunca usou o OmniRoute, faça exatamente isto, nesta ordem:

| #   | O que fazer                                                                                                                                                                                                                            | Como saber que deu certo                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Instale **este fork** por um dos três métodos do [Passo 1](#passo-1-instalar-o-omniroute): instalador desktop (quando publicado), Docker ou código-fonte. **Não** use `npm install -g omniroute` (instala o projeto original).         | O painel abre em `http://localhost:20128`                                                  |
| 2   | Na primeira abertura: **sem** `INITIAL_PASSWORD` aparece o assistente inicial (defina uma senha ou marque "continuar sem senha"); **com** `INITIAL_PASSWORD` não há assistente — entre com essa senha e troque `CHANGEME` na hora      | Você vê o painel logado                                                                    |
| 3   | Conecte **um provedor gratuito** (Kiro, OpenCode Free ou Pollinations — sem cartão) em **Provedores → Adicionar provedor**                                                                                                             | O provedor aparece como **Conectado** em **Provedores**                                    |
| 4   | Em **API Keys**, crie uma chave e **copie-a no momento em que ela aparece** — ela é mostrada **uma única vez**. Perdeu? Crie outra.                                                                                                    | `curl http://localhost:20128/v1/models -H "Authorization: Bearer SUA_CHAVE"` lista modelos |
| 5   | Aponte sua ferramenta: URL base `http://localhost:20128/v1`, chave = a que você copiou no passo 4, modelo `auto` — ou use `omniroute run claude` / `omniroute launch-codex --model auto` (do código-fonte: `node bin/omniroute.mjs …`) | A requisição aparece em **Monitoramento → Logs** no painel                                 |

Se algo falhar, o painel mostra a mensagem de erro no próprio passo (não é preciso abrir o console). Veja também [Solução de problemas](../guides/TROUBLESHOOTING.md).

---

## Passo 1: Instalar o OmniRoute

Os três métodos abaixo instalam **este fork**. Escolha um:

### Opção A: Aplicativo desktop (Windows, macOS, Linux)

Baixe o arquivo do seu sistema na página de [Releases](https://github.com/LMPrado-DZ23/OmniRoute/releases) deste fork — `.exe` no Windows, `.dmg` no macOS, `.AppImage` ou `.deb` no Linux, cada um para x64 e arm64 — e abra-o. O aplicativo inicia o servidor embutido, fica na bandeja do sistema e atualiza sozinho (sempre pedindo confirmação antes de instalar; um instantâneo dos seus dados é gravado em `db_backups/pre-update-*` antes de cada atualização).

### Opção B: Docker — quando a imagem estiver publicada

A imagem deste fork é `ghcr.io/lmprado-dz23/omniroute` (é o que o fluxo de publicação do repositório produz). Se o `docker run` abaixo responder que a imagem não foi encontrada, ela ainda não foi publicada — use a **Opção C**.

```bash
docker run -d --name omniroute -p 127.0.0.1:20128:20128 -v omniroute-data:/app/data ghcr.io/lmprado-dz23/omniroute:latest
```

Seus dados ficam no volume `omniroute-data` (dentro do contêiner, em `/app/data`). `:latest` é a versão estável **publicada** mais alta (SemVer). Ela **não** acompanha o `main` do git. Para GitOps, fixe `ghcr.io/lmprado-dz23/omniroute:X.Y.Z`. Veja [Tags de imagem / canais de release](../../../../guides/DOCKER_GUIDE.md#release-channels).

### Opção C: A partir do código-fonte (funciona hoje)

Requer **Node.js 22 ou 24 LTS** e **git**. Copie e cole, uma linha por vez:

```bash
git clone https://github.com/LMPrado-DZ23/OmniRoute.git
cd OmniRoute
npm ci
npm run build
npm start
```

- `npm ci` instala as dependências exatamente como travadas no repositório; `npm run build` gera o painel; `npm start` sobe o servidor em `http://localhost:20128`.
- Para desenvolver (recarga automática, sem `build`): `npm run dev`.
- Instalando pelo código-fonte, o comando `omniroute` **não** fica no seu PATH. Sempre que este guia mostrar `omniroute <algo>`, execute, de dentro da pasta `OmniRoute`, `node bin/omniroute.mjs <algo>`.

---

## Passo 2: Iniciar o OmniRoute

Depende do método do Passo 1:

- **Aplicativo desktop:** abra o OmniRoute como qualquer programa. Ele sobe o servidor e abre o painel.
- **Docker:** o contêiner já está rodando após o `docker run`. Para parar/iniciar de novo: `docker stop omniroute` / `docker start omniroute`.
- **Código-fonte:** dentro da pasta `OmniRoute`, `npm start` (ou `npm run dev`).

Em todos os casos o painel fica em `http://localhost:20128`.

### O que acontece na primeira abertura

O comportamento depende de você ter ou não definido a variável `INITIAL_PASSWORD` (ela está no `.env.example` com o valor `CHANGEME`; só vale se você copiou esse arquivo para `.env` ou passou `-e INITIAL_PASSWORD=...` ao Docker):

- **Sem `INITIAL_PASSWORD`** (padrão do instalador desktop e do código-fonte sem `.env`): aparece o **assistente inicial**. Nele você define uma **senha** para o painel ou marca **"continuar sem senha"** (acesso local sem login). Em seguida ele oferece conectar um provedor gratuito.
- **Com `INITIAL_PASSWORD` definida** (comum no Docker e em servidores): o assistente **não** aparece. O OmniRoute já marca a configuração como concluída, exige login e abre direto a **tela de login** — entre com a senha que você definiu na variável. Se ficou o valor padrão `CHANGEME`, troque-a **imediatamente** em **Configurações → Segurança** (o OmniRoute avisa no log que essa senha é conhecida publicamente).

Esqueceu a senha? Use `omniroute-reset-password` (do código-fonte: `node bin/reset-password.mjs`).

---

## Passo 3: Conectar um provedor gratuito

Você pode usar o OmniRoute **sem pagar nada** conectando um provedor gratuito.

### Opção A: Kiro (Claude grátis — sem cartão de crédito)

1. Abra o painel em `http://localhost:20128`
2. Vá em **Provedores** → **Adicionar provedor**
3. Selecione **Kiro AI**
4. Clique em **Conectar** (não precisa de chave de API!)
5. Pronto! Você tem acesso gratuito aos modelos Claude.

### Opção B: OpenCode Free (sem autenticação)

1. Abra o painel em `http://localhost:20128`
2. Vá em **Provedores** → **Adicionar provedor**
3. Selecione **OpenCode Free**
4. Clique em **Conectar** (não precisa de chave de API!)
5. Pronto! Você tem acesso gratuito a vários modelos.

### Opção C: Pollinations (sem chave)

1. Abra o painel em `http://localhost:20128`
2. Vá em **Provedores** → **Adicionar provedor**
3. Selecione **Pollinations**
4. Clique em **Conectar** (não precisa de chave de API!)
5. Pronto! Você tem acesso gratuito a GPT-5, Claude, Gemini e outros.

---

## Passo 4: Criar sua chave e verificar que funciona

Em [API Keys](http://localhost:20128/dashboard/api-manager), clique em criar uma nova chave.

> 🔑 **A chave é mostrada uma única vez**, na janela que aparece logo após a criação ("ela não será mostrada novamente"). **Copie-a nesse momento** e guarde num lugar seguro. Depois disso o painel só exibe a chave mascarada. Se perder, não há como recuperar: crie **outra** chave (e apague a antiga).

Essa chave serve para as **suas ferramentas acessarem o OmniRoute**, não para acessar os provedores.

```bash
curl http://localhost:20128/v1/models -H "Authorization: Bearer SUA_CHAVE"
```

Você deve ver a lista dos modelos conectados.

---

## Passo 5: Apontar seu editor ou CLI para o OmniRoute

Na sua ferramenta, configure:

```
URL base: http://localhost:20128/v1
Chave:    a chave que você copiou no passo 4 (o painel não a mostra de novo)
Modelo:   auto
```

É isso. Sua ferramenta passa a usar o OmniRoute com seleção automática de provedor.

> Instalou pelo código-fonte? Em todos os comandos `omniroute …` abaixo, use `node bin/omniroute.mjs …` de dentro da pasta `OmniRoute`.

### Claude Code

O Claude Code fala a **API Messages da Anthropic** e é apontado para um gateway por variáveis de ambiente (não há `--base-url`). O jeito mais simples é deixar o OmniRoute configurar tudo:

```bash
omniroute run claude
# ou, com perfis por modelo:
omniroute setup-claude            # grava ~/.claude/profiles/<nome>/settings.json
omniroute launch --profile glm52  # Claude Code usando glm/glm-5.2 via OmniRoute
```

Manualmente, as variáveis são:

| Variável               | Valor                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `http://localhost:20128` — **sem** o sufixo `/v1` (o Claude Code acrescenta `/v1/messages`) |
| `ANTHROPIC_AUTH_TOKEN` | sua chave do OmniRoute (enviada como `Authorization: Bearer …`)                             |
| `ANTHROPIC_MODEL`      | opcional — força um modelo (ex.: `auto`)                                                    |

> As variáveis são lidas **uma vez, na inicialização** — reinicie o Claude Code depois de alterá-las.

Guia completo (em inglês): [Claude Code CLI — Configuration with OmniRoute](../../../../guides/CLAUDE-CODE-CONFIGURATION.md).

### Codex CLI

1. Defina a chave de forma persistente no sistema.
   macOS/Linux (adicione ao `~/.bashrc` ou `~/.zshrc`):

```bash
export OMNIROUTE_API_KEY="SUA_CHAVE"
```

Windows (Prompt de Comando):

```
setx OMNIROUTE_API_KEY SUA_CHAVE
```

2. Inicie o Codex já configurado para o OmniRoute:

```
omniroute launch-codex --model auto
```

O OmniRoute cuida do `~/.codex/config.toml` (o único formato que o Codex moderno lê) e mantém a chave **fora do arquivo**, apenas em `OMNIROUTE_API_KEY`. Guia completo (em inglês): [Codex CLI — Configuration](../../../../guides/CODEX-CLI-CONFIGURATION.md).

O mesmo lançador genérico funciona para outras CLIs — `omniroute run <alvo>` aceita `claude`, `codex`, `aider`, `goose`, `opencode`, `qwen` e `gemini` (veja [Integrações de CLI](../guides/CLI-INTEGRATIONS.md)).

### VS Code / Continue.dev

1. No VS Code, instale a extensão [Continue.dev](https://marketplace.visualstudio.com/items?itemName=Continue.continue).
2. Adicione ao seu `~/.continue/config.yaml`:

```
  - name: OmniRoute - Auto
    provider: openai
    model: auto
    apiBase: http://localhost:20128/v1
    apiKey: <SUA_CHAVE>
```

3. No chat do Continue.dev, selecione `OmniRoute - Auto`.

### Confirme que a ferramenta está passando pelo OmniRoute

Clique em [Monitoramento/Logs](http://localhost:20128/dashboard/logs) na barra lateral. Cada requisição mostra o que a sua ferramenta enviou — útil para aprender e depurar.

---

## Fechar, reabrir e recuperar

- **Reiniciar:** no painel, **Reiniciar** aguarda o servidor responder de novo antes de recarregar a página.
- **Aplicativo desktop:** fechar a janela mantém o servidor rodando na bandeja; **Sair** encerra tudo. Se o servidor demorar a subir, a janela mostra "Aguardando o servidor…" e recarrega sozinha.
- **Backup e restauração:** `omniroute backup create` / `omniroute backup restore` — detalhes em [Guia do banco de dados](../../../../ops/DATABASE_GUIDE.md).
- **Onde ficam seus dados:** Windows `%APPDATA%\omniroute`; macOS e Linux `~/.omniroute`; Docker no volume `omniroute-data`. Nada é apagado ao desinstalar, a menos que você peça.
- **Desinstalar:** depende de como instalou — aplicativo desktop: desinstalador do sistema; Docker: `docker stop omniroute && docker rm omniroute`; código-fonte: `npm run uninstall` (mantém seus dados) ou `npm run uninstall:full` (pede que você digite `ERASE` antes de apagar tudo). Passo a passo, com os avisos, em [Desinstalação](../guides/UNINSTALL.md).

---

## Próximos passos

- **[Guia de Auto-Combo](../../../../getting-started/AUTO-COMBO-GUIDE.md)** — deixe o OmniRoute escolher a melhor IA
- **[Guia de provedores](../../../../getting-started/PROVIDERS-GUIDE.md)** — conecte mais provedores (gratuitos e pagos)
- **[Guia de níveis gratuitos](../../../../getting-started/FREE-TIERS-GUIDE.md)** — IA grátis sem cartão
- **[Solução de problemas](../guides/TROUBLESHOOTING.md)** — problemas comuns

---

## Perguntas frequentes

### "Preciso de uma chave de API?"

**Não!** Provedores gratuitos (Kiro, OpenCode Free, Pollinations) funcionam sem chave. Basta conectá-los no painel. A chave do **passo 4** é a das suas ferramentas para falar com o OmniRoute.

### "O que é `auto`?"

`auto` manda o OmniRoute escolher automaticamente o melhor provedor para cada requisição, considerando velocidade, custo, qualidade e disponibilidade.

### "Quanto custa?"

O OmniRoute é **gratuito e open source**. Você só paga pelos provedores que usar — e muitos têm nível gratuito.

### "Funciona com Claude Code / Cursor / Copilot?"

**Sim.** O OmniRoute fala o formato OpenAI (`/v1/chat/completions`, `/v1/responses`) e o formato Anthropic (`/v1/messages`). Aponte a URL base para `http://localhost:20128/v1` (ou `http://localhost:20128` no Claude Code).

### "E se um provedor cair?"

O OmniRoute pula o provedor com falha e tenta o próximo automaticamente. Você não precisa fazer nada.

---

## Precisa de ajuda?

- **[Solução de problemas](../guides/TROUBLESHOOTING.md)**
- **[Discord](https://discord.gg/U47eFqAXCn)** — suporte da comunidade
- **[GitHub Issues](https://github.com/LMPrado-DZ23/OmniRoute/issues)** — reportar bugs
