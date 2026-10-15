/**
 * Provisionamento do workspace memtier 1:1 e escrita da chave do workspace.
 *
 * Cada workspace Kilo mapeia 1:1 para um workspace memtier. A chave do bearer de
 * **usuário** do workspace vive em `<workspace>/.kilo/graph-key.json`
 * (`{ token, workspace, program }`, `0600`) e é o controle do vínculo 1:1.
 *
 * Quando o bearer do **gestor** está no ambiente (`KILOCODE_GRAPH_MANAGER_TOKEN`)
 * e a chave do workspace **não existe**, o plugin cria o workspace memtier e
 * salva o bearer resultante no `.kilo/` — o usuário não faz onboarding manual.
 *
 * Fluxo no plano de controle do memtier (medido em
 * `graphiti-daemon/src/memtier/main.py`):
 *   1. `POST /v1/mgmt/programs`   `{programa}`           (409 = já existe ⇒ segue)
 *   2. `POST /v1/mgmt/workspaces` `{programa, workspace}` → `group_id`
 *   3. `POST /v1/mgmt/invites`    `{kind:"user", name, programa, workspace}` → `invite_id`
 *   4. `POST /v1/auth/claim-user` `{invite_id}`           → bearer show-once (`must_rotate`)
 *   5. `POST /v1/auth/rotate`     (Bearer do claim)       → bearer definitivo
 *
 * **A rotação é obrigatória.** O bearer nascido do claim tem `must_rotate=true` e
 * o plano de dados responde **403 `rotation_required`** até ser rotacionado
 * (`main.py:_assert_rotated`, L452). Persistir o bearer do claim (não rotacionado)
 * deixaria toda chamada de dados em 403 — por isso o passo 5 nunca é pulado.
 *
 * Degradação (NFR-03): `ensureWorkspaceKey` **nunca lança**. Falha de rede/HTTP
 * vira log e `{ provisioned:false }`; o plugin segue e a borda responde 401,
 * exatamente como quando a chave está ausente.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { type FetchLike, httpError, MemtierHttpError } from "./client.ts";
import { debug, log, logFatal } from "./logger.ts";

/**
 * Orçamento de parede do provisionamento inteiro (ms). Um ÚNICO
 * `AbortSignal.timeout` é compartilhado pelos 5 requests, então o boot nunca
 * trava mais que isto — mesmo com o memtier fora do ar.
 */
export const DEFAULT_PROVISION_TIMEOUT_MS = 6000;

/** Razão de um `ProvisionOutcome` (observabilidade / teste). */
export type ProvisionReason =
  | "disabled" // sem `KILOCODE_GRAPH_MANAGER_TOKEN`
  | "exists" // chave do workspace já presente e utilizável
  | "provisioned" // workspace criado + chave gravada
  | "failed"; // qualquer falha no fluxo (degradado, nunca lança)

export interface ProvisionOutcome {
  provisioned: boolean;
  reason: ProvisionReason;
}

/** IO injetável (teste sem tocar o disco; produção usa `node:fs`). */
export interface ProvisionIo {
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  writeFile?: (path: string, data: string) => void;
  rename?: (from: string, to: string) => void;
  mkdir?: (path: string) => void;
}

export interface ProvisionOptions {
  /** Base do memtier (`daemon.url`). */
  url: string;
  /** Bearer do gestor (`KILOCODE_GRAPH_MANAGER_TOKEN`). Vazio ⇒ desligado. */
  managerToken: string;
  /** Nome lógico do workspace (`workspaceName(dir)`). */
  workspace: string;
  /** Programa dono (`daemon.program`). */
  program: string;
  /** Caminho absoluto de `<workspace>/.kilo/graph-key.json`. */
  keyFile: string;
  /** Nome do invite de user (default: o próprio `workspace`). */
  name?: string;
  /** Orçamento de parede do fluxo inteiro (ms). Default 6000. */
  timeout_ms?: number;
  /** `fetch` injetável (default `globalThis.fetch`). */
  fetch?: FetchLike;
  /** IO injetável. */
  io?: ProvisionIo;
  /**
   * Sufixo de unicidade do arquivo temporário (default: `process.pid`). Dois
   * boots concorrentes do mesmo workspace não podem truncar o MESMO `.tmp`
   * (interleaved `writeFileSync` corromperia o JSON). Injetável para teste.
   */
  tmpSuffix?: string;
}

