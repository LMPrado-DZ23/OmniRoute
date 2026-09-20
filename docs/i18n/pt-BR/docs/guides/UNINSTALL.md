# OmniRoute — Guia de desinstalação (Português (Brasil))

🌐 **Languages:** 🇺🇸 [English](../../../../guides/UNINSTALL.md) · 🇸🇦 [ar](../../../ar/docs/guides/UNINSTALL.md) · 🇦🇿 [az](../../../az/docs/guides/UNINSTALL.md) · 🇧🇬 [bg](../../../bg/docs/guides/UNINSTALL.md) · 🇧🇩 [bn](../../../bn/docs/guides/UNINSTALL.md) · 🇨🇿 [cs](../../../cs/docs/guides/UNINSTALL.md) · 🇩🇰 [da](../../../da/docs/guides/UNINSTALL.md) · 🇩🇪 [de](../../../de/docs/guides/UNINSTALL.md) · 🇪🇸 [es](../../../es/docs/guides/UNINSTALL.md) · 🇮🇷 [fa](../../../fa/docs/guides/UNINSTALL.md) · 🇫🇮 [fi](../../../fi/docs/guides/UNINSTALL.md) · 🇫🇷 [fr](../../../fr/docs/guides/UNINSTALL.md) · 🇮🇳 [gu](../../../gu/docs/guides/UNINSTALL.md) · 🇮🇱 [he](../../../he/docs/guides/UNINSTALL.md) · 🇮🇳 [hi](../../../hi/docs/guides/UNINSTALL.md) · 🇭🇺 [hu](../../../hu/docs/guides/UNINSTALL.md) · 🇮🇩 [id](../../../id/docs/guides/UNINSTALL.md) · 🇮🇹 [it](../../../it/docs/guides/UNINSTALL.md) · 🇯🇵 [ja](../../../ja/docs/guides/UNINSTALL.md) · 🇰🇷 [ko](../../../ko/docs/guides/UNINSTALL.md) · 🇮🇳 [mr](../../../mr/docs/guides/UNINSTALL.md) · 🇲🇾 [ms](../../../ms/docs/guides/UNINSTALL.md) · 🇳🇱 [nl](../../../nl/docs/guides/UNINSTALL.md) · 🇳🇴 [no](../../../no/docs/guides/UNINSTALL.md) · 🇵🇭 [phi](../../../phi/docs/guides/UNINSTALL.md) · 🇵🇱 [pl](../../../pl/docs/guides/UNINSTALL.md) · 🇵🇹 [pt](../../../pt/docs/guides/UNINSTALL.md) · 🇷🇴 [ro](../../../ro/docs/guides/UNINSTALL.md) · 🇷🇺 [ru](../../../ru/docs/guides/UNINSTALL.md) · 🇸🇰 [sk](../../../sk/docs/guides/UNINSTALL.md) · 🇸🇪 [sv](../../../sv/docs/guides/UNINSTALL.md) · 🇰🇪 [sw](../../../sw/docs/guides/UNINSTALL.md) · 🇮🇳 [ta](../../../ta/docs/guides/UNINSTALL.md) · 🇮🇳 [te](../../../te/docs/guides/UNINSTALL.md) · 🇹🇭 [th](../../../th/docs/guides/UNINSTALL.md) · 🇹🇷 [tr](../../../tr/docs/guides/UNINSTALL.md) · 🇺🇦 [uk-UA](../../../uk-UA/docs/guides/UNINSTALL.md) · 🇵🇰 [ur](../../../ur/docs/guides/UNINSTALL.md) · 🇻🇳 [vi](../../../vi/docs/guides/UNINSTALL.md) · 🇨🇳 [zh-CN](../../../zh-CN/docs/guides/UNINSTALL.md) · 🇹🇼 [zh-TW](../../../zh-TW/docs/guides/UNINSTALL.md)

---

Este guia remove o OmniRoute do seu computador. Vá direto à seção que corresponde a **como você instalou**. Nenhum passo apaga seus dados a menos que diga isso explicitamente — leia o aviso antes de executar esses comandos.

---

## Antes de começar: onde ficam seus dados

O OmniRoute guarda tudo (banco de dados, provedores, chaves de API, configurações) em um único diretório de dados. Desinstalar o aplicativo nunca mexe nele, a menos que você execute os comandos de "apagar" abaixo.

| Como você usa o OmniRoute            | Diretório de dados padrão                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Windows (aplicativo desktop, código) | `%APPDATA%\omniroute` — se já existir uma pasta `%USERPROFILE%\.omniroute` de uma instalação antiga, ela é usada no lugar |
| macOS / Linux (desktop, código)      | `~/.omniroute` — ou `$XDG_CONFIG_HOME/omniroute` quando `XDG_CONFIG_HOME` está definida                                   |
| Docker                               | `/app/data` dentro do contêiner, ou seja, o volume `omniroute-data` do `docker run` documentado                           |
| Qualquer um dos acima com `DATA_DIR` | O diretório da variável de ambiente `DATA_DIR`, exatamente como você a definiu                                            |

Arquivos que você vai encontrar lá:

