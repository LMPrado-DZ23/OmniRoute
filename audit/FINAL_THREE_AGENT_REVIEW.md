# FINAL_THREE_AGENT_REVIEW — consolidação das auditorias independentes

Registro das auditorias por linha de release, da mais recente para a mais antiga. Cada seção guarda
os vereditos, os achados classificados e onde cada um foi corrigido.

## v3.8.55 — auditoria de três agentes (2026-09-20)

Linha `release/v3.8.55` do fork `LMPrado-DZ23/OmniRoute`. Uma rodada, três auditores em paralelo,
cada um em seu próprio worktree, sem acesso às conclusões dos outros. Cada um foi obrigado a
`git fetch` e **reverificar todo achado contra a ponta atual** antes de reportar — a árvore avançou
durante a auditoria (#53, #56, #64, #65, #66 entraram), e os três confirmaram por diff quais dos seus
achados sobreviveram.

Regras que valeram para os três: todo comando rodou com `DATA_DIR`, `HOME`, `USERPROFILE` e `APPDATA`
isolados; `git stash` foi proibido (é compartilhado entre worktrees e já tinha destruído trabalho duas
vezes naquele dia); nenhum segredo foi impresso.

**Uma ressalva honesta, declarada pelo próprio auditor B:** uma sonda anônima contra a instância local
dele foi _roteada_, e o OmniRoute fez chamadas reais às pontas gratuitas do opencode (402/403 de
volta). Nenhuma credencial foi configurada ou exposta, e nada fora daquela máquina foi atacado. Esse
resultado inesperado **é** o achado principal da auditoria.

### Vereditos

| Auditor | Lane                     | CRITICAL | HIGH                     |
| ------- | ------------------------ | -------- | ------------------------ |
| A       | Arquitetura e engenharia | 0        | 1 (fechado — ver abaixo) |
| B       | Segurança e DevSecOps    | 1        | 1                        |
| C       | Produto, QA e UX         | 0        | 1                        |

### CRITICAL

**B-C1 — toda a superfície `/v1/**` respondia a chamadas anônimas da internet.**
`requireLogin` governa `/api/**`; `/v1/**` é governado por `REQUIRE_API_KEY`, que sai de fábrica
`false`. Numa instância com senha de painel configurada e todas as rotas de gestão devolvendo 401, um
`POST /v1/chat/completions` **sem credencial nenhuma** foi aceito, roteado e executado — 502 depois de
seis tentativas upstream reais, não 401. Num domínio público isso é um relay de LLM aberto, cobrado
nas credenciais e na cota do operador, com prompts arbitrários indo para `call_logs`.

Pior: as receitas de deploy discordavam entre si, e a do domínio público era a errada —
`docs/ops/VM_DEPLOYMENT_GUIDE.md` imprimia `REQUIRE_API_KEY=false` duas linhas abaixo de
`AUTH_COOKIE_SECURE=true`, sem aviso algum.

O smoke test que eu mesmo tinha feito na 3.8.54 não pegou: sondei `/api/**` e `GET /v1/models` — que é
gateado por _outra_ chave e devolve 401 — e concluí que a instância estava fechada.

Corrigido em **[#69](https://github.com/LMPrado-DZ23/OmniRoute/pull/69)**: `clientApiPolicy` agora
exige que o chamador seja de fato local (`isLoopbackRequest || isPrivateLanRequest`, ambos cientes de
proxy reverso e falhando fechado), o guia e os compose files passam a exigir a chave, e
`route-origin-auth-matrix.test.ts` — que **codificava a falha como contrato esperado**, afirmando
`ALLOW` para origem `public` — foi corrigido.

### HIGH

**A-H1 — não existe veredito de CI completo para esta linha, em commit nenhum.**
`ci.yml` dispara só em `main`, então sua placa inteira nunca rodou em nenhum dos PRs; `quality.yml`, que
é a placa real dos PRs de release, não carrega `test:integration:ci`, `test:security`,
`test:protocols:e2e`, `test:coverage`, `check:pack-boot` e mais uma dúzia. A varredura Release-Green
existe para cobrir isso, mas em `push` roda `--quick`, que pula as suítes.

Três disparos completos morreram idênticos: `exit 143`, aos 60 minutos, **sem nenhuma saída** — o passo
redirecionava o log para arquivo e só o imprimia com um `cat` final que nunca era alcançado.
**[#70](https://github.com/LMPrado-DZ23/OmniRoute/pull/70)** faz o log sair ao vivo; isso não conserta a
morte, conserta a cegueira.

Com o log visível, a causa ficou clara — e ela **não** era a que eu supus. A
**[#76](https://github.com/LMPrado-DZ23/OmniRoute/pull/76)** deu `timeout-minutes: 180` aos dois jobs,
partindo da hipótese de que o job herdava um teto por não declarar nenhum. A execução
[35496465106](https://github.com/LMPrado-DZ23/OmniRoute/actions/runs/35496465106) refutou isso: foi
disparada em `450d6586f`, que **já continha** os 180 minutos, e morreu às 08:17:37 — **60m11s** depois
de começar, a mesma marca das três anteriores. Todos os gates estáticos e de deriva passaram até
07:23:23; as quatro suítes seriais então rodaram 54 minutos sem uma linha de saída e o processo levou
SIGTERM. A execução 35468579833 já tinha registrado o motivo em palavras: _"The runner has received a
shutdown signal"_.

Ou seja: **o runner hospedado para em ~60 minutos**, e os tetos das próprias suítes somam 155 minutos
no pior caso em modo serial. Duas saídas reais, nenhuma alcançável por edição de workflow:

- ligar a variável `USE_VPS_RUNNER` numa janela de release — o workflow já a honra e tira a varredura
  do runner hospedado;
- fatiar as suítes lentas em jobs separados, de modo que nenhum precise de mais de uma hora.

**Resolvido em [#87](https://github.com/LMPrado-DZ23/OmniRoute/pull/87) — a segunda saída, a que eu
tinha escrito como "não alcançável por edição de workflow", era alcançável.** A varredura deixou de
ser um job: `resolve` (o branch vira **um** SHA exato) → sete jobs `slow-suite` (unit ×4, integration
×2, vitest, cada um abaixo do teto) → o agregador, que roda os gates estáticos/deriva/full-ci e
**funde** os relatórios dos shards no veredito. Todo job faz checkout do SHA que `resolve` produziu,
então o relatório fundido pertence a um commit só.

Os shards **medem e não julgam**: uma suíte vermelha ainda sai 0 para que seu relatório chegue, e o
agregador roda com `!cancelled()` em vez de `success()`, de modo que um shard **morto** ainda tem seu
veredito pronunciado. O risco novo dessa forma — um job verde sem ter medido nada — é o que
`--expect-slow` guarda: ele nomeia **cada id de shard** que a matriz produz, e uma suíte sem relatório
vira falha HARD dizendo _"it did not run, so it is NOT green"_.

### O primeiro veredito completo desta linha, e o que ele encontrou

Execução [35501782210](https://github.com/LMPrado-DZ23/OmniRoute/actions/runs/35501782210): unit ×4 e
vitest verdes (7–9 min cada, contra os 60 que matavam o job único); **os dois shards de integration
vermelhos**. Os dois achados eram reais:

- `tests/integration/api-routes-critical.test.ts` fazia uma requisição HTTPS **ao vivo para
  `aihorde.net`** em toda execução — `GET /api/v1/models` atualiza o catálogo de imagens da AI Horde
  sempre que `aihorde` está ativo, e ele está ativo por padrão porque é provedor no-auth e não tem
  linha de conexão para desligar;
- `tests/integration/api-keys.test.ts` era **falso positivo da guarda de rede que eu mesmo escrevi**
  na #56: o teste aponta `CLOUD_URL` para `http://cloud.example` de propósito, e `.example` é
  reservado por RFC 2606 / 6761 — não resolve em lugar nenhum. A primeira correção que escrevi para
  isso estava errada e três testes existentes a pegaram: eu isentei nomes reservados de serem
  **bloqueados**, o que deixava a conexão seguir até um DNS real. Bloquear e contabilizar são duas
  decisões; hoje o nome reservado continua recusado e só a contagem muda.

Ambos corrigidos em **[#96](https://github.com/LMPrado-DZ23/OmniRoute/pull/96)**. Na segunda varredura
([35504173140](https://github.com/LMPrado-DZ23/OmniRoute/actions/runs/35504173140)) **os sete shards
passaram**.

### O que ainda impede um verde completo — e não é fatiável

O agregador das duas varreduras passou em **todos** os gates (typecheck, ESLint 0 erros, DB rules,
public creds, complexidade, test-masking, dead-code, type coverage, compressão, cobertura OpenAPI,
workflow lint, CodeQL, docs-sync) e então morreu no `check:pack-artifact`: seis minutos de silêncio e
`exit 143`, nas duas. Não é teto de tempo — o job tem 55 minutos de orçamento.

`check:pack-artifact` cai num `next build` completo, e **o runner hospedado não comporta esta
árvore**. O repositório já sabia disso: `build.yml` é manual-only desde a #11946 porque 19 das suas 30
últimas execuções morreram com _"the runner has received a shutdown signal"_ (VM sem memória) ~8 min
dentro daquele build, e o cabeçalho do arquivo diz que o bundle é validado "onde um build realmente
cabe" — o pool self-hosted.

**[#99](https://github.com/LMPrado-DZ23/OmniRoute/pull/99)** conserta o desperdício, não o build: em
runner hospedado o gate não é mais tentado e passa a ser **registrado como não-medido**, falha HARD
com motivo e remédio, em vez de levar treze gates verdes e sete suítes verdes junto com o 143.

**O que resta é dependência externa, não trabalho pendente:** um veredito _totalmente_ verde para esta
linha exige `USE_VPS_RUNNER=true` com aquele runner ligado, e isso é decisão do dono. O melhor
veredito honesto disponível hoje é "tudo verde, exceto o artefato de pacote, que não foi medido aqui".

> **Correção (2026-09-25) — a seção acima afirma como fato algo que eu não tinha medido, e estava
> errado.** Escrevi que _"o runner hospedado não comporta esta árvore"_ e que o remédio era um runner
> self-hosted. Isso só se sustenta se um `next build` completo não fecha em `ubuntu-latest`, e ele fecha:
>
> - o job `Build shared Next standalone` do `electron-release.yml` roda `npm run build` em
>   `ubuntu-latest` e **passou em 11m29s** na v3.8.55 (e na v3.8.54 no dia anterior);
> - o `build.yml` disparado à mão na tag (run 36199521486) completou o `build:release` — Next, bundle da
>   CLI e SHA — em **7m17s**, com 10 GB de swap e heap de 12 GB.
>
> Eu tinha a evidência contrária diante de mim: o comentário do `quality.yml` sobre o job `Build
(advisory)` diz que o `build.yml` passou 24 de 25 execuções em ~15 min no `ubuntu-latest`. Li aquilo,
> não o reconciliei com o cabeçalho do `build.yml` (que diz o oposto) e repeti a versão que já estava
> documentada, em vez de medir. O quadro honesto é **OOM intermitente, não impossibilidade**.
>
> O que segue verdadeiro: não há runner self-hosted registrado (`total_count: 0`), então
> `USE_VPS_RUNNER` é uma flag morta — o "remédio" que sugeri não existia. A causa do `exit 143` da
> varredura continua **hipótese**: o job não provisionava swap, e o swap é o que absorve o pico nativo
> do Turbopack (#6409). O workflow agora provisiona esse swap e só liga o gate de artefato se o
> `swapon` de fato der certo; senão, registra o gate como não-medido com o motivo real. A próxima
> varredura é o teste dessa hipótese.
>
> Metade do gate já era medida sem build algum: `check:pack-artifact --policy-only` (arquivos
> inesperados, vazamento de testes, fechamento do MCP) roda em todo PR pela entrada `pack-policy` do
> `fast-gates` e passa. Só os arquivos de runtime e a proveniência do build precisam de `dist/`.

**B-H1 — PR de fork executava no runner LAN persistente do mantenedor.**
`quality.yml:553` selecionava o pool `self-hosted` sem a cláusula de origem própria que `ci.yml:650`
tem, rodando `npm ci` — sem `--ignore-scripts` — contra o lockfile do fork. Execução arbitrária de
código numa máquina que guarda estado entre jobs, e a linha seguinte marca `continue-on-error` para
forks, então ia verde. O próprio arquivo enuncia a regra nos comentários. Corrigido em **#69**, com
`workflows-self-hosted-fork-guard.test.ts` comparando todo `runs-on` self-hosted de workflow de PR
contra a guarda.

**C-H1 — `/dashboard/cli-code` reprovava na própria régua do projeto, sem nunca ter sido auditada.**
Medido no build de produção com axe-core 4.13.0: `select-name` **crítico ×2** e `color-contrast`
**sério ×2**, nos dois temas, em 1280 e 375. Os dois selects de filtro não tinham nome acessível
algum e suas `<label>` visíveis não tinham `htmlFor` — um leitor de tela anunciava duas caixas sem
nome, ambas dizendo "All". O pior nó era o aviso âmbar "sem provedores ativos" a **2,92:1**, a linha
que um usuário de primeira viagem mais precisa ler.

A causa de ninguém ter visto é que `tests/e2e/a11y.spec.ts` auditava sete caminhos — **nenhuma das duas
superfícies novas desta release** — e `A11Y_VIEWPORTS` começava em 768, então 375 nunca era varrido.
Corrigido em **[#71](https://github.com/LMPrado-DZ23/OmniRoute/pull/71)**, que também coloca as duas
páginas e a largura de celular no gate.

> O auditor C revisou o próprio relatório: tinha classificado isso como MEDIUM com evidência só de
> jsdom, achando que o build de produção não tinha completado. Rodou de novo, viu que tinha, mediu ao
> vivo e subiu para HIGH. Registrado porque uma auditoria que corrige a si mesma vale mais do que uma
> que acerta de primeira por sorte.

### MEDIUM corrigidos nesta linha

| Achado                                                                                                                                                                                                      | Onde                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A — o orçamento de latência recusava candidatos sobre um palpite, nunca sobre "desconhecido"; numa instalação nova um orçamento baixo excluía permanentemente todo modelo não medido, e era autossustentado | [#68](https://github.com/LMPrado-DZ23/OmniRoute/pull/68) |
| A — dois gates saíam 0 no Windows sem executar nada (`file://C:\…` nunca casa com `file:///C:/…`); corrigida a guarda, `check:env-doc-sync` rodou e achou **0** variáveis, porque chamava `grep` pelo shell | [#67](https://github.com/LMPrado-DZ23/OmniRoute/pull/67) |
| C — o assistente de primeira execução declarava a instância "pronta para rotear" uma etapa depois de reportar que não havia provedor                                                                        | [#73](https://github.com/LMPrado-DZ23/OmniRoute/pull/73) |
| C — `COST_TRACKING.md` documentava quatro comandos que a #54 removeu ou mudou; `check:fabricated-docs` valida só o comando de primeiro nível                                                                | [#72](https://github.com/LMPrado-DZ23/OmniRoute/pull/72) |

### MEDIUM e LOW que seguem abertos

Nenhum é bloqueador de release, e todos estão registrados aqui para não se perderem.

**Segurança**

- **B-M1** — o bloqueio de login é chaveado pelo salto do proxy reverso, então **atrás de nginx/Caddy/
  cloudflared qualquer um na internet tranca o dono fora do próprio painel**, indefinidamente: 5 senhas
  erradas a cada 15 minutos bastam. A guarda não é falsificável por `X-Forwarded-For` (bom), mas todas
  as conexões compartilham o IP do proxy (ruim). **Deliberadamente não corrigido às pressas:** trocar a
  chave para o IP do cliente troca um DoS garantido por um possível furo de força bruta, e a resposta
  certa provavelmente é manter as duas contagens com tetos diferentes.
- **B-M2** — `x-loopback-only: true` em dois GETs que o guard isenta, e o gate é estruturalmente cego
  para isso (`coveredByLocalOnly()` não conhece `LOCAL_ONLY_API_GET_EXEMPTIONS` nem métodos).
- **B-M3** — `check-openapi-security-tiers` é irrodável no Windows: `parsePatterns` usa `$` sem `/m`,
  então num checkout CRLF a entrada com comentário é descartada e o gate reprova com 6 falsos.
- **B-M4** — o botão "Allow Private Provider URLs" também desliga o bloqueio de metadados de nuvem
  (devolve o modo `"none"`, não `"block-metadata"`), reabrindo o pivô SSRF→IMDS num VPS.
- **B-M5** — no `npm-publish.yml`, `workflow_call` fica fora do portão, e os dois jobs de plugin rodam
  `npm install` sem `--ignore-scripts` antes de um `npm publish --provenance`.
- **B-L3** — um admin de workspace pode reivindicar qualquer chave **não atribuída** da instância;
  hoje sem escalada, porque quem cria workspace já é admin, mas é o furo do dia em que workspaces
  virarem fronteira de tenancy real.

**Arquitetura**

- **A-M5** — o roll-up da hierarquia é O(chaves) em SQL por requisição (129 `prepare()` para uma
  checagem com 100 chaves), com um `UPDATE` por requisição depois do limiar de aviso.
- **A-M6** — `src/lib/db/core.ts` é risco de manutenção, não só arquivo grande: `getDbInstance()`
  ocupa 424 linhas (24% do arquivo) e é construtor do singleton **e** caminho de recuperação, sem
  costura para testar um ramo isolado. O vermelho do `check-file-size` é pré-existente e idêntico à
  v3.8.54 (1769 linhas nas duas).
- **A-L8** — `ci.yml:438` passa `BASE_REF` cru enquanto os outros dois sítios passam `origin/{0}`.

**Produto**

- **C-M2** — o botão primário do tema claro cai a **3,96:1** na ponta violeta de `--grad-brand`; axe
  reporta gradiente como _incomplete_, então a varredura nunca viu. É decisão de token de marca,
  válida para todo botão primário do produto.
- **C-M5** — todo erro da página Workspaces é inglês fixo no código, inclusive para pt-BR e vi, que
  ganharam tradução de verdade. Os `code` existem justamente para permitir traduzir.
- **C-M6** — um carregamento que falha na página Workspaces é indistinguível de "você não tem
  nenhum": o toast some em 8 s e sobra o estado vazio simpático.
- **C-M8** — a página cli-code é a única superfície de base URL que ignora `OMNIROUTE_BASE_PATH`
  (usa `window.location.origin` em vez de `useDisplayBaseUrl()`) — só leitura de código, não
  reproduzido num deploy em subcaminho.
- **C-M9** — "link para a página que emite a chave" vale para **16 de 355** provedores; os demais
  caem no site institucional. O componente é honesto sobre qual dos dois mostra; o exagero estava na
  nota de release.
- **C-M10** — 169 ligaduras de ícone na superfície cli-code, nenhuma com `aria-hidden`: dois botões
  cujo nome acessível inteiro é a string `content_copy`. `button-name` **passa**, então ferramenta
  nenhuma pega.
- **C-M11** — o modo escuro serve o diagrama de tiers claro (`TierFlowDiagram` importa `useTheme` de
  `next-themes`, o único uso dessa lib em `src/`, sem `ThemeProvider` — `resolvedTheme` é sempre
  `undefined`), e o texto alternativo diz "3-tier" enquanto o SVG entregue diz "4-tier".
- **C-M4** — uma senha recusada mostra "Invalid request" e manda o usuário ler uma mensagem que não
  explica nada; a regra real do servidor chega em `error.details[0].message` e é descartada.

### Verificado e limpo (o espaço negativo, porque ele também é resultado)

- `npm audit --omit=dev`: **0 vulnerabilidades** em 890 dependências de produção.
- IDOR de workspace atacado de vários ângulos sem furo: workspace e projeto alheios devolvem o 404
  byte a byte idêntico ao inexistente; **314/314** testes de authz passam.
- Deleções destrutivas guardadas: workspace com projetos → 409; projeto com chaves → 409.
- Migração 178 é aditiva e sobrevive a banco populado; 19/19 testes de workspace passam.
- Falsificação de `Host` não muda nada; normalização de caminho (`/api/%64b-backups`, `/API/…`,
  `//`, barra final) não contorna o tier `ALWAYS_PROTECTED`.
- `guardedFetch`/`hardenedWebhookFetch`: checagem pré-I/O, todo endereço resolvido validado,
  dispatcher preso ao IP validado contra DNS rebinding, redirects nunca seguidos.
- `#60` está genuinamente correto: `{{baseOrigin}}` resolve sem `/v1`, exatamente 3 entradas o usam
  (`gemini`, `goose`, `5dive`), e os 42 locales têm a chave com chave simples correta.
- Contagem do catálogo consistente: `CLI_TOOLS` = 48 (32 code / 16 agent); a página filtra para **27**,
  batendo com `EXPECTED_CODE_COUNT`.
- `errorSanitization.ts` foi examinado e considerado sólido; nenhum vazamento de chave em log, corpo
  de erro ou contexto do modelo.

### Não testável nesta rodada — dito sem arredondar

- **Conexão real de provedor não foi feita.** Exigiria credencial real ou aceitar um consentimento de
  terceiros. Tudo a jusante — rotear uma requisição viva, o estado _detectado_ dos cartões de CLI, o
  roll-up de gasto com gasto real — segue sem teste.
- **`/dashboard/costs/workspaces` não renderizou no navegador do auditor C.** Ele deliberadamente
  **não** reportou como achado, porque a irmã `/dashboard/costs/budget` — que esta release não toca —
  trava igual, enquanto `/dashboard/cli-code` monta na mesma aba. O padrão aponta para o ambiente
  dele. **O dono deve confirmar que essa página abre num navegador normal**; se não abrir, é
  bloqueador, e a cobertura só-jsdom não teria pego.
- `check:openapi-breaking` não pôde ser confirmado localmente: o binário `oasdiff` não existe nesta
  máquina e o gate sai 0 mesmo com `--ratchet`.

## v3.8.54 — evolução em 13 fases (2026-09-19)

Linha `release/v3.8.54` do fork `LMPrado-DZ23/OmniRoute`, criada de `release/v3.8.53` (`2560ec3a4`).

Houve **duas rodadas**. Na primeira, três auditores revisaram a árvore com as fases integradas. Na
segunda — a rodada de verificação — os **mesmos três** voltaram para conferir, na árvore final, se as
correções que a primeira rodada gerou realmente estavam lá e se nada regrediu. Em ambas eles
trabalharam em paralelo, sem acesso às conclusões uns dos outros.

Regras que valeram para os seis trabalhos: todo comando rodou com `DATA_DIR`, `HOME`, `USERPROFILE`
e `APPDATA` isolados; nenhum provedor de IA real foi chamado; nenhum segredo foi impresso. O banco de
produção `~/.omniroute/storage.sqlite` não foi aberto — o auditor C confirmou o `mtime` intacto ao
encerrar.

### Rodada 1 — árvore `20d5b2ca2`

| Auditor | Foco                     | Veredito               | CRIT | HIGH | MED | LOW | MELHORIA |
| ------- | ------------------------ | ---------------------- | ---- | ---- | --- | --- | -------- |
| A       | Arquitetura / engenharia | Aprovado com ressalvas | 0    | 1    | 3   | 5   | 5        |
| B       | Segurança / DevSecOps    | Aprovado com achados   | 0    | 0    | 1   | 4   | 5        |
| C       | Produto / QA / UX        | Aprovado com ressalvas | 0    | 1    | 4   | 10  | 2        |

Os dois HIGH:

| Id   | Achado                                                                                                                                                                                            | Correção                                                                                                                                                                        | PR  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| A-H1 | O armazenamento de decisões era limitado só por contagem; a ~2,1 KB por candidato, 2000 decisões × 300 candidatos chegariam a 1,19 GB                                                             | Decisão guardada compacta (≤40 candidatos, fatores do selecionado + 10, `omittedCandidates`) e orçamento de 32 MB; sonda mediu 1189,5 MB → 28,3 MB                              | #38 |
| C-H1 | O assistente de webhook oferecia eventos que a API rejeita, exibia `[object Object]`, deixava um webhook de todos-os-eventos **habilitado** ao cancelar, e não permitia escolher os eventos novos | Eventos vindos de `WEBHOOK_EVENT_VALUES`, erros legíveis, rascunho salvo desabilitado e apagado no cancelamento; `POST /api/webhooks` aceita `enabled` opcional (padrão `true`) | #39 |

Os MEDIUM e LOW da rodada 1, com sua correção:

| Id                    | Sev | Achado                                                                                                                   | Correção                                                                                                                                               | PR            |
| --------------------- | --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| A-M1                  | MED | A ordenação por orçamento passava por cima de uma estratégia de roteador explícita (mudança de comportamento vs v3.8.53) | Ordenação por orçamento só no caminho de regras                                                                                                        | #38           |
| A-M2                  | MED | O contrato dava a entender que existia um orçamento de latência aplicado no tráfego real                                 | Documentação e JSDoc passam a dizer exatamente o que o tráfego real aplica                                                                             | #38           |
| A-M3                  | MED | Um breaker aberto só por ociosidade deixava `provider_recovery` violado para sempre                                      | Breaker aberto por ociosidade → `insufficient_data`                                                                                                    | #38           |
| B-01 / A-L3           | MED | O SDK Python repassava `Authorization` em redirecionamento para outro host                                               | O handler remove credenciais na troca de origem e recusa `https`→`http`; o SDK TS usa redirecionamento manual quando há headers de credencial próprios | #37           |
| C-M1                  | MED | Não havia interface para os SLOs                                                                                         | Cartão de SLO em Configurações → Resiliência                                                                                                           | #39           |
| C-M2                  | MED | A documentação de backup errava sobre a chave de criptografia (`server.env` não é copiado)                               | Corrigida em inglês e pt-BR                                                                                                                            | #39           |
| C-M3                  | MED | O `select` de "Request log" do Route Trace não tinha nome acessível (crítico no axe)                                     | Rótulo associado; a aba entrou na cobertura de a11y do e2e                                                                                             | #39           |
| C-M4                  | MED | Exemplos de SDK com `model: "auto"` podiam alcançar endpoints de terceiros sem chave, sem aviso                          | Marcador explícito `<provider>/<model>` e aviso                                                                                                        | #37           |
| A-L1                  | LOW | `/api/metrics` e o timer de SLO mutavam o estado dos breakers                                                            | Leitura por snapshot, sem efeito colateral                                                                                                             | #38           |
| A-L2 / B-05           | LOW | Os SDKs repetiam um POST de chat não idempotente após timeout, sem jitter                                                | POST só é repetido quando comprovadamente não foi enviado, ou em 429/503 com `Retry-After`; backoff com jitter                                         | #37           |
| A-L4                  | LOW | Estado de alerta de SLO ficava obsoleto ao alternar a configuração                                                       | `SloAlertRunner` reinicia o estado                                                                                                                     | #38           |
| A-L5                  | LOW | Decisão com estratégia explícita podia não ter candidato selecionado                                                     | A escolha da estratégia é reportada quando há rota                                                                                                     | #38           |
| B-02                  | LOW | Revelação de credencial por chave de gerenciamento `x-goog-api-key`                                                      | Revelar exige sessão de dashboard carimbada pelo pipeline                                                                                              | #37           |
| B-04                  | LOW | Nomes de modelo inventados podiam ocupar as vagas de rótulo das métricas                                                 | Valores fixos não consomem vaga; só respostas bem-sucedidas criam rótulo                                                                               | #38           |
| C-L1..L3              | LOW | Cartão de consulta sem tradução, erros de auth agrupados, 400 da preview despejando JSON cru                             | Traduzido, mensagem específica de auth, 400 legível                                                                                                    | #38           |
| C-L4, L6, L8, L9, L10 | LOW | Precisão do guia de monitoramento, rótulos/aria do assistente, labels de issue, link de pular duplicado, versão nos docs | Corrigidos                                                                                                                                             | #39           |
| C-L5                  | LOW | Contraste em `/dashboard/settings`                                                                                       | Corrigido; axe 0 em todas as larguras, baseline 5 → 0                                                                                                  | #39           |
| C-L7                  | LOW | Instruções de import do SDK Python                                                                                       | Documentação                                                                                                                                           | #37           |
| B-03                  | LOW | `js-yaml` 4.3.1 na cadeia do Electron (registro R-10)                                                                    | **Não corrigido** — exige renovação do lockfile do Electron; aceito como risco residual                                                                | —             |
| Melhorias             | —   | A-I1..I5, B-06..B-10, C-I1..I2                                                                                           | Aplicadas: A-I1, A-I4, A-I5, B-07, B-08, B-09, B-10, C-I2. Registradas sem alteração: A-I2, A-I3, B-06, C-I1                                           | #37, #38, #39 |

### Rodada 2 — verificação na árvore final `68a00d025`

| Auditor | Veredito | CRIT | HIGH | Novos MED | Novos LOW | Novas melhorias | Afirmações verificadas |
| ------- | -------- | ---- | ---- | --------- | --------- | --------------- | ---------------------- |
| A       | PASS     | 0    | 0    | 2         | 3         | —               | 8 de 8                 |
| B       | PASS     | 0    | 0    | 2         | 2         | 1               | 9 de 9                 |
| C       | PASS     | 0    | 0    | 6         | —         | —               | 14 de 14               |

Nenhuma correção da rodada 1 foi encontrada ausente, parcial ou incorreta.

Evidência de que o comportamento não mudou, que era a preocupação central desta release:

- **Seleção de provedor idêntica à v3.8.53 em 700 de 700 casos**, com RNG semeado e relógio
  congelado, e zero divergências na contagem de chamadas a `Math.random`. O auditor extraiu o motor
  da v3.8.53 por `git show`, em somente leitura, e o ligou aos mesmos módulos de pontuação.
- **`previewRoutingDecision` chamou `Math.random` zero vezes** em 200 previews, produziu uma única
  seleção, e um experimento de controle com pontuações empatadas confirmou `ROTATOR UNCHANGED BY
PREVIEWS: true` — a preview não consome rotação nem altera as exclusões do self-healing.
- Typecheck em **0 erros** nos quatro projetos; **160/160** testes de roteamento (A), **486/486**
  entre autorização, segurança, SDKs e contrato (B), e as 14 afirmações de produto conferidas com o
  produto no ar (C).
- Dez tentativas adversariais de revelar uma credencial passando pelo `runAuthzPipeline` real: todas
  mascaradas. Só a sessão de dashboard genuína revela — e mesmo ela volta a mascarar se um header
  programático for contrabandeado junto.

Achados novos da rodada 2 e onde foram corrigidos:

| Id   | Origem | Sev      | Achado                                                                                                                                                                 | Correção                                                                                                                                                                                                                                                                                                                                                                        | PR  |
| ---- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| A-V1 | A      | MED      | Regressão desta release: gravar a decisão materializava todos os candidatos com todos os fatores antes de compactar — 17,0 ms e 591 KiB por request com 300 candidatos | A gravação constrói a decisão já no formato em que ela é retida: 4,6 ms e 26,5 KiB (3,1 → 1,2 ms com 50). A preview segue devolvendo a lista completa                                                                                                                                                                                                                           | #41 |
| A-V2 | A      | MED      | Pré-existente, idêntico na v3.8.53: sete caminhos de **leitura** de saúde usavam uma chamada que transiciona um breaker OPEN → HALF_OPEN e persiste                    | Os sete convertidos para leitura por snapshot — mais uma oitava ocorrência que o auditor apontou fora da lista                                                                                                                                                                                                                                                                  | #41 |
| B-V1 | B      | MED      | O SDK TypeScript seguia um `307` cross-origin e **reenviava o corpo** do request (com o prompt) para a outra origem; sem guarda de `https`→`http`                      | Redirecionamento manual em toda requisição, com `vetRedirect()` recusando outra origem e rebaixamento de esquema                                                                                                                                                                                                                                                                | #42 |
| B-V2 | B      | MED      | O registro de vulnerabilidades estava desatualizado: um advisory **high** novo (`adm-zip <0.6.1`, GHSA-7q85-xj36-vmfc) havia entrado na árvore de produção da raiz     | Corrigido em vez de redocumentado: `adm-zip` → 0.6.1 só no lockfile, dentro do override `^0.6.0` já existente. Produção da raiz: `high:1, moderate:2` → **zero**                                                                                                                                                                                                                | #42 |
| B-V3 | B      | LOW      | `check:lockfile` falhava no Windows e culpava envenenamento de supply chain por uma falha de spawn                                                                     | O gate roda e separa "ferramenta não executável" de "violação de política". Tinha uma segunda causa que o achado não cobria: o `--path` é tratado como glob, onde a barra invertida do Windows é escape                                                                                                                                                                         | #42 |
| B-V4 | B      | LOW      | A consulta de decisão de rota aceitava chamador anônimo com `requireLogin=false`, ao contrário de `/api/metrics`                                                       | `alwaysRequireAuth: true`, igual `/api/metrics` — o corpo nomeia os mesmos provedores e modelos                                                                                                                                                                                                                                                                                 | #42 |
| B-V5 | B      | MELHORIA | `escapeLabelValue` não escapava `\r`                                                                                                                                   | Escapado junto com os demais caracteres de controle                                                                                                                                                                                                                                                                                                                             | #42 |
| C-V1 | C      | MED      | Na partida a frio, `/login` abortava a checagem após 5 s e deixava um usuário novo num campo de senha inutilizável; a primeira chamada foi medida em 44,7 s            | A página de login espera a resposta em vez de adivinhar, com orçamento de repetição e, na falha total, um alerta explicado com botão de repetir — sem recarregar. Causa medida dos 44,7 s: 27,2 s são a compilação do grafo de módulos da rota pelo Next no primeiro request (só em desenvolvimento); o bootstrap do banco leva 1,45–3,5 s e já roda fora do caminho do request | #43 |
| C-V2 | C      | MED      | O assistente de webhook exibia as chaves cruas `webhooks.{slack,discord,telegram}.tutorialStep1..4`, ausentes nos três idiomas                                         | As 11 strings que os componentes pedem foram escritas, traduzidas para pt-BR e vi, e replicadas em inglês nos demais idiomas conforme a convenção do repositório; teste garante que nenhum nó renderizado casa com o padrão de chave crua                                                                                                                                       | #43 |
| C-V3 | C      | MED      | `/dashboard/logs` com 4 violações críticas de `select-name`                                                                                                            | Rótulos associados por `htmlFor`/`id`; a página entrou na suíte de axe com baseline 0                                                                                                                                                                                                                                                                                           | #43 |
| C-V4 | C      | MED      | Contraste de 1,72 no aviso âmbar do onboarding, no tema claro                                                                                                          | Tokens novos de ênfase para aviso, erro e sucesso; sem hex no ponto de uso. O assistente entrou na suíte de axe                                                                                                                                                                                                                                                                 | #43 |
| C-V5 | C      | MED      | Item ativo da barra lateral em 4,43 no tema escuro                                                                                                                     | Token `--color-primary-on-tint`, derivado de `--color-primary` por `color-mix`, para que um preset personalizado o acompanhe                                                                                                                                                                                                                                                    | #43 |
| C-V6 | C      | MED      | Pílulas de status de `/dashboard/logs` em 4,44                                                                                                                         | Mesmo token                                                                                                                                                                                                                                                                                                                                                                     | #43 |

Medições de acessibilidade do auditor C na árvore final, com o próprio conjunto de tags do
repositório, em 375 / 768 / 1024 / 1440 px:

| Página                                     | Claro   | Observação                   |
| ------------------------------------------ | ------- | ---------------------------- |
| `/login`                                   | 0       | medido em 1440               |
| `/home`                                    | 0/0/0/0 | 1 no tema escuro (nav ativa) |
| `/dashboard/providers`                     | 0/0/0/0 | 1 no tema escuro (nav ativa) |
| `/dashboard/settings`                      | 0/0/0/0 | 0 também no tema escuro      |
| `/dashboard/settings/resilience`           | 0/0/0/0 |                              |
| `/dashboard/analytics?tab=route-trace`     | 0/0/0/0 |                              |
| `/dashboard/webhooks`                      | 0/0/0/0 |                              |
| `/dashboard/combos`                        | 0/0/0/0 |                              |
| `/dashboard/logs`                          | 2/2/2/2 | C-V3 e C-V6                  |
| Assistente de onboarding (instalação nova) | 1/1/1/1 | C-V4                         |

Nenhuma página teve transbordo horizontal em nenhuma largura.

Uma decisão registrada, não um esquecimento: branco sobre a cor primária da marca no tema
escuro (`#ffffff` sobre `#e54d5e`) mede 3,78:1, abaixo de AA. É idêntico na base e mudar isso
significa mudar a cor da marca, o que não cabe numa release de correção. É a única violação
que resta em toda a matriz de acessibilidade.

### Portão de release

Critério: `CRITICAL = 0` e `HIGH = 0` após as correções, com cada correção verificada por um auditor
independente na árvore final.

**Atingido.** Os três auditores deram PASS na rodada de verificação, com CRITICAL 0 e HIGH 0 cada
um. Os achados novos da rodada 2 são MEDIUM ou menos e foram corrigidos nos PRs #41, #42 e #43, não
adiados. O único item aceito sem correção é o **B-03 / R-10** (`js-yaml` 4.3.1), restrito à cadeia de
verificação de atualização do Electron — não está na imagem de container, no pacote npm nem no
runtime do servidor — e sua remoção depende de uma renovação do lockfile do Electron, fora do escopo
desta linha.

## v3.8.51 — prontidão para o usuário final (2026-09-12)

- **HEAD auditado pelos três agentes:** `b623dc3aa` (fix/final-user-readiness, 120 commits desde `2a156c738`). Os auditores trabalharam em paralelo, sem acesso às conclusões uns dos outros, com briefing comum (somente leitura no repositório; revalidar no código, não nos documentos do executor). Relatórios brutos: scratchpad da sessão `auditA/REPORT.md`, `auditB/REPORT.md`, `auditC/REPORT.md` (+ logs e sondas).
- **Vereditos:** A (Architect/Engineering) **APROVADO COM RESSALVAS** · B (Security/DevSecOps) **APROVADO COM RESSALVAS** · C (Product/QA/UX, usou o produto no navegador) **APROVADO COM RESSALVAS**. Nenhum CRITICAL. HIGH: 3 (todos do Auditor C).
- **Fix loop (rodada 1 concluída; 24 commits `7dcfcfa83`…`check:standalone-hygiene`):** cada achado abaixo tem estado `CORRIGIDO (commit)`, `EM CORREÇÃO`, `ACEITO COM JUSTIFICATIVA`, `RESIDUAL DOCUMENTADO` ou `FALSE_POSITIVE`. Critério de saída (05-EXECUTION-PLAN §5): CRITICAL = 0, HIGH = 0, blockers internos = 0.
- Além dos auditores, o E2E real com provedor local (Ollama, `test:compat:ollama`) e a inspeção dos artefatos empacotados revelaram defeitos adicionais (seção 4), tratados no mesmo loop.

### 1. Auditor A — Architect / Engineering

| ID        | Sev            | Achado                                                                                                                                                                       | Estado                                                                                                       |
| --------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A-1       | MEDIUM         | Retry `SQLITE_BUSY` (R-3) multiplicava o `busy_timeout` de 2 s para ~10,4 s síncronos                                                                                        | **CORRIGIDO** `7f4344b3c` — orçamento total de 1 s incluindo o busy_timeout; RED 8,6 s → GREEN 2,7 s         |
| A-2       | MEDIUM         | `db-busy-write-retry-r3` falhava deterministicamente no Windows e não constava na matriz                                                                                     | **CORRIGIDO** `7f4344b3c` — 8/8 no Windows; registrado em `TEST_MATRIX.md`                                   |
| A-3       | MEDIUM         | R-6: `registerShutdownHook()` sem nenhum consumidor em produção                                                                                                              | **CORRIGIDO** `b2bc70bbd` — 10 schedulers registram seus stoppers; registry sem ciclos em `shutdownHooks.ts` |
| A-4       | LOW            | `exit` tardio do servidor antigo apagava o `server.pid` do novo (caminho de timeout do restart)                                                                              | **CORRIGIDO** `f698f5bff` — handler preso ao filho que o registrou                                           |
| A-5       | LOW            | SSE MCP: sessão criada em `initialize` não fechada em erro; cap 64 sem teste                                                                                                 | **CORRIGIDO** `849231779` — `closeSession` no catch; teste do cap com 65 sessões                             |
| A-6       | LOW            | Tolerância a `duplicate column` (R-4) só verificava colunas, não `CREATE INDEX/TABLE`                                                                                        | **CORRIGIDO** `3a91c9d99` — probe estendido ao `sqlite_master`, fail-closed                                  |
| A-7       | IMPROVEMENT    | 2.º listener `abort` do `abortPromise` não removido no `finally` de `executeWithUpstreamStartTimeout`                                                                        | **ACEITO** — sinal é por request; listener morre com o sinal. Rastreado em `02` (R-21 nota)                  |
| A-8       | IMPROVEMENT    | ~50 linhas duplicadas entre `check-install-upgrade.mjs` e `check-pack-boot.mjs`                                                                                              | **ACEITO** — gates independentes por desenho; extração registrada como melhoria em `04`                      |
| A-9       | IMPROVEMENT    | `outputFileTracingExcludes` não listava `.install-upgrade`, `.build`, `audit`                                                                                                | **CORRIGIDO** `268ceb9b0` + `f7d4acb0f` (ver X-1: o problema era maior que o auditor viu)                    |
| A-10      | IMPROVEMENT    | Testes acoplados ao texto-fonte (wiring por regex)                                                                                                                           | **ACEITO** — complementam testes comportamentais ao lado; sem substituição                                   |
| FP-1…FP-7 | FALSE_POSITIVE | sessão MCP antes de auth; import de Playwright no shutdown; restart normal apaga pid; `files` narrow; Tailscale regride POSIX; teste de reveal apagado; migração 174 diverge | Verificados pelo auditor como não-problemas (evidência no relatório A)                                       |

Correções de documentos apontadas por A (R-6 "coberto", R-9 "cap coberto", "0 regressões" com teste novo falhando, R-3 "sem parar o loop", R-2 diagnóstico `setNoLog`) — aplicadas em `02-ARCHITECTURE.md`/`TEST_MATRIX.md` nesta rodada.

### 2. Auditor B — Security / DevSecOps

| ID  | Sev         | Achado                                                                                             | Estado                                                                                                                                    |
| --- | ----------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | LOW         | `isPrivateHost` classificava `0:0:0:0:0:ffff:127.0.0.1` (IPv6 mapeado não comprimido) como público | **CORRIGIDO** `7dcfcfa83` — classificação pelos grupos expandidos (::/80, NAT64), guard canônico e cópia do relay; RED 18 → GREEN 116/116 |
| B-2 | IMPROVEMENT | Plugins: checksum obrigatório, mas sem assinatura de publisher (raiz de confiança independente)    | **ACEITO** — disclosure na UI/SDK (P-2/P-3); assinatura minisign/cosign registrada em `03` como próximo passo                             |
| B-3 | INFO        | Chave de API cifrada-recuperável mantida para o OpenAPI Try (auth só por hash; reveal removido)    | **ACEITO** — documentado; risco só com `STORAGE_ENCRYPTION_KEY` + arquivo 0o600 vazando juntos                                            |

Verificações executadas pelo auditor (não apenas lidas): 65/65 (MCP scope + private-host gaps), 26/26 (authz matriz + webhook SSRF + sinks), 258 `uses:` pinados, `npm audit --omit=dev` 0/0/3/0, SC-1 strict, 0 segredos no diff da missão. Limitação registrada: sem instância viva (build ainda rodando) — as 5 requisições ofensivas HTTP não foram feitas; cobertas em parte pelo Auditor C (401 tipado, LOCAL_ONLY) e pelo E2E Ollama (401 com chave inválida/anônimo).

### 3. Auditor C — Product / QA / UX (uso real no navegador, porta 20413)

| ID        | Sev            | Achado                                                                                                                                             | Estado                                                                                                                                                                                                                 |
| --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01      | **HIGH**       | Live WebSocket só funcionava na porta 20128 (allow-list e porta fixas; loop de `FORBIDDEN_ORIGIN` 345×)                                            | **CORRIGIDO** `7dc60006f` — allow-list e porta derivadas das portas de runtime; cliente para após 4003; sonda real com daemon                                                                                          |
| C-02      | **HIGH**       | Quick start pt-BR/EN mandava `npm install -g omniroute` (upstream), chave "copie depois", assistente que não aparece, `npm run uninstall` genérico | **CORRIGIDO** `4e9031023` (+ `9fe1d4cd2`: o próprio `uninstall:full` apagava a pasta errada no Windows)                                                                                                                |
| C-03      | **HIGH**       | Teste de conexão com host inacessível devolvia "Endpoint <path>" (redator de caminhos destruía a frase), sem Retry                                 | **CORRIGIDO** `784ab5454` (+ i18n `144c1c11e`) — códigos `UPSTREAM_TIMEOUT/UNREACHABLE/TLS` com host, redator preserva a frase, botão Tentar novamente; RED→GREEN 21 casos, 147/147 nas suítes relacionadas            |
| C-04      | MEDIUM         | Placeholders i18n renderizados ("Api Region Hint"); telas principais em inglês no painel pt-BR; 4 traduções erradas                                | **CORRIGIDO** `8d4ab8678` + `144c1c11e` — 18 placeholders EN reais, 75 folhas pt-BR / 38 pt, 4 traduções erradas; gate falha em valor = chave humanizada (baseline de 165 pré-existentes); `check-ui-value-drift` PASS |
| C-05      | MEDIUM         | `/v1/models` lista 512 modelos de CLIs não instaladas/free desabilitados numa instância sem provedor válido                                        | **CORRIGIDO** `89fbc7899` — `catalogLocalCliAvailability.ts` sonda os 4 provedores `isLocalCli` como os executors (sem importá-los), cache SWR 60 s, fail-open; 11 casos RED→GREEN, 101/101 nas suítes do catálogo     |
| C-06      | MEDIUM         | Com `INITIAL_PASSWORD` o assistente nunca aparece; `PATCH setupComplete=false` responde 200 sem efeito                                             | **RESIDUAL DOCUMENTADO** — comportamento agora descrito nos guias (`4e9031023`: dois caminhos de primeira abertura); o PATCH silencioso vira LOW em `04`                                                               |
| C-07      | MEDIUM         | Banner zero-config e aba de armazenamento mostram caminhos chutados pelo navegador                                                                 | **CORRIGIDO** `96d455833` — `serverEnvPath` real vindo de `/api/storage/health` (rota MANAGEMENT), loading sem caminho chutado, dispensa persistente; RED 8/10 → GREEN 10/10 + 1/1                                     |
| C-08      | MEDIUM         | A11y: glifos Material Symbols lidos como texto; switches sem nome; inputs só-placeholder; drawer sem `role=dialog`                                 | **RESIDUAL DOCUMENTADO** em `04` (A-3/A-4) — não bloqueia o uso; correção transversal de ícones planejada                                                                                                              |
| C-09      | MEDIUM         | Layout ≤ ~1000 px transborda (cabeçalho/cartões do assistente); 375 px e 1280 px OK                                                                | **RESIDUAL DOCUMENTADO** em `04` (breakpoints intermediários)                                                                                                                                                          |
| C-10      | LOW            | Runner dev/E2E ignora `HOST=127.0.0.1` (só o modo `start`)                                                                                         | **RESIDUAL DOCUMENTADO** — script de desenvolvimento; produção respeita `HOST`                                                                                                                                         |
| C-11      | LOW            | Página "aguardando o servidor" do Electron só em inglês                                                                                            | **CORRIGIDO** `8d4ab8678` — página de espera do Electron em pt/en via `resolveTrayLocale` (+3 casos)                                                                                                                   |
| C-12      | LOW            | Dica CHANGEME some se `/api/settings/require-login` demora > 5 s                                                                                   | **RESIDUAL DOCUMENTADO** (timeout de UI; reload mostra)                                                                                                                                                                |
| C-13      | LOW            | Assistente: pills não voltam; "Close" sem tradução; progresso estilizado como erro                                                                 | parcialmente coberto por C-03 (estilo do progresso) e C-04 ("Close"); pills = residual                                                                                                                                 |
| C-14      | LOW            | Home dominada por anúncios de parceiros; nomenclatura "Endpoint" vs "Gerenciador API"                                                              | **RESIDUAL DOCUMENTADO** (produto/upstream)                                                                                                                                                                            |
| C-15      | LOW            | 4× `GET /api/settings` simultâneos; 188 chamadas em minutos                                                                                        | **RESIDUAL DOCUMENTADO** (R-15/R-16 classe)                                                                                                                                                                            |
| C-16      | IMPROVEMENT    | ConfirmModal: foco inicial no "×", título genérico                                                                                                 | **RESIDUAL DOCUMENTADO**                                                                                                                                                                                               |
| C-17      | IMPROVEMENT    | Reiniciar: sem feedback até o servidor cair; depois funciona                                                                                       | **RESIDUAL DOCUMENTADO**                                                                                                                                                                                               |
| C-18…C-21 | FALSE_POSITIVE | `confirm()` nativo (só comentário); botões só-ícone no API Manager; "Exigir login" sem senha (guard real); vitest UI 1 falha de timeout (ambiente) | Verificados pelo auditor                                                                                                                                                                                               |

Não verificável pelo auditor (ambiente): `npm run test:compat` 0/8 por timeout de boot (180 s) com a máquina sob carga — o executor tem 8/8 em execução anterior e o E2E Ollama 7/7 (`TEST_MATRIX.md`); jornadas 9/10/11 cobertas por esses dois gates.

### 4. Achados adicionais do fix loop (executor)

| ID  | Sev          | Achado                                                                                                                                                                                                                                                                                                                               | Estado                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| X-1 | **CRITICAL** | O standalone (e o Electron `resources/app`) empacotava o **`.env` real do checkout**, `.git`, `tests/` (5 683 arquivos), `audit/`, `.install-upgrade/` e uma cópia aninhada de `.build/next` (23 466 arquivos): tracing emite a raiz inteira e `outputFileTracingExcludes` não casa no Windows (barras invertidas) nem cobria `.env` | **CORRIGIDO** `f7d4acb0f` + `d8fc212b6`/`29c18ac6c` (prune preserva o dist dir do bundle; dist dir absoluto) + `check:standalone-hygiene` (gate real, prune fatal, denylist com `.npmrc`/`data`/`db_backups`/`logs`/`server.pid`/`.mcp.json`) — build #6: `.env`/`.git`/`tests`/`.install-upgrade` ausentes, dist dir próprio íntegro (§5) |
| X-2 | HIGH         | Cache semântico servia a resposta armazenada por um cliente `/v1/messages` a um cliente `/v1/responses` (assinatura sem formato do cliente) — encontrado pelo E2E Ollama                                                                                                                                                             | **CORRIGIDO** `f5f7bb387` + `2855c6a6e` — assinatura com formato do cliente E contexto (system/instructions, tools, response_format, thinking, max_tokens…); HIT com `stream=true` para claude/responses vira MISS (SSE só é sintetizado para chat completions); RED 0/4 e 0/8 → 69/69                                                     |
| X-3 | MEDIUM       | Build traçava o workspace do gate `check:install-upgrade` e abortava com ENOENT quando o gate o removia                                                                                                                                                                                                                              | **CORRIGIDO** `268ceb9b0`                                                                                                                                                                                                                                                                                                                  |
| X-4 | MEDIUM       | `uninstall:full` usava `~/.omniroute` fixo (Windows: apagava a pasta errada, mantinha os dados)                                                                                                                                                                                                                                      | **CORRIGIDO** `9fe1d4cd2`                                                                                                                                                                                                                                                                                                                  |
| X-5 | LOW          | Caminho literal `C:\Program Files\Tailscale` fazia o tracer tentar copiá-lo para o standalone                                                                                                                                                                                                                                        | **CORRIGIDO** `30ae54ee5`                                                                                                                                                                                                                                                                                                                  |
| X-6 | LOW          | `check-test-discovery` varria `electron/dist-electron` e reportava órfãos do pacote                                                                                                                                                                                                                                                  | **CORRIGIDO** `47df55119`                                                                                                                                                                                                                                                                                                                  |

### 5. Verificação pós-correção

**Verificação cruzada pelos auditores (mesmo checkout, somente leitura, HEAD `f14815025`):**

- **Auditor A** — A-1, A-2, A-3, A-4, A-5, A-6, A-9/X-1, X-2: **todos VERIFICADOS** (tsc core 0, tsc open-sse 0, 9 suítes exit 0: r3 8/8, a3 12/12, r6 2/2, r12 12/12, r9 4/4, r4 4/4, build-next-isolated 12/12, next-config 9/9, cache-format 4/4). Ressalva LOW aceita e corrigida: `NEXT_DIST_DIR` absoluto (→ `29c18ac6c`). Residuais LOW registrados: A-6 não sonda `CREATE TRIGGER/VIEW`; A-3 adoção por lista (10 sites que tocam o DB).
- **Auditor B** — B-1 **VERIFICADO** (127/127; probe ofensivo com 20 vetores IPv6: formas mistas, maiúsculas, zero-padded, zonas `%`, NAT64 — bloqueio correto; NAT64 de IPv4 público permitido). Decisão registrada: IPv4-mapeado público (`::ffff:8.8.8.8`) continua bloqueado (::/80 privado por desenho, já era assim). X-1 **"verificado no código / não fecha no gate"** → fechado nesta rodada: gate `check:standalone-hygiene` criado, prune fatal, denylist ampliada (`.npmrc`, `data`, `db_backups`, `logs`, `server.pid`, `.mcp.json`), verificação do bundle real do build #6 abaixo. X-2 **"não fecha para outras dimensões"** → fechado em `2855c6a6e` (contexto na assinatura + MISS para stream não-openai). Residuais IMPROVEMENT: paridade em literais inválidos entre guard canônico e relay; `fec0::/10`, `64:ff9b:1::/48`, 6to4/Teredo com IPv4 privado; `apiKeyId` ausente partilha namespace (pré-existente #3740).
- **Auditor C (rodada 2, produto real em :20413, HEAD `894fcaa66`)** — C-01, C-03, C-07 e o onboarding `valid:false` **VERIFICADOS**; C-02, C-04/C-11, C-05 **VERIFICADOS com ressalva** (99/99 node:test, 24/24 vitest, gate i18n PASS). Evidência no produto: nenhum `FORBIDDEN_ORIGIN` no console; teste de provedor inacessível → "Não foi possível conectar a 10.255.255.1: tempo esgotado…" + "Tentar novamente" funcional; painel pt-BR sem os textos em inglês listados; banner com `server.env` real e dispensa persistente; `/v1/models` sem CLIs ausentes após o refresh do catálogo. Defeitos NOVOS da rodada (nenhum CRITICAL/HIGH) e estado:
  - D-1 LOW — UNINSTALL EN/pt-BR ainda descrevia o `~/.omniroute` fixo → **CORRIGIDO** (parágrafo reescrito: mesma resolução do app).
  - D-2 LOW — assistente diz "após 8 s" mas o teste levou 16 s (dois probes de 8 s) → **RESIDUAL** (cosmético; a mensagem descreve o timeout por probe).
  - D-3 LOW — caixa "Testando conexão…" em `primary` (vermelho no tema) → **CORRIGIDO** (superfície neutra).
  - D-4 MEDIUM — 1.ª chamada `/v1/models` pós-boot → 500 `catalog_build_timeout` (teto de 8 s pré-existente, #12627) e CLIs ausentes listadas por um ciclo (fail-open do probe frio) → **CORRIGIDO na causa evitável**: probes aquecidos no startup (`warmLocalCliProviderAvailability()` na instrumentação), então o primeiro build encontra vereditos prontos; o teto de 8 s sob carga continua pré-existente (RESIDUAL, contorno: repetir a chamada).
  - D-5 LOW — só no runner dev/E2E (`OMNIROUTE_DISABLE_BACKGROUND_SERVICES`): daemon Live WS não sobe e o handshake anuncia 20132 → **RESIDUAL** documentado (produção sobe o daemon).
  - D-6 LOW — 3 chaves do baseline ainda renderizadas (`settings.cliproxyapiFallbackDescription`, `cliproxyapiStatusLabel`, `proxyDocumentationSocks5DescAfter`) → **CORRIGIDO** (texto real en/pt-BR/pt, baseline 165 → 162).
  - D-7 — Enter no campo de senha não submeteu na automação → **não conclusivo** (mesmo item C-12; `<form onSubmit>` existe).

**Artefatos reconstruídos (build #6, `NEXT_DIST_DIR=.build/next-verify`, prune completo):** exit 0 em 1547 s, 0 avisos de tracing; `.env`, `.env.local`, `server.env`, `.git`, `.github`, `tests`, `audit`, `.install-upgrade`, `_tasks`, `dist-electron`, `.next`, `.build/next` (sibling) **ausentes**; dist dir próprio com `server/` e `BUILD_ID`; `server.js` e `node_modules/next` presentes (107 entradas na raiz). Primeiro smoke de boot falhou por **erro do próprio script de smoke** (`NODE_ENV=production` sem `STORAGE_ENCRYPTION_KEY` → readiness `#3` recusa iniciar, comportamento correto); smoke repetido com a chave, gate `check:standalone-hygiene` no standalone e no `resources/app` do Electron pack #3 — resultados em `TEST_MATRIX.md` §3/§5.

### 6. Contagem final

| Severidade       | Encontrados (A+B+C+X)                                       | Corrigidos                                  | Aceitos / residuais documentados                                        | Falsos positivos |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- | ---------------- |
| CRITICAL         | 1 (X-1)                                                     | 1                                           | 0                                                                       | —                |
| HIGH             | 4 (C-01, C-02, C-03, X-2)                                   | 4                                           | 0                                                                       | —                |
| MEDIUM           | 10 (A-1, A-2, A-3, C-04, C-05, C-06, C-07, C-08, C-09, X-3) | 7 (A-1, A-2, A-3, C-04, C-05, C-07, X-3)    | 3 (C-06 documentado nos guias, C-08 a11y transversal, C-09 breakpoints) | —                |
| LOW              | 12 (A-4, A-5, A-6, B-1, C-10…C-15, X-4, X-5, X-6)           | 8 (A-4, A-5, A-6, B-1, C-11, X-4, X-5, X-6) | 4 (C-10, C-12, C-13 parcial, C-14, C-15)                                | —                |
| IMPROVEMENT/INFO | 8 (A-7, A-8, A-9, A-10, B-2, B-3, C-16, C-17)               | 1 (A-9)                                     | 7                                                                       | —                |
| FALSE_POSITIVE   | 11                                                          | —                                           | —                                                                       | 11               |

**Critério de saída (05 §5): CRITICAL = 0 ✔ · HIGH = 0 ✔ · blockers internos = 0 ✔.** Residuais MEDIUM/LOW aceitos com justificativa e rastreados em `04-PRODUCT-GAPS.md` (addendum) e `03-SECURITY-FINDINGS.md` (addendum).

### 7. Pós-COMPLETED — regressões pegas pelo CI Linux do PR #5

Após o push, o CI Linux reprovou 31 testes unitários e 8 gates de qualidade que a verificação local no Windows havia classificado como "Windows-only" ou não cobria. Reclassificação honesta (detalhe e commits em `AUTONOMOUS_MISSION_STATE.md`):

| ID     | Origem                     | Severidade           | Achado                                                                                                                                                                                               | Estado                                                                                             |
| ------ | -------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| R-CI-1 | fix loop (C-03)            | **HIGH**             | qualquer throw do `safeOutboundFetch` virava "Could not connect" e curto-circuitava o ping final: um 503 ou uma falha de bridge era apresentado como falha de conexão                                | CORRIGIDO `331b03352` (tipagem só com evidência real de rede)                                      |
| R-CI-2 | fix loop (X-2)             | **HIGH**             | assinatura de escrita do cache semântico calculada sobre o body já mutado → hit rate 0 % para clientes chat-completions em provedores Responses e para requests com tools                            | CORRIGIDO `5e5769e3c` (snapshot dos inputs antes da sanitização)                                   |
| R-CI-3 | fix loop (i18n/docs/build) | LOW                  | vi incompleto; 5 env vars sem contrato; OpenAPI/skill/contagem de migrações desatualizados; helper de dist dir não-POSIX                                                                             | CORRIGIDO (6 commits)                                                                              |
| R-CI-4 | base (`2265ce761`, #12506) | **HIGH (segurança)** | chave Google `AIza…` fora de 35 chars exatos não era redigida pelo sanitizador (a camada passthrough recusava)                                                                                       | CORRIGIDO `0eba379aa`                                                                              |
| R-CI-5 | base                       | MEDIUM               | rotas públicas da API (`/v1/…`, `/models`) redigidas como `<path>`; `zai_stream_error`/`huggingchat_generation_error` colapsados em `bad_gateway`; falha de imagem codex lançava em vez de registrar | CORRIGIDO `f348965d4`, `7c1f82c4b`, `f06d13802`                                                    |
| R-CI-6 | base (testes)              | LOW                  | premissa do teste de túneis desatualizada; TLA entre testes; teste Kiro anterior ao contrato de stream; política de log em repouso conflitante (#12469 × #12506)                                     | CORRIGIDO/ALINHADO `c24edefb1`, `205549de7` (mantida a política mais forte: sanitizado em repouso) |
| R-CI-7 | base                       | MEDIUM (manutenção)  | ciclo de imports de 33 arquivos em `src/lib/db` (gate `check:cycles` já falhava na base)                                                                                                             | CORRIGIDO `2f842bf20` (`encryptionAtRest.ts` folha)                                                |
| R-CI-8 | fix loop (qualidade)       | LOW                  | literal secreto no gate de boot; testes fora do stryker; 2 rotas sem sanitizador; 5 exports mortos; tipo do diagnóstico; 14 arquivos acima do congelado; 11 arquivos acima da complexidade           | CORRIGIDO (13 commits, extrações puras verificadas por testes antes/depois)                        |

Contagem após a rodada: CRITICAL 0 · HIGH 0 (3 encontrados aqui, 3 corrigidos) · MEDIUM 0 novos abertos · LOW 0 novos abertos. Os residuais da §6 permanecem como estavam.