/**
 * Trava por `keyFile` (mesmo padrão do mutex por workspace da ingestão,
 * `routine.ts`): serializa `ensureWorkspaceKey` entre chamadas concorrentes no
 * MESMO processo. Dois boots do mesmo workspace não rodam o fluxo de 5 passos
 * em paralelo (evita dois invites/claims/rotates e corrida de escrita).
 * Cross-process (duas janelas Kilo) é coberto pela escrita atômica com `.tmp`
 * único + `rename` (o último vence, sem corromper); a trava cobre o caso comum
 * (mesmo processo, múltiplos `server()`).
 */
const provisionLocks = new Map<string, Promise<ProvisionOutcome>>();

/** Corpo persistido em `graph-key.json` (mesmo shape do bearer manual). */
export interface WorkspaceKey {
  token: string;
  workspace: string;
  program: string;
}

/** Resposta de `POST /v1/mgmt/invites` (só o campo consumido). */
interface InviteResponse {
  invite_id?: unknown;
}

/** Resposta de claim/rotate (só o bearer show-once). */
interface TokenResponse {
  token?: unknown;
}

/**
 * `true` quando a chave do workspace existe e carrega um `token` não-vazio.
 * Ausente/corrompido ⇒ `false` (provisiona por cima — nunca trava num arquivo
 * inválido).
 */
