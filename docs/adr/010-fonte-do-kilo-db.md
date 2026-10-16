# ADR-010 — Fonte do `kilo.db`: a regra do runtime (`Path.data`), sem rede no boot

**Status:** proposto
**Data:** 2026-10-16
**Origem:** defeito medido — a ingestão (E4) resolvia o banco por
`client.path.get().state` + `/kilo.db` e apontava para um diretório **sem**
banco, além de trocar rede no boot. Corrige o registro do BACKLOG e o
`ARCHITECTURE.md` §6. Complementa o **ADR-002** (assincronia) e a **E4**.

## Contexto

A E4 (ingestão assíncrona) precisa localizar o `kilo.db` — o banco SQLite do
runtime do Kilo, de onde as mensagens são lidas. A primeira implementação
derivava o caminho de `client.path.get().state` (uma chamada HTTP ao servidor
Kilo no boot), assumindo `<state>/kilo.db`.

Dois defeitos medidos nessa abordagem:

1. **Lugar errado.** O runtime guarda o banco em **`Path.data`**
   (`~/.local/share/kilo/kilo.db` neste host — arquivo real de ~1,7 GB), **não**
   em `Path.state` (`~/.local/state/kilo/`). `GET /path` só expõe
   `state`/`config`/`worktree`/`directory` (o SDK não tem `data`), então derivar
   de `state` apontava para um diretório vazio — a ingestão nunca achava o banco.
2. **Rede no boot = deadlock.** Resolver o caminho dentro do `server()` do plugin
   exigia aguardar uma chamada HTTP ao próprio servidor Kilo, que **ainda não
   atende requisições** durante o `server()` do plugin. Resultado: `server()`
   nunca retornava, `/session` e `/path` ficavam pendurados e a UI não abria.

## Decisão

**O caminho do `kilo.db` é derivado da regra do runtime, reproduzida
in-process, sem I/O de rede no boot.**

A regra (idêntica à do binário do Kilo — **verificada empiricamente** neste host:
`kilo.db` de ~1,8 GB em `~/.local/share/kilo/`, nenhum em `~/.local/state/kilo/`;
a fórmula exata do binário é *reverse-engineered* da regra observada, não de
fonte do runtime):

```
Path.data = join(XDG_DATA_HOME ?? ~/.local/share, "kilo")   // XDG só se absoluto
KILO_DB setado:
  - ":memory:"  ⇒ usado como está
  - absoluto    ⇒ usado como está
  - relativo    ⇒ join(Path.data, KILO_DB)
sem KILO_DB     ⇒ join(Path.data, "kilo.db")
```

`KILO_DB` relativo é resolvido **sem sanitizar `..`** (espelha o runtime): o alvo
é o env do próprio runtime, não entrada não-confiável de rede; sanitizar
divergiria do arquivo que o runtime de fato abre.

- O plugin roda **no mesmo processo** do runtime e herda o `process.env` — a
  regra é aplicada sobre esse env, então não há divergência nem chamada externa.
- A resolução é **síncrona e sem I/O** (`resolveRuntimeDbPath`): pode rodar no
  boot sem risco de deadlock. `DbPathSource` aceita `string | () => string |
  Promise<string>` — a string é a forma normal; o resolver fica disponível para
  desacoplar a resolução do boot quando um resolver externo o exigir.
- `XDG_DATA_HOME` relativo é **ignorado** (`isAbsolute`): um valor relativo
  resolveria contra o cwd do daemon e apontaria para o lugar errado.

## Consequências

**Positivas**

- A ingestão acha o banco no mesmo lugar que o runtime; some o deadlock de boot.
- Sem env nova: o caminho **não** é config do plugin (`KILOCODE_GRAPH_INGEST_DB_PATH`
  foi removida); a fonte é o runtime.
- Regra pura e testável (`defaultDbPath(env, home)`) — os testes cobrem `XDG`,
  `KILO_DB` absoluto/`:memory:`/relativo e a recusa do `state`.

**Negativas / limites**

- Replica uma regra do runtime: se o binário do Kilo mudar a fórmula (sufixo de
  canal, base do `KILO_DB` relativo), o plugin precisa acompanhar. Mitigação: a
  regra fica isolada em `ingest/db.ts` e tem teste de contrato.
- Não há verificação de existência do arquivo na resolução (o backend degrada na
  abertura) — um caminho errado aparece como ingestão sem dados, não como erro
  de boot.

## Alternativas descartadas

- **`client.path.get().state` + `/kilo.db`** — lugar errado (sem banco) e rede no
  boot (deadlock). Foi o defeito original.
- **Env própria (`KILOCODE_GRAPH_INGEST_DB_PATH`)** — já removida: duas fontes
  para "o default" divergiriam; a preferência registrada do dono é seguir o
  runtime.
- **Perguntar ao runtime por HTTP no boot** — o próprio deadlock; e `/path` não
  expõe `data` de qualquer forma.
