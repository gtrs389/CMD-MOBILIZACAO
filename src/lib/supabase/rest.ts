import 'server-only';
import { supabaseAuthHeaders, supabaseEnv } from './env';

/**
 * Cliente PostgREST minimo.
 *
 * Fala diretamente com a API REST do Supabase usando `fetch`, sempre no
 * servidor e sempre com a chave secreta. Nao existe cliente de navegador:
 * nenhuma tela consegue consultar o banco por conta propria.
 *
 * Nada aqui usa Supabase Authentication. A chave secreta ignora RLS, por isso
 * cada consulta abaixo ja carrega o filtro correto e toda rota que a utiliza
 * confere a sessao antes.
 */

export class SupabaseRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  /**
   * `details` e `hint` do PostgREST.
   *
   * Nao vao para o navegador em hipotese nenhuma — existem para o LOG do
   * servidor. Sem eles, uma violacao de check chega ao log dizendo apenas
   * que uma linha foi recusada, e nao QUAL coluna a recusou: e a diferenca
   * entre corrigir em minutos e caçar o problema no escuro.
   */
  readonly details: string | null;
  readonly hint: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: string | null = null,
    hint: string | null = null,
  ) {
    super(message);
    this.name = 'SupabaseRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }

  /** Violacao de unicidade (ex.: e-mail ou token repetido). */
  get isUniqueViolation(): boolean {
    return this.code === '23505';
  }

  /**
   * O banco nao tem a coluna, a tabela ou a funcao que o codigo pediu.
   *
   * Na pratica isso significa UMA coisa: a migration correspondente ainda
   * nao foi executada — ou foi, e o PostgREST ainda nao recarregou o cache
   * do schema. Sem distinguir esse caso, toda falha assim vira a mesma
   * mensagem generica de erro e a tela nao diz o que fazer, o que transforma
   * um `alter table` esquecido em uma caca ao bug.
   *
   * Dois mundos, e os dois precisam entrar:
   *
   *   POSTGRES   42703 coluna inexistente, 42P01 tabela inexistente. Sao os
   *              erros de quem consultou o banco direto.
   *   POSTGREST  PGRST202 funcao, PGRST204 coluna e PGRST205 tabela que nao
   *              estao NO CACHE dele. O PostgREST nem chega a perguntar ao
   *              banco: ele recusa antes, com codigo proprio.
   *
   * Faltava o segundo grupo, e e justamente o que aparece logo depois de uma
   * migration nova — o caso mais comum de todos.
   */
  get isMissingSchema(): boolean {
    if (
      this.code === '42703' ||
      this.code === '42P01' ||
      this.code === 'PGRST202' ||
      this.code === 'PGRST204' ||
      this.code === 'PGRST205'
    ) {
      return true;
    }

    // Rede de seguranca por TEXTO: algumas versoes do PostgREST recusam a
    // funcao ou a coluna ausente sem mandar `code` nenhum. Sem isto, o caso
    // mais comum depois de uma migration nova — "ja rodei o SQL, e continua
    // dando erro" — volta a ser um 500 que nao explica nada.
    const texto = this.message.toLowerCase();
    return texto.includes('schema cache') || texto.includes('does not exist');
  }

  /**
   * O banco existe, tem a estrutura, mas recusou por permissao.
   *
   * Tambem e configuracao pendente, e nao defeito: quase sempre a parte de
   * `grant` da migration nao foi executada. Merece mensagem propria, porque
   * a acao e outra — rodar o bloco de permissoes, e nao criar coluna.
   */
  get isMissingGrant(): boolean {
    return this.code === '42501';
  }

  /**
   * Regra de negocio recusada por uma funcao do banco (`raise exception`).
   *
   * P0001 nao e defeito: e o banco dizendo "isso nao pode", com um texto
   * curto escrito por nos na migration. Sem distinguir esse caso, a recusa
   * prevista virava a mesma falha generica de sempre e a tela nao dizia o
   * que fazer — quem clicou ficava sem saber que bastava ligar uma chave em
   * Configuracoes.
   *
   * A traducao para o texto da tela fica em `http.ts`, por lista fechada: o
   * texto do banco nunca e repassado ao navegador.
   */
  get isBusinessRule(): boolean {
    return this.code === 'P0001';
  }
}