export function hasUsableKey(
  keyFile: string,
  io: Pick<ProvisionIo, "readFile" | "exists"> = {},
): boolean {
  if (!keyFile) return false;
  const exists = io.exists ?? existsSync;
  const readFile = io.readFile ?? ((p) => readFileSync(p, "utf-8"));
  if (!exists(keyFile)) return false;
  try {
    const parsed = JSON.parse(readFile(keyFile)) as Partial<WorkspaceKey>;
    return typeof parsed.token === "string" && parsed.token.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Garante a chave do workspace: se o bearer do gestor estiver definido e a chave
 * ausente, provisiona o workspace memtier e grava a chave. **Nunca lança**.
 *
 * Chamadas concorrentes no MESMO processo são serializadas por `keyFile`
 * (`provisionLocks`) — o segundo chamador reusa o resultado do primeiro (que já
 * gravou a chave) em vez de rodar o fluxo de novo.
 */
export async function ensureWorkspaceKey(
  opts: ProvisionOptions,
): Promise<ProvisionOutcome> {
  const managerToken = opts.managerToken?.trim() ?? "";
  if (!managerToken) {
    debug("provision: desligado (KILOCODE_GRAPH_MANAGER_TOKEN ausente)");
    return { provisioned: false, reason: "disabled" };
  }
  // Sem arquivo de chave não há onde persistir: provisionar queimaria um bearer
  // show-once (invite/claim) que se perderia. Recusa antes de qualquer request.
  if (!opts.keyFile) {
    log("provision: sem caminho de chave (token_file vazio); ignorado");
    return { provisioned: false, reason: "failed" };
  }
  if (hasUsableKey(opts.keyFile, opts.io)) {
    debug(`provision: chave do workspace já existe (${opts.keyFile})`);
    return { provisioned: false, reason: "exists" };
  }

  const lockKey = opts.keyFile;
  const inflight = provisionLocks.get(lockKey);
  if (inflight) {
    debug(`provision: já em andamento (${lockKey}); aguardando`);
    return inflight;
  }
  const run = doEnsure(opts, managerToken).finally(() => {
    if (provisionLocks.get(lockKey) === run) provisionLocks.delete(lockKey);
  });
  provisionLocks.set(lockKey, run);
  return run;
}

/** Corpo de `ensureWorkspaceKey` sob a trava (nunca lança). */
async function doEnsure(
  opts: ProvisionOptions,
  managerToken: string,
): Promise<ProvisionOutcome> {
  try {
    const token = await provisionWorkspace(opts, managerToken);
    writeKeyFile(opts, {
      token,
      workspace: opts.workspace,
      program: opts.program,
    });
    // Nunca logar o token: só o escopo.
    log(`provision ok workspace=${opts.workspace} program=${opts.program}`);
    return { provisioned: true, reason: "provisioned" };
  } catch (err) {
    logFatal("provision", err);
    return { provisioned: false, reason: "failed" };
  }
}

/** Executa os 5 passos do plano de controle e devolve o bearer rotacionado. */
async function provisionWorkspace(
  opts: ProvisionOptions,
  managerToken: string,
): Promise<string> {
  const base = opts.url.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
  const budget = opts.timeout_ms ?? DEFAULT_PROVISION_TIMEOUT_MS;
  // Um único orçamento de parede para os 5 requests (ver o const).
  const signal = budget > 0 ? AbortSignal.timeout(budget) : undefined;

  const post = async (
    path: string,
    body: unknown,
    bearer: string | null,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    return fetchImpl(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  };

  // 1. Programa (idempotente): 409 = já existe ⇒ segue para o workspace.
  const prog = await post(
    "/v1/mgmt/programs",
    { programa: opts.program },
    managerToken,
  );
  if (!prog.ok && prog.status !== 409) {
    throw httpError(prog.status, await detail(prog));
  }

  // 2. Workspace (1:1). 201 criado / 200 idempotente; 403 = gestor não owns.
  const ws = await post(
    "/v1/mgmt/workspaces",
    { programa: opts.program, workspace: opts.workspace },
    managerToken,
  );
  if (!ws.ok) throw httpError(ws.status, await detail(ws));

  // 3. Invite de user escopado ao par (programa, workspace).
  const inv = await post(
    "/v1/mgmt/invites",
    {
      kind: "user",
      name: opts.name ?? opts.workspace,
      programa: opts.program,
      workspace: opts.workspace,
    },
    managerToken,
  );
  if (!inv.ok) throw httpError(inv.status, await detail(inv));
  const inviteId = ((await inv.json()) as InviteResponse).invite_id;
  if (typeof inviteId !== "string" || inviteId === "") {
    throw new Error("provision: invite sem `invite_id` na resposta");
  }

  // 4. Claim do user → bearer show-once (`must_rotate=true`). Rota sem auth.
  const claim = await post("/v1/auth/claim-user", { invite_id: inviteId }, null);
  if (!claim.ok) throw httpError(claim.status, await detail(claim));
  const claimed = ((await claim.json()) as TokenResponse).token;
  if (typeof claimed !== "string" || claimed === "") {
    throw new Error("provision: claim-user sem `token` na resposta");
  }

  // 5. Rotação OBRIGATÓRIA: sem ela o plano de dados responde 403
  //    `rotation_required` (the claimed bearer has must_rotate=true).
  const rotated = await post("/v1/auth/rotate", undefined, claimed);
  if (!rotated.ok) throw httpError(rotated.status, await detail(rotated));
  const token = ((await rotated.json()) as TokenResponse).token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("provision: rotate sem `token` na resposta");
  }
  // Defesa: um rotate que devolvesse o MESMO bearer do claim significaria que a
  // rotação não aconteceu — persistir esse bearer deixaria toda chamada de dados
  // em 403 `rotation_required` (o claim nasce `must_rotate=true`). O memtier real
  // sempre emite um token novo (burn-and-replace, `iam.py:1334`); o guard cobre
  // proxy/replay que ecoe o token de entrada.
  if (token === claimed) {
    throw new Error("provision: rotate devolveu o mesmo bearer do claim");
  }
  return token.trim();
}

/** Lê o `detail` de uma resposta não-2xx sem lançar (para a mensagem tipada). */
async function detail(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "unknown error";
  }
}

/**
 * Grava a chave com escrita atômica (tmp + rename) e modo `0600`: um crash no
 * meio nunca deixa um JSON pela metade, e o segredo não nasce legível por
 * terceiros. Cria o `.kilo/` quando não existir. IO injetável para teste.
 */
export function writeKeyFile(opts: ProvisionOptions, key: WorkspaceKey): void {
  const io = opts.io ?? {};
  const write =
    io.writeFile ??
    ((p: string, d: string) =>
      writeFileSync(p, d, { encoding: "utf-8", mode: 0o600 }));
  const rename = io.rename ?? renameSync;
  const mkdir = io.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  const dir = dirname(opts.keyFile);
  if (dir && dir !== ".") mkdir(dir);
  // `.tmp` ÚNICO por processo (`pid`): dois boots concorrentes não truncam o
  // mesmo arquivo (interleaved write corromperia o JSON). O `rename` é atômico —
  // o último vence, sem estado parcial.
  const suffix = opts.tmpSuffix ?? String(process.pid);
  const tmp = `${opts.keyFile}.tmp.${suffix}`;
  try {
    write(tmp, `${JSON.stringify(key, null, 2)}\n`);
    // `mode:0o600` só vale na CRIAÇÃO: um `.tmp` pré-existente (0644, deixado por
    // crash ou por terceiro) manteria a permissão frouxa. Reforça explicitamente
    // antes do rename — o segredo nunca fica legível por outros.
    if (!io.writeFile) {
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // best-effort: em plataformas sem POSIX o modo é ignorado.
      }
    }
    rename(tmp, opts.keyFile);
  } finally {
    // Nunca deixa um `.tmp` órfão com um bearer vivo (crash entre write e
    // rename, ou erro do chmod). `rmSync` força é no-op se já renomeado.
    if (!io.rename) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort.
      }
    }
  }
}

/** Reexport para testes que afirmam o tipo de erro tipado do fluxo. */
export { MemtierHttpError };