| Arquivo / pasta                     | O que é                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `storage.sqlite` (+ `-wal`, `-shm`) | Banco de dados principal — provedores, combos, configurações, chaves de API                   |
| `db_backups/`                       | Backups automáticos do banco (inclusive os instantâneos `pre-update-*` do aplicativo desktop) |
| `server.env`                        | Só no aplicativo desktop — segredos gerados (`JWT_SECRET`, chaves de criptografia)            |
| `electron-preferences.json`         | Só no aplicativo desktop — preferências de janela e bandeja                                   |

Para manter sua configuração para uma reinstalação futura, deixe esse diretório como está (ou copie-o antes para outro lugar).

---

## Aplicativo desktop (Windows, macOS, Linux)

1. Feche o OmniRoute por completo: clique com o botão direito no ícone da bandeja → **Sair** (fechar a janela só a esconde).
2. Remova o aplicativo:
   - **Windows:** `Configurações → Aplicativos → Aplicativos instalados → OmniRoute → Desinstalar`.
   - **macOS:** arraste `OmniRoute.app` de `/Applications` para a Lixeira.
   - **Linux:** apague o arquivo `.AppImage` que você baixou.
3. Seu diretório de dados (tabela acima) é **mantido**. Somente se você quiser apagar tudo:

> ⚠️ **Irreversível.** Apagar o diretório de dados elimina seus provedores, chaves de API, combos e histórico de uso. Na dúvida, faça um backup antes.

```bash
# macOS / Linux
rm -rf ~/.omniroute
```

```powershell
# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:APPDATA\omniroute"
```

---

## Docker

```bash
# Para e remove o contêiner — seus dados continuam no volume
docker stop omniroute
docker rm omniroute
```

Somente se você também quiser apagar seus dados:

> ⚠️ **Irreversível.** `docker volume rm` apaga o banco de dados, os provedores e as chaves de API guardados no volume.

```bash
docker volume rm omniroute-data
```

Opcional — liberar o espaço em disco da imagem:

```bash
docker rmi ghcr.io/lmprado-dz23/omniroute:latest
```

Com Docker Compose: `docker compose down` remove os contêineres e mantém os dados; `docker compose down -v` também apaga os volumes (irreversível).

---

## Instalado a partir do código-fonte (`git clone`)

Estes dois scripts existem **somente dentro do repositório clonado** — execute-os de dentro da pasta `OmniRoute`. Eles não existem no aplicativo desktop nem no Docker.

### Manter seus dados

```bash
npm run uninstall
```

O que ele faz: encerra um processo `omniroute` em segundo plano se você o iniciou com PM2, executa `npm uninstall -g omniroute` (não faz nada quando não há pacote npm global instalado — mas atenção: ele **removeria** o pacote npm do projeto original, se você também o tiver instalado), mostra onde está seu diretório de dados e o **mantém**.

### Apagar tudo

```bash
npm run uninstall:full
```

> ⚠️ **Irreversível.** Isto apaga o diretório de dados: banco de dados, provedores, chaves de API, combos, histórico de uso.

Por ser irreversível, o script nunca apaga só com a flag:

- Em um terminal, ele mostra o diretório exato que será apagado e pede que você digite `ERASE` (qualquer outra coisa mantém seus dados).
- Em scripts ou shells não interativos, ele recusa e sai com status 1, a menos que você passe `--yes`:

```bash
npm run uninstall:full -- --yes
```

O script resolve a pasta de dados exatamente como o aplicativo (tabela acima): `DATA_DIR` quando essa variável está definida; caso contrário, `%APPDATA%\omniroute` no Windows (ou uma pasta antiga `%USERPROFILE%\.omniroute`, se existir), `~/.omniroute` (ou `$XDG_CONFIG_HOME/omniroute`) no macOS/Linux — ele mostra a pasta antes de pedir a confirmação. Só se os seus dados estiverem em outro lugar, aponte-o explicitamente:

```powershell
$env:DATA_DIR = "$env:APPDATA\omniroute"; npm run uninstall:full
```

### Depois, apague a pasta clonada

Nenhum dos scripts remove o repositório em si. Apague a pasta `OmniRoute` que você clonou (Explorer / Finder, ou `rm -rf /caminho/para/OmniRoute` — confira o caminho antes).

---

## Instalou o pacote npm do projeto original (`npm install -g omniroute`)

Esse pacote é o **projeto original**, não este fork. Remova-o com:

```bash
npm uninstall -g omniroute
# ou, com pnpm:
pnpm remove -g omniroute
```

Seu diretório de dados segue a mesma tabela acima e é mantido, a menos que você o apague.

---

## Confirmar que foi removido

```bash
# Pacote npm global (não deve mostrar nada)
npm list -g omniroute

# Diretório de dados (só existe se você escolheu mantê-lo)
ls -la ~/.omniroute

# Processos em execução (macOS / Linux)
pgrep -f omniroute
```

No Windows, abra o Gerenciador de Tarefas e confirme que não há processo **OmniRoute**, e verifique `%APPDATA%\omniroute` no Explorer.