type QueryValue = string | number | boolean | null | undefined;

export interface QueryOptions {
  select?: string;
  /** Filtros no formato PostgREST: `{ id: 'eq.123' }`. */
  filters?: Record<string, string>;
  order?: string;
  limit?: number;
  /** Ponto de partida, para ler alem da primeira pagina. */
  offset?: number;
  single?: boolean;
}

function buildUrl(table: string, options: QueryOptions): string {
  const { url } = supabaseEnv();
  const search = new URLSearchParams();

  if (options.select) search.set('select', options.select);
  for (const [key, value] of Object.entries(options.filters ?? {})) {
    search.append(key, value);
  }
  if (options.order) search.set('order', options.order);
  if (typeof options.limit === 'number') search.set('limit', String(options.limit));
  if (typeof options.offset === 'number' && options.offset > 0) {
    search.set('offset', String(options.offset));
  }

  const query = search.toString();
  return `${url}/rest/v1/${table}${query ? `?${query}` : ''}`;
}

async function request<T>(
  url: string,
  init: RequestInit & { prefer?: string[] },
): Promise<T> {
  const headers = supabaseAuthHeaders(init.headers);
  headers.set('Content-Type', 'application/json');
  if (init.prefer?.length) headers.set('Prefer', init.prefer.join(','));

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new SupabaseRequestError('Falha de conexão com o banco de dados.', 503, null);
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { message?: string; code?: string; details?: string; hint?: string }
      | null;
    throw new SupabaseRequestError(
      detail?.message ?? 'Erro ao consultar o banco de dados.',
      response.status,
      detail?.code ?? null,
      detail?.details ?? null,
      detail?.hint ?? null,
    );
  }

  if (response.status === 204) return null as T;
  const text = await response.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

/** Monta um filtro `in.(a,b,c)` com escape simples. */
export function inFilter(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/"/g, '""')}"`);
  return `in.(${escaped.join(',')})`;
}

/** Monta um filtro `not.in.(a,b,c)`. Usado para tirar os Times DEMO das metricas. */
export function notInFilter(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/"/g, '""')}"`);
  return `not.in.(${escaped.join(',')})`;
}

/**
 * Quantos identificadores cabem em UMA consulta por lista.
 *
 * O filtro `in.(...)` viaja na URL. Mil identificadores sao cerca de 37 KB de
 * endereco — muito acima do que o servidor aceita, e a consulta INTEIRA volta
 * como erro. Foi assim que a pagina de um Time DEMO de mil pessoas ficou
 * zerada: as pessoas estavam gravadas, o mapa (que le por outro caminho, com
 * menos linhas) as mostrava, e a lista morria montando a resposta.
 *
 * Cento e cinquenta por vez cabem com folga em qualquer limite de URL.
 */
export const IN_FILTER_CHUNK = 150;

/** Quantos lotes de uma lista longa vao ao banco ao mesmo tempo. */
const IN_FILTER_CONCURRENCY = 6;

/** A consulta carrega uma lista longa demais para uma URL? */
function longInFilter(
  filters: Record<string, string> | undefined,
): { key: string; values: string[] } | null {
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (!value.startsWith('in.(')) continue;
    const values = value.slice(4, -1).split(',');
    if (values.length > IN_FILTER_CHUNK) return { key, values };
  }
  return null;
}

