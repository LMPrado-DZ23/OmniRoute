---
title: "Seus primeiros 10 minutos com o OmniRoute"
version: 3.8.54
lastUpdated: 2026-09-14
---

# Seus primeiros 10 minutos com o OmniRoute

🌐 **Idiomas:** 🇺🇸 [English](../../../../getting-started/FIRST_10_MINUTES.md) · 🇧🇷 Português (Brasil)

> **Objetivo:** sair do zero até uma primeira requisição roteada que você consegue ver nos logs. Cada passo diz como confirmar que deu certo antes de seguir. Para o caminho mais curto veja o [Início rápido](QUICK-START.md); para todos os métodos de instalação veja o [SETUP_GUIDE.md](../../../../guides/SETUP_GUIDE.md) (em inglês).

> ⚠️ `npm install -g omniroute` instala o projeto **original** (`diegosouzapw/OmniRoute`), não este fork (`LMPrado-DZ23/OmniRoute`). Este guia usa a imagem Docker ou o código-fonte. Veja o [Início rápido](QUICK-START.md#passo-1-instalar-o-omniroute) para a situação do app desktop.

---

## Minutos 0–3: instalar

Escolha **um** método.

### Docker

```bash
docker run -d --name omniroute \
  -p 127.0.0.1:20128:20128 \
  -v omniroute-data:/app/data \
  ghcr.io/lmprado-dz23/omniroute:latest
```

- A imagem define `PORT=20128` e `DATA_DIR=/app/data` (veja o `Dockerfile`), então tudo o que você configurar fica no volume `omniroute-data`.
- `:next` é um canal mutável. Fixe uma tag de versão ou um digest para tudo o que você precisar reproduzir depois ([tags de imagem](../../../../guides/DOCKER_GUIDE.md#release-channels)).

### A partir do código-fonte

Requer git e um runtime Node.js suportado (veja a [Matriz de compatibilidade](../reference/COMPATIBILITY_MATRIX.md)).

```bash
git clone https://github.com/LMPrado-DZ23/OmniRoute.git
cd OmniRoute
npm ci
npm run check:node-runtime   # falha na hora com uma versão de Node.js não suportada/insegura
npm run build
npm start
```

A instalação pelo código-fonte não coloca `omniroute` no seu `PATH`: onde este guia mostrar `omniroute <comando>`, rode `node bin/omniroute.mjs <comando>` dentro da pasta do repositório.

**Confirme:** `curl -s http://localhost:20128/healthz` responde (a rota fica em `src/app/healthz/route.ts`). A porta padrão `20128` vem de `src/lib/runtime/ports.ts`.

---

## Minutos 3–4: abrir o painel e definir uma senha

Abra `http://localhost:20128`. O que aparece depende de `INITIAL_PASSWORD`:

| `INITIAL_PASSWORD` | O que acontece na primeira abertura                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| não definida       | O assistente inicial (`/dashboard/onboarding`) pede para você definir uma senha do painel (ou continuar explicitamente sem senha, para uso apenas local).                                                            |
| definida           | **O assistente inicial é pulado.** Na primeira leitura das configurações o OmniRoute grava `setupComplete=true` e `requireLogin=true` (`src/lib/db/settings.ts`), então você cai em `/login` e entra com essa senha. |

Essa inicialização acontece uma única vez. Depois de entrar, você ainda pode fazer a configuração guiada em `/dashboard/onboarding?rerun=1`: ela mantém a senha que você já tem e passa por adicionar um provedor, validar a credencial, escolher um modelo, uma requisição de teste, a configuração do cliente e a primeira requisição nos logs. `PATCH /api/settings` com `{"setupComplete": false}` também traz o assistente de volta, e o valor não é mais forçado de novo na leitura seguinte.

Se a senha for o valor de exemplo `CHANGEME` do `.env.example`, troque imediatamente em **Configurações → Segurança** (`/dashboard/settings/security`). Esqueceu a senha? Rode `omniroute-reset-password` (a partir do código-fonte: `node bin/reset-password.mjs`).

**Confirme:** você vê a página inicial do painel, logado.

---

## Minutos 4–6: adicionar um provedor e validar a credencial

1. Vá em **Provedores** (`/dashboard/providers`) e adicione um provedor. As opções gratuitas, sem cartão, estão no [FREE-TIERS-GUIDE.md](../../../../getting-started/FREE-TIERS-GUIDE.md); provedores com chave de API e OAuth estão no [PROVIDERS-GUIDE.md](../../../../getting-started/PROVIDERS-GUIDE.md) (ambos em inglês).
2. Abra o provedor e rode o **teste** da conexão. O painel envia `POST /api/providers/{id}/test` para essa conexão, que testa a credencial armazenada.
3. Pelo terminal, com o servidor rodando: `omniroute test <provedor> <modelo>` (veja `omniroute test --help`).

**Confirme:** o teste passa. Se falhar, corrija a credencial antes de continuar; veja [Solução de problemas](../guides/TROUBLESHOOTING.md) e o [RESILIENCE_GUIDE.md](../../../../architecture/RESILIENCE_GUIDE.md) (em inglês) para cooldowns e circuit breakers.

---

## Minutos 6–7: criar uma chave de API do OmniRoute

Vá em **API Keys** (`/dashboard/api-manager`) e crie uma chave. A janela avisa que a chave não será mostrada de novo. Copie nesse momento; se perder, crie outra chave e apague a antiga.

Essa chave autentica **suas ferramentas no OmniRoute**. Ela não é uma chave de provedor. Segundo o [ENVIRONMENT.md](../reference/ENVIRONMENT.md), `REQUIRE_API_KEY` tem padrão `false`; defina `true` em qualquer instalação acessível por outras máquinas, para que toda chamada `/v1/*` exija uma chave válida.

Nos exemplos abaixo, troque `sk-your-omniroute-key` pela sua chave. Nunca cole chaves reais em issues, chats ou capturas de tela.

---

## Minutos 7–8: escolher um modelo realmente disponível

```bash
curl -s http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk-your-omniroute-key"
```

Os valores `data[].id` são os IDs de modelo que você pode pedir. Escolha um que pertença ao provedor que você acabou de validar (ou um combo; veja [Auto-Combo](../routing/AUTO-COMBO.md)).

---

## Minutos 8–9: enviar a primeira requisição

### curl (formato OpenAI Chat Completions)

```bash
curl -s http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-your-omniroute-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-id-from-the-previous-step>",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

`/v1/*` é reescrito para `/api/v1/*` (`next.config.mjs`), por isso `http://localhost:20128/v1` é a URL base para clientes compatíveis com OpenAI.

### Qualquer SDK compatível com OpenAI (exemplo em Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:20128/v1",
    api_key="sk-your-omniroute-key",
)
reply = client.chat.completions.create(
    model="<model-id-from-the-previous-step>",
    messages=[{"role": "user", "content": "Say hello in one sentence."}],
)
print(reply.choices[0].message.content)
```

Clientes que falam o formato Anthropic Messages usam `POST /v1/messages`; clientes do formato OpenAI Responses usam `POST /v1/responses`. A lista completa está na [Matriz de compatibilidade](../reference/COMPATIBILITY_MATRIX.md#protocolos-de-cliente-e-endpoints).

**Confirme:** você recebe uma resposta do modelo, não um objeto de erro.

---

## Minuto 9: copiar a configuração do cliente

- **Endpoints** (`/dashboard/endpoint`) mostra a URL base que seus clientes devem usar, com botões de copiar.
- Para agentes de CLI, os lançadores configuram a ferramenta por você, por exemplo `omniroute launch-codex --model <model-id>` ou `omniroute run claude`. Configuração por ferramenta: [Integrações de CLI](../guides/CLI-INTEGRATIONS.md) e [CLI-TOOLS.md](../reference/CLI-TOOLS.md).

Configuração mínima para qualquer ferramenta compatível com OpenAI:

```text
Base URL: http://localhost:20128/v1
API key:  sk-your-omniroute-key
Model:    <model-id-from-/v1/models>
```

---

## Minuto 10: ver a requisição nos logs

- Painel: **Logs** (`/dashboard/logs`) lista as requisições recentes; abra uma para ver os detalhes.
- CLI: `omniroute logs --lines 20` (adicione `--follow` para acompanhar em tempo real).

**Confirme:** a requisição dos minutos 8–9 está na lista. Pronto.

---

## Ressalvas conhecidas

- Definir `INITIAL_PASSWORD` pula o assistente inicial na primeira inicialização (veja a tabela acima). Use em implantações headless; para ter a configuração guiada mesmo assim, entre e abra `/dashboard/onboarding?rerun=1`.
- Local dos dados: `DATA_DIR` quando definido; senão um `~/.omniroute` já existente é mantido; depois `%APPDATA%\omniroute` no Windows, `$XDG_CONFIG_HOME/omniroute` quando `XDG_CONFIG_HOME` está definido, e por fim `~/.omniroute` (`src/lib/dataPaths.ts`). Faça backup antes de atualizar: [Backup e restauração](../ops/BACKUP_RESTORE.md).
- Imagens Docker `:next` mudam sem aviso. Atualização, fixação de versão e rollback: [Guia de atualização e migração](../guides/MIGRATION_GUIDE.md).
- Publicar a porta em `127.0.0.1` (como no exemplo Docker) mantém o gateway local. Antes de expor, leia o [SECURITY.md](../../SECURITY.md) e o [Guia de implantação em VM](../ops/VM_DEPLOYMENT_GUIDE.md).

## Próximos passos

- [PROVIDERS-GUIDE.md](../../../../getting-started/PROVIDERS-GUIDE.md): mais provedores (em inglês)
- [OMNIROUTE_PROVIDER_FAILOVER.md](../../../../OMNIROUTE_PROVIDER_FAILOVER.md): comportamento de failover (em inglês)
- [USAGE_QUOTA_GUIDE.md](../../../../guides/USAGE_QUOTA_GUIDE.md): cotas e gastos (em inglês)
- [Referência da API](../reference/API_REFERENCE.md) e [openapi.yaml](../../../../openapi.yaml): API completa