/**
 * Consulta por lista longa, em lotes.
 *
 * O fatiamento acontece AQUI, e nao em cada chamada, de proposito: o limite e
 * da URL, nao de quem consulta, e uma regra escrita em um lugar so nao tem
 * como ser esquecida na proxima consulta que um dia receber mil
 * identificadores. As linhas dos lotes sao juntadas, entao a resposta e a
 * mesma que uma consulta unica daria.
 *
 * Um segundo filtro `in.(...)` no mesmo lugar continua inteiro: o fatiado e o
 * primeiro que passa do limite, que e o que cresce com o tamanho do time.
 */
async function selectInChunks<T>(
  table: string,
  options: QueryOptions,
  longo: { key: string; values: string[] },
): Promise<T[]> {
  const lotes: string[][] = [];
  for (let inicio = 0; inicio < longo.values.length; inicio += IN_FILTER_CHUNK) {
    lotes.push(longo.values.slice(inicio, inicio + IN_FILTER_CHUNK));
  }

  // Varios lotes ao mesmo tempo, com teto. Um atras do outro, o mapa de um
  // time de 5.000 pessoas fazia dezenas de idas ao banco em fila e levava
  // segundos so esperando a rede. A ordem das linhas continua a dos lotes.
  const resultados: T[][] = new Array(lotes.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < lotes.length) {
      const indice = proximo++;
      resultados[indice] =
        (await request<T[] | null>(
          buildUrl(table, {
            ...options,
            // Os pedacos voltam EXATAMENTE como estavam: `inFilter` ja pos as
            // aspas quando o filtro foi montado, e aspear de novo geraria
            // `""uuid""`, que o banco recusa (22P02).
            filters: { ...options.filters, [longo.key]: `in.(${lotes[indice].join(',')})` },
          }),
          { method: 'GET' },
        )) ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FILTER_CONCURRENCY, lotes.length) }, trabalhador));

  return resultados.flat();
}

/**
 * Quantas linhas o servidor devolve de uma vez.
 *
 * Nao e escolha nossa: o Supabase corta toda resposta em 1.000 linhas (o
 * "Max rows" do projeto). Passar `limit` maior nao adianta — quem corta e o
 * servidor, e ele corta EM SILENCIO: a resposta chega com 1.000 linhas e
 * status 200, sem aviso nenhum de que havia mais.
 *
 * Foi assim que a pagina de um Time DEMO de 1.553 pessoas mostrou 1.000 em
 * todos os quadros, com o ranking da equipe zerado: os recrutadores, que sao
 * as pessoas mais ANTIGAS, ficavam fora da janela devolvida.
 */
const PAGE_SIZE = 1000;

/** Teto de seguranca: 50 paginas. Nenhuma tela do sistema le tanto. */
const MAX_PAGES = 50;

export async function selectRows<T>(table: string, options: QueryOptions = {}): Promise<T[]> {
  // Lista longa demais para a URL: a consulta sai em lotes, e quem chamou nem
  // fica sabendo — a resposta e a mesma.
  const longo = longInFilter(options.filters);
  if (longo) return selectInChunks<T>(table, options, longo);

  // Com `limit` explicito, quem chamou disse quantas linhas quer: uma
  // requisicao so, como sempre foi.
  if (typeof options.limit === 'number') {
    const rows = await request<T[] | null>(buildUrl(table, options), { method: 'GET' });
    return rows ?? [];
  }

  // Sem `limit`, "todas" quer dizer TODAS. A primeira pagina e uma
  // requisicao igual a de antes; so quando ela volta CHEIA — sinal de que o
  // servidor cortou — e que vem a seguinte. Quase toda consulta do sistema
  // traz menos de mil linhas e continua custando uma requisicao.
  const todas: T[] = [];

  for (let pagina = 0; pagina < MAX_PAGES; pagina += 1) {
    const linhas =
      (await request<T[] | null>(
        buildUrl(table, {
          ...options,
          limit: PAGE_SIZE,
          offset: pagina * PAGE_SIZE,
          // Paginar sem ordem definida pode repetir uma linha em duas
          // paginas e perder outra: sem `order`, o banco nao promete ordem
          // nenhuma entre uma consulta e a seguinte.
          order: options.order ?? 'id.asc',
        }),
        { method: 'GET' },
      )) ?? [];

    todas.push(...linhas);
    if (linhas.length < PAGE_SIZE) break;
  }

  return todas;
}

export async function selectOne<T>(table: string, options: QueryOptions = {}): Promise<T | null> {
  const rows = await selectRows<T>(table, { ...options, limit: options.limit ?? 1 });
  return rows[0] ?? null;
}

/**
 * Iguala as chaves de um envio em lote.
 *
 * O PostgREST exige que TODAS as linhas de um insert em lote tenham
 * exatamente as mesmas chaves: uma linha a menos e ele recusa o lote inteiro
 * com `PGRST102 All object keys must match` — sem dizer qual chave, qual
 * linha, nem qual tabela.
 *
 * E facil demais escrever duas linhas quase iguais e esquecer uma coluna que
 * so faz sentido em uma delas. Em vez de confiar na disciplina de quem
 * escreve, o lote e alinhado aqui: quem nao tem a chave recebe `null`
 * explicito.
 *
 * Isso nao muda comportamento nenhum que funcionasse antes — um lote com
 * chaves diferentes SEMPRE falhava. E o null explicito falha alto, e nao em
 * silencio: coluna obrigatoria sem valor vira 23502, que a tela ja traduz
 * como dado faltando.
 */
export function alignRowKeys(
  values: Record<string, QueryValue | object>[],
): Record<string, QueryValue | object>[] {
  if (values.length < 2) return values;

  const chaves = new Set<string>();
  for (const value of values) for (const chave of Object.keys(value)) chaves.add(chave);

  // Todas ja iguais: nada a fazer, e o objeto original segue intacto.
  const iguais = values.every((value) => Object.keys(value).length === chaves.size);
  if (iguais) return values;

  return values.map((value) => {
    const completa: Record<string, QueryValue | object> = {};
    for (const chave of chaves) completa[chave] = chave in value ? value[chave] : null;
    return completa;
  });
}

export async function insertRows<T>(
  table: string,
  values: Record<string, QueryValue | object>[],
  select = '*',
): Promise<T[]> {
  if (values.length === 0) return [];
  const rows = await request<T[] | null>(buildUrl(table, { select }), {
    method: 'POST',
    body: JSON.stringify(alignRowKeys(values)),
    prefer: ['return=representation'],
  });
  return rows ?? [];
}

/**
 * Tamanho de cada lote de escrita.
 *
 * Um envio unico de milhares de linhas nao falha por limite de linhas: falha
 * pelo TAMANHO do corpo e pelo tempo da requisicao, e quando falha nao grava
 * nada — e com um Time DEMO de milhares de pessoas isso significa perder a
 * criacao inteira no fim. Quinhentas linhas por vez cabem com folga em
 * qualquer um dos dois limites.
 */
export const INSERT_CHUNK = 500;

/**
 * Insercao em lotes, para volumes grandes.
 *
 * Cada lote e uma requisicao propria: o PostgREST nao abre transacao entre
 * elas, entao quem chama precisa saber desfazer o que ja entrou. Os Times
 * DEMO sabem — a falha exclui o time, e a cascata do banco leva o resto.
 */
export async function insertRowsInChunks<T>(
  table: string,
  values: Record<string, QueryValue | object>[],
  select = '*',
  size = INSERT_CHUNK,
): Promise<T[]> {
  if (values.length <= size) return insertRows<T>(table, values, select);

  const gravados: T[] = [];
  for (let inicio = 0; inicio < values.length; inicio += size) {
    gravados.push(...(await insertRows<T>(table, values.slice(inicio, inicio + size), select)));
  }
  return gravados;
}

/**
 * Grava ou atualiza pela chave unica (`onConflict`), sem devolver as linhas.
 *
 * Para cargas repetiveis, como a planilha do TSE: enviar o mesmo arquivo de
 * novo atualiza cada linha no lugar, nunca duplica. Em lotes, como a
 * insercao, pelo mesmo motivo de tamanho do corpo.
 */
export async function upsertRows(
  table: string,
  values: Record<string, QueryValue | object>[],
  onConflict: string,
  size = INSERT_CHUNK,
): Promise<void> {
  for (let inicio = 0; inicio < values.length; inicio += size) {
    const search = new URLSearchParams({ on_conflict: onConflict });
    await request<null>(`${buildUrl(table, {})}?${search}`, {
      method: 'POST',
      body: JSON.stringify(alignRowKeys(values.slice(inicio, inicio + size))),
      prefer: ['resolution=merge-duplicates', 'return=minimal'],
    });
  }
}

export async function insertOne<T>(
  table: string,
  value: Record<string, QueryValue | object>,
  select = '*',
): Promise<T> {
  const [row] = await insertRows<T>(table, [value], select);
  if (!row) throw new SupabaseRequestError('Registro não pode ser criado.', 500, null);
  return row;
}

/**
 * Escrita por lista longa, em lotes.
 *
 * O mesmo limite de `selectInChunks`, e pela mesma razao: o filtro
 * `in.(...)` viaja na URL, e mil identificadores sao cerca de 37 KB de
 * endereco — acima do que o servidor aceita. A requisicao INTEIRA volta como
 * erro, e sem codigo do Postgres, porque nem chegou a virar consulta.
 *
 * Faltava aqui. A regra estava escrita so na leitura, e a promessa de que
 * "uma regra em um lugar so nao tem como ser esquecida" nao se cumpriu: a
 * primeira escrita que recebeu centenas de identificadores — apagar a
 * segunda camada de um Time DEMO — morreu exatamente assim.
 */
async function writeInChunks<T>(
  table: string,
  filters: Record<string, string>,
  select: string,
  longo: { key: string; values: string[] },
  enviar: (url: string) => Promise<T[] | null>,
): Promise<T[]> {
  const linhas: T[] = [];

  for (let inicio = 0; inicio < longo.values.length; inicio += IN_FILTER_CHUNK) {
    const lote = longo.values.slice(inicio, inicio + IN_FILTER_CHUNK);
    const url = buildUrl(table, {
      // Os pedacos voltam EXATAMENTE como estavam: `inFilter` ja pos as
      // aspas, e aspear de novo geraria `""uuid""`, que o banco recusa.
      filters: { ...filters, [longo.key]: `in.(${lote.join(',')})` },
      select,
    });
    linhas.push(...((await enviar(url)) ?? []));
  }

  return linhas;
}

export async function updateRows<T>(
  table: string,
  filters: Record<string, string>,
  values: Record<string, QueryValue | object>,
  select = '*',
): Promise<T[]> {
  const enviar = (url: string) =>
    request<T[] | null>(url, {
      method: 'PATCH',
      body: JSON.stringify(values),
      prefer: ['return=representation'],
    });

  const longo = longInFilter(filters);
  if (longo) return writeInChunks<T>(table, filters, select, longo, enviar);

  return (await enviar(buildUrl(table, { filters, select }))) ?? [];
}

export async function deleteRows<T>(
  table: string,
  filters: Record<string, string>,
  select = 'id',
): Promise<T[]> {
  const enviar = (url: string) =>
    request<T[] | null>(url, { method: 'DELETE', prefer: ['return=representation'] });

  const longo = longInFilter(filters);
  if (longo) return writeInChunks<T>(table, filters, select, longo, enviar);

  return (await enviar(buildUrl(table, { filters, select }))) ?? [];
}

/**
 * Executa uma funcao SQL pelo endpoint de RPC do PostgREST.
 * Usado apenas onde a operacao precisa acontecer em uma transacao so.
 */
export async function callFunction<T>(
  name: string,
  // `object` cobre os argumentos `jsonb`, que chegam como array ou objeto.
  args: Record<string, QueryValue | object>,
): Promise<T> {
  const { url } = supabaseEnv();
  return request<T>(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
}
