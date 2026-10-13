import 'server-only';
import type { Client, TeamPersonInput } from '@/lib/types';
import {
  DEMO_DEFAULTS,
  DEMO_LIMITS,
  DEMO_PROVIDER,
  buildDemoData,
  clampCount,
  type DemoData,
} from '@/lib/domain/demo';
import {
  DEMO_SECOND_LAYER_SEED,
  DEMO_SEED_VERSION,
  DEMO_STATE,
} from '@/lib/domain/demo-catalog';
import { clampRecruiters, shareAmongRecruiters } from '@/lib/domain/demo-recruiters';
import { normalizePhone } from '@/lib/utils/phone';
import {
  TABLES,
  type MapLocationRow,
  type MemberLocationRow,
  type MemberRow,
  type UserRow,
} from '@/lib/supabase/tables';
import {
  callFunction,
  deleteRows,
  inFilter,
  insertOne,
  insertRowsInChunks,
  selectRows,
  updateRows,
  SupabaseRequestError,
} from '@/lib/supabase/rest';
import { deleteImage } from '@/lib/supabase/storage';
import { createClient, deleteClient, getClient } from './client.service';
import {
  pollingPlaceLookup,
  rememberOfficialPlaces,
  residenceLookupFor,
  resolveDemoPoint,
} from './demo-locations';
import { demoSchoolsFor, demoSchoolsOfTeam, type DemoSchools } from './demo-schools';
import type { DemoSchoolSource } from '@/lib/domain/demo-tse';
import { badRequest, notFound } from './http';

/**
 * Criacao e correcao de um Time DEMO.
 *
 * O Time DEMO e um time DE VERDADE: mesmas tabelas, mesmas telas, mesmos
 * servicos. Nao existe tela falsa, tabela paralela nem numero chumbado em
 * componente — o que a pagina do time mostra sai das mesmas consultas que
 * mostram um time real.
 *
 * O que ele tem de diferente e um sinal, `is_demo`, que o mantem fora de
 * toda metrica global (ver `demo-scope.ts`), e o fato de que os dados dele
 * sao gerados aqui, no servidor.
 *
 * OS LUGARES SAO REAIS, E DE ALAGOAS. As escolas saem da tabela oficial do
 * TSE (`cmd_polling_places`), sorteadas pela semente do time entre centenas
 * de locais de votacao alagoanos (`demo-tse.ts`), com zona, secao e a
 * coordenada oficial — copiada da tabela, sem consulta paga. Sem a tabela
 * carregada, vale o catalogo conferido (`demo-catalog.ts`). As moradias sao
 * ruas reais das proprias escolas, resolvidas pela consulta de endereco do
 * sistema (`demo-locations.ts`); nenhuma coordenada e escrita a mao nem
 * deslocada, e o que nao passa pelas barreiras de Alagoas nao vira ponto.
 *
 * AS PESSOAS sao ficticias: nome montado de listas, telefone de uma faixa de
 * demonstracao com DDD 82. Sem CPF, sem titulo de eleitor, sem e-mail e sem
 * nenhum retorno de consulta cadastral.
 *
 * QUEM TEM ACESSO AO PAINEL: somente os administradores que o ADMIN geral
 * cadastrou a mao. As pessoas ficticias sao DADOS, e nada mais — elas
 * existem em `cmd_members` e em nenhum outro lugar. Sem usuario, sem senha,
 * sem sessao, sem link de acesso, sem aparelho vinculado e sem convite
 * pessoal.
 *
 * A criacao e ATOMICA na pratica: o PostgREST nao abre transacao entre
 * chamadas, entao qualquer falha depois do time criado desfaz tudo pelo
 * caminho que o proprio sistema ja usa — excluir o time, que leva junto, em
 * cascata, campos, pessoas, acessos, integrantes e vinculos de mapa.
 *
 * Repetir a requisicao NAO duplica: a chave de idempotencia e reservada no
 * banco antes de qualquer escrita (migration 033), e a segunda chamada
 * recebe o time que a primeira criou.
 */

export interface DemoAdminInput {
  name: string;
  phone: string;
  /** Data URL da foto. Opcional. */
  photo?: string | null;
}

export interface CreateDemoTeamInput {
  name: string;
  /** Foto do time. Opcional. */
  photo?: string | null;
  /**
   * Banner do celular do proprio Time DEMO (migration 035). Opcional.
   *
   * Sem ele, a tela publica do time cai na faixa de convite comum — e nunca
   * no banner de producao de um cliente real, que era o que acontecia quando
   * havia um unico banner para o sistema inteiro.
   */
  banner?: string | null;
  admins: DemoAdminInput[];
  people: number;
  places: number;
  /**
   * Segunda camada: quantas pessoas do time TAMBEM recrutam.
   *
   * Opcional — zero nao faz nada, e o time nasce de uma camada so. Pode ser
   * ajustado depois, na pagina do time, quantas vezes for preciso.
   */
  recruiters?: number;
  /** Quantas pessoas essa segunda camada traz, ao todo. */
  recruiterPeople?: number;
  /** Chave de idempotencia criada pelo navegador. */
  seedKey: string;
}

interface ClaimRow {
  seed_id: string;
  client_id: string | null;
  claimed: boolean;
}

type Admin = Pick<UserRow, 'id' | 'name' | 'phone'>;

/* -------------------------------------------------------------------------
   Criacao
   ------------------------------------------------------------------------- */

export async function createDemoTeam(
  input: CreateDemoTeamInput,
  admin: { id: string },
): Promise<Client> {
  const nome = input.name.trim();
  if (nome.length < 2) throw badRequest('Dê um nome ao Time DEMO.');

  if (!input.admins?.length) {
    throw badRequest('Cadastre pelo menos um administrador do time.');
  }
  const people = clampCount(input.people, DEMO_LIMITS.minPeople, DEMO_LIMITS.maxPeople);
  const places = clampCount(input.places, DEMO_LIMITS.minPlaces, DEMO_LIMITS.maxPlaces);

  // 1. Reserva a chave ANTES de escrever qualquer coisa. Dois cliques, um
  //    duplo envio ou uma repeticao automatica caem aqui.
  const rows = await callFunction<ClaimRow[]>('cmd_demo_claim', {
    p_seed_key: input.seedKey,
    p_user_id: admin.id,
  });
  const claim = Array.isArray(rows) ? rows[0] : null;
  if (!claim) throw badRequest('Não foi possível iniciar a criação.');

  if (!claim.claimed) {
    // Chave ja usada: devolve o time daquela criacao, em vez de criar outro.
    if (!claim.client_id) {
      throw badRequest('A criação deste Time DEMO já está em andamento. Aguarde um instante.');
    }
    const existente = await getClient(claim.client_id);
    if (existente) return existente;
    throw notFound('Time DEMO não encontrado.');
  }

  let clientId: string | null = null;
  /** Coordenadas criadas AQUI: so elas podem ser desfeitas. */
  const pontos: string[] = [];

  try {
    // 2. O time nasce pelo MESMO caminho de um time real: campos padrao dos
    //    formularios, administradores com acesso por telefone e os dois
    //    enderecos de acesso. A unica diferenca e o sinal `is_demo`.
    const criado = await createClient(
      {
        name: nome,
        photo: input.photo ?? null,
        banner: input.banner ?? null,
        notes: 'Time de demonstração. Os dados são fictícios e ficam fora dos números reais.',
        // O catalogo do Time DEMO e de Alagoas, e os locais de votacao dele
        // sao reais: o time nasce com o estado dos proprios dados, e nao
        // vazio. Municipio fica em branco — sao varios, e "nao restringiu" e
        // a resposta certa aqui.
        stateUf: DEMO_STATE,
        people: input.admins.map<TeamPersonInput>((person) => ({
          name: person.name,
          phone: person.phone,
          photo: person.photo ?? null,
        })),
      },
      { isDemo: true },
    );
    clientId = criado.id;

    const schools = await demoSchoolsFor(places, input.seedKey);
    await seedDemoContent(criado, { people, places, seedKey: input.seedKey, schools }, pontos);

    // Segunda camada, quando pedida. Fica DEPOIS das pessoas porque e sobre
    // elas que ela trabalha: escolhe quem tambem recruta e redistribui os
    // cadastros. Zero — o padrao — nao faz nada, e o time nasce de uma
    // camada so, como sempre nasceu.
    if ((input.recruiters ?? 0) > 0 && (input.recruiterPeople ?? 0) > 0) {
      await setDemoRecruiters(criado.id, {
        recruiters: input.recruiters ?? 0,
        people: input.recruiterPeople ?? 0,
      });
    }

    await markSeeded(criado.id);
    await updateSeed(claim.seed_id, criado.id);

    // Recarrega pelo caminho normal: e exatamente o que a pagina do time vai
    // ler depois.
    const pronto = await getClient(criado.id);
    if (!pronto) throw notFound('Time DEMO não encontrado depois da criação.');
    return pronto;
  } catch (error) {
    // 3. Desfaz tudo. Excluir o time leva junto, em cascata, campos,
    //    administradores, acessos, integrantes e vinculos de mapa — e a
    //    reserva sai para a mesma chave poder tentar de novo.
    if (clientId) await deleteClient(clientId).catch(() => undefined);
    // O cache de coordenadas nao tem `client_id`: excluir o time nao leva os
    // pontos junto. Saem apenas os que ESTA criacao gravou — um ponto que ja
    // existia serve a outros times e nao e nosso para apagar.
    if (pontos.length > 0) {
      await deleteRows(TABLES.mapLocations, { id: inFilter(pontos) }).catch(() => []);
    }
    await deleteRows(TABLES.demoSeeds, { id: `eq.${claim.seed_id}` }).catch(() => []);
    throw error;
  }
}

/**
 * Fecha a reserva, ligando-a ao time criado.
 *
 * E o que faz a segunda requisicao com a mesma chave devolver ESTE time em
 * vez de criar outro.
 */
async function updateSeed(seedId: string, clientId: string): Promise<void> {
  await updateRows(
    TABLES.demoSeeds,
    { id: `eq.${seedId}` },
    { client_id: clientId, finished_at: new Date().toISOString() },
    'id',
  );
}

/**
 * Anota no time qual catalogo gerou os dados que ele tem agora.
 *
 * Falha em silencio de proposito. Isto e ANOTACAO: serve para a rotina de
 * correcao saber em que versao o time esta. Um banco ainda sem a migration
 * 034 nao tem a coluna — e perder um time inteiro de mil pessoas, ja gravado,
 * por causa de uma anotacao seria absurdo.
 */
async function markSeeded(clientId: string): Promise<void> {
  await updateRows(
    TABLES.clients,
    { id: `eq.${clientId}` },
    { demo_seed_version: DEMO_SEED_VERSION },
    'id',
  ).catch(() => []);
}

/* -------------------------------------------------------------------------
   Correcao de um Time DEMO ja criado
   ------------------------------------------------------------------------- */

export interface DemoRefreshReport {
  clientId: string;
  /** Catalogo aplicado. */
  version: string;
  /** De onde vieram as escolas: tabela oficial do TSE ou catalogo conferido. */
  source: DemoSchoolSource;
  /** Municipios alcancados. */
  cities: number;
  /** Pessoas ficticias removidas (as da geracao anterior). */
  removed: number;
  /** Pessoas ficticias criadas agora. */
  people: number;
  /** Locais de votacao do catalogo usados. */
  places: number;
  /** Coordenadas aceitas e recusadas nesta passagem. */
  points: { resolved: number; missing: number };
}

/**
 * Regenera SOMENTE os dados gerados de um Time DEMO.
 *
 * O que NAO e tocado: o time, o nome, a foto, os administradores, os acessos
 * deles, os links do time, o formulario, o questionario, as configuracoes e
 * qualquer pessoa cadastrada a mao. Sai apenas o que carrega a marca
 * `demo_seed` — ou seja, o que este gerador criou.
 *
 * RODAR DUAS VEZES NAO DUPLICA: a rotina apaga a geracao anterior antes de
 * escrever a nova, e a semente e a mesma (a chave da criacao original), entao
 * o resultado e identico. Nao ha o que somar.
 *
 * Time real nunca entra aqui: sem `is_demo`, a rotina recusa.
 */
/** Tamanho pedido para a nova geracao. Ausente, vale o padrao. */
export interface DemoRefreshInput {
  people?: number;
  places?: number;
}

export async function refreshDemoTeam(
  clientId: string,
  input: DemoRefreshInput = {},
): Promise<DemoRefreshReport> {
  const client = await getClient(clientId);
  if (!client) throw notFound('Time não encontrado.');
  if (!client.isDemo) throw badRequest('Só um Time DEMO pode ter os dados regerados.');

  const admins = await demoAdmins(clientId);

  // Quantas pessoas o time tinha: a escolha de quem o criou e mantida.
  // Sem a migration 034 a coluna da marca nao existe: nesse caso a correcao
  // trata TODAS as pessoas do Time DEMO como geradas — que e o que elas sao,
  // porque sem a coluna tambem nao houve como marcar outra coisa.
  const anteriores = await selectRows<Pick<MemberRow, 'id' | 'photo_path'>>(TABLES.members, {
    select: 'id,photo_path',
    filters: { client_id: `eq.${clientId}`, demo_seed: 'not.is.null' },
    limit: DEMO_LIMITS.maxPeople,
  }).catch(async (error: unknown) => {
    const faltaColuna = error instanceof SupabaseRequestError && error.isMissingSchema;
    if (!faltaColuna) throw error;
    return selectRows<Pick<MemberRow, 'id' | 'photo_path'>>(TABLES.members, {
      select: 'id,photo_path',
      filters: { client_id: `eq.${clientId}` },
      limit: DEMO_LIMITS.maxPeople,
    });
  });
  // Sem tamanho pedido, a equipe nunca encolhe na correcao: um time criado
  // com o padrao antigo sobe para o padrao atual, e um time que o ADMIN
  // montou maior continua do tamanho que ele escolheu. Com tamanho pedido —
  // o ADMIN escolheu na tela —, vale o pedido.
  const people = clampCount(
    input.people ?? Math.max(anteriores.length, DEMO_DEFAULTS.people),
    DEMO_LIMITS.minPeople,
    DEMO_LIMITS.maxPeople,
  );
  const places = clampCount(
    input.places ?? DEMO_DEFAULTS.places,
    DEMO_LIMITS.minPlaces,
    DEMO_LIMITS.maxPlaces,
  );

  // A semente original: os nomes e a distribuicao continuam os mesmos do time
  // que o ADMIN ja conhece.
  const [reserva] = await selectRows<{ seed_key: string }>(TABLES.demoSeeds, {
    select: 'seed_key',
    filters: { client_id: `eq.${clientId}` },
    order: 'created_at.asc',
    limit: 1,
  });

  // 1. Fora a geracao anterior. A cascata leva junto os vinculos de mapa dela.
  //    A foto sai antes da linha: o arquivo mora no Storage privado, que
  //    nenhuma cascata do banco alcanca — apagar so a linha deixaria o
  //    arquivo la para sempre.
  if (anteriores.length > 0) {
    for (const row of anteriores) await deleteImage(row.photo_path).catch(() => undefined);
    await deleteRows(TABLES.members, { id: inFilter(anteriores.map((row) => row.id)) });
  }

  // 2. Fora os pontos semeados que sobraram sem dono. Sao as coordenadas
  //    inventadas da versao antiga — as que punham marcador em Recife e no
  //    mar. Um ponto ainda usado por outro Time DEMO nao e apagado.
  await dropOrphanSeededPoints();

  // 3. A geracao nova, pelo mesmo caminho da criacao. As escolas saem da
  //    tabela oficial do TSE com a semente original — a mesma quantidade
  //    devolve as mesmas escolas. Sem a tabela, o catalogo conferido INTEIRO,
  //    como sempre foi.
  const pontos: string[] = [];
  const seedKey = reserva?.seed_key ?? clientId;
  const schools = await demoSchoolsFor(places, seedKey);
  const resumo = await seedDemoContent(
    client,
    {
      people,
      places: schools.source === 'TSE' ? places : schools.places.length,
      seedKey,
      schools,
    },
    pontos,
    admins,
  );

  await markSeeded(clientId);

  return {
    clientId,
    version: DEMO_SEED_VERSION,
    source: schools.source,
    cities: resumo.cities,
    removed: anteriores.length,
    people: resumo.people,
    places: resumo.places,
    points: resumo.points,
  };
}

/**
 * Apaga pontos `DEMO_SEED` que nao pertencem mais a ninguem.
 *
 * `DEMO_SEED` era a marca das coordenadas que o gerador antigo escrevia de
 * memoria. Elas nao sao mais criadas: hoje toda coordenada do Time DEMO vem
 * da consulta de endereco. As que sobraram de um time ja regenerado seriam
 * lixo no cache, entao saem — e somente as que nenhum vinculo aponta.
 */
async function dropOrphanSeededPoints(): Promise<void> {
  const semeados = await selectRows<Pick<MapLocationRow, 'id'>>(TABLES.mapLocations, {
    select: 'id',
    filters: { provider: `eq.${DEMO_PROVIDER}` },
    limit: 2000,
  });
  if (semeados.length === 0) return;

  const ids = semeados.map((row) => row.id);
  const emUso = await selectRows<Pick<MemberLocationRow, 'location_id'>>(TABLES.memberLocations, {
    select: 'location_id',
    filters: { location_id: inFilter(ids) },
    limit: 4000,
  });

  const ocupados = new Set(emUso.map((row) => row.location_id));
  const orfaos = ids.filter((id) => !ocupados.has(id));
  if (orfaos.length > 0) {
    await deleteRows(TABLES.mapLocations, { id: inFilter(orfaos) }).catch(() => []);
  }
}

/* -------------------------------------------------------------------------
   Chave de acesso
   ------------------------------------------------------------------------- */

/**
 * Liga e desliga o acesso de um Time DEMO ao sistema.
 *
 * Desligado, nenhuma sessao daquele time resolve — a conferencia vive em
 * `resolveSessionState`, por onde passam TODAS as paginas e TODAS as rotas —
 * e nenhum login novo passa pelo link do time.
 *
 * O que NAO acontece: nenhum usuario e desativado, nenhuma sessao e revogada
 * e nenhuma senha muda. E por isso que religar devolve as pessoas exatamente
 * onde elas estavam, sem ninguem precisar entrar de novo, e que desligar nao
 * destroi nada que precise ser remontado depois.
 *
 * Time real nao passa daqui — e o banco recusa de novo, pelo `check` da
 * migration 036. Uma operacao de verdade nao fica sem acesso por um clique
 * em uma tela de demonstracao.
 */
export async function setDemoAccess(clientId: string, enabled: boolean): Promise<Client> {
  const client = await getClient(clientId);
  if (!client) throw notFound('Time não encontrado.');
  if (!client.isDemo) throw badRequest('Só um Time DEMO pode ter o acesso desligado.');

  await updateRows(
    TABLES.clients,
    { id: `eq.${clientId}` },
    { demo_access_enabled: enabled },
    'id',
  );

  const atualizado = await getClient(clientId);
  if (!atualizado) throw notFound('Time não encontrado.');
  return atualizado;
}

/* -------------------------------------------------------------------------
   Completar o mapa
   ------------------------------------------------------------------------- */

/**
 * Falhas que valem uma nova tentativa: o prazo da criacao acabou antes de a
 * rua ser perguntada, ou o provedor piscou. Chave invalida, credito
 * esgotado ou limite de consultas NAO entram: insistir nelas so gastaria
 * tempo, e quem resolve e o ADMIN, nas configuracoes.
 */
const RETRYABLE_ERRORS = ['TIMEOUT', 'PROVIDER_UNAVAILABLE'] as const;

export interface DemoMapReport {
  /** Vinculos de moradia que ganharam ponto nesta passagem. */
  resolved: number;
  /** Vinculos que ainda podem ganhar ponto em uma proxima passagem. */
  remaining: number;
  /**
   * Vinculos tocados nesta passagem, com ou sem ponto. Zero quer dizer que a
   * passagem nao andou — e a tela para de chamar.
   */
  processed: number;
}

/**
 * Completa a camada "Pessoas" de um Time DEMO, um pedaco por chamada.
 *
 * A criacao tem prazo para consultar ruas (`LOCATION_BUDGET_MS`): com
 * dezenas de municipios, o que nao coube fica sem ponto, marcado `TIMEOUT`.
 * Esta rotina retoma DAI, sem refazer pessoa nenhuma: le os vinculos de
 * moradia que ficaram para tras, agrupa por endereco — uma consulta serve a
 * todos os moradores da rua — e resolve o que couber no prazo. A tela chama
 * de novo enquanto houver o que resolver.
 *
 * Cada rua inedita e uma consulta paga, UMA vez no sistema todo: o cache e
 * por endereco, entao o proximo Time DEMO nao paga de novo.
 *
 * So toca o que o gerador criou (`demo_seed`) e so em Time DEMO. Escola nao
 * passa por aqui: a da tabela oficial ja nasce com ponto.
 */
export async function completeDemoMap(clientId: string): Promise<DemoMapReport> {
  const client = await getClient(clientId);
  if (!client) throw notFound('Time não encontrado.');
  if (!client.isDemo) throw badRequest('Só um Time DEMO tem o mapa completado por aqui.');

  const pendentes = await selectRows<Pick<MemberLocationRow, 'id' | 'member_id'>>(
    TABLES.memberLocations,
    {
      select: 'id,member_id',
      filters: {
        client_id: `eq.${clientId}`,
        location_kind: 'eq.RESIDENCE',
        status: 'eq.FAILED',
        error_code: `in.(${RETRYABLE_ERRORS.join(',')})`,
      },
    },
  );
  if (pendentes.length === 0) return { resolved: 0, remaining: 0, processed: 0 };

  const pessoas = await selectRows<Pick<MemberRow, 'id' | 'street' | 'district' | 'city' | 'state'>>(
    TABLES.members,
    {
      select: 'id,street,district,city,state',
      filters: {
        id: inFilter([...new Set(pendentes.map((link) => link.member_id))]),
        demo_seed: 'not.is.null',
      },
    },
  );
  const pessoaPorId = new Map(pessoas.map((pessoa) => [pessoa.id, pessoa]));

  // Um grupo por endereco: e a mesma consulta, e o mesmo ponto, para todos.
  const grupos = new Map<
    string,
    { lookup: NonNullable<ReturnType<typeof residenceLookupFor>>; city: string; state: string; links: string[] }
  >();
  for (const link of pendentes) {
    const pessoa = pessoaPorId.get(link.member_id);
    if (!pessoa?.city || pessoa.state !== DEMO_STATE) continue;
    const lookup = residenceLookupFor({
      street: pessoa.street,
      district: pessoa.district,
      city: pessoa.city,
      state: DEMO_STATE,
    });
    if (!lookup) continue;

    const grupo = grupos.get(lookup.query) ?? {
      lookup,
      city: pessoa.city,
      state: DEMO_STATE,
      links: [],
    };
    grupo.links.push(link.id);
    grupos.set(lookup.query, grupo);
  }

  const prazo = Date.now() + LOCATION_BUDGET_MS;
  const agora = () => new Date().toISOString();
  let resolved = 0;
  let remaining = 0;
  let processed = 0;

  for (const grupo of grupos.values()) {
    if (Date.now() > prazo) {
      remaining += grupo.links.length;
      continue;
    }

    const outcome = await resolveDemoPoint(grupo.lookup.query, {
      city: grupo.city,
      state: grupo.state,
    });

    let mudanca: Record<string, string | null>;
    if (outcome.point) {
      mudanca = {
        status: 'SUCCESS',
        query_hash: outcome.hash,
        location_id: outcome.point.locationId,
        location_precision: grupo.lookup.precision,
        error_code: null,
        resolved_at: agora(),
      };
      resolved += grupo.links.length;
    } else if (outcome.error) {
      mudanca = {
        status: 'FAILED',
        query_hash: outcome.hash,
        location_id: null,
        error_code: outcome.error,
        resolved_at: agora(),
      };
      // Falha passageira continua na fila; as outras param aqui.
      if ((RETRYABLE_ERRORS as readonly string[]).includes(outcome.error)) {
        remaining += grupo.links.length;
      }
    } else {
      mudanca = {
        status: 'NOT_FOUND',
        query_hash: outcome.hash,
        location_id: null,
        error_code: null,
        resolved_at: agora(),
      };
    }

    await updateRows(TABLES.memberLocations, { id: inFilter(grupo.links) }, mudanca, 'id');
    processed += grupo.links.length;
  }

  return { resolved, remaining, processed };
}

/* -------------------------------------------------------------------------
   Conteudo de demonstracao
   ------------------------------------------------------------------------- */

/**
 * Tempo maximo gasto resolvendo coordenadas em UMA criacao.
 *
 * Nao e chute: o sistema roda em funcoes com tempo de vida curto, e a
 * criacao de um Time DEMO ja gastou o dela escrevendo as pessoas. O que
 * sobra e isto.
 */
const LOCATION_BUDGET_MS = 8000;

interface SeedOptions {
  people: number;
  places: number;
  seedKey: string;
  /** Escolas e moradias disponiveis (`demo-schools.ts`). */
  schools: DemoSchools;
}

interface SeedSummary {
  people: number;
  places: number;
  cities: number;
  points: { resolved: number; missing: number };
}

/** Administradores do time: sao eles que aparecem em "Cadastrado por". */
async function demoAdmins(clientId: string): Promise<Admin[]> {
  const admins = await selectRows<Admin>(TABLES.users, {
    select: 'id,name,phone',
    filters: { client_id: `eq.${clientId}`, role: 'eq.CANDIDATE', is_active: 'is.true' },
    order: 'created_at.asc',
  });
  if (admins.length === 0) throw notFound('O Time DEMO ficou sem administrador.');
  return admins;
}

/**
 * Gera e grava o conteudo: coordenadas, pessoas e vinculos de mapa.
 *
 * Tudo em lote, nas tabelas reais. As pessoas nascem com responsavel (um dos
 * administradores do time), endereco de Alagoas, zona e secao quando o
 * TRE/AL as publicou, e data de cadastro espalhada entre hoje, os ultimos
 * sete dias e o mes — os mesmos registros que os cartoes, o grafico, as
 * listas e o mapa vao ler.
 *
 * O que elas NAO ganham e acesso: nenhuma linha em `cmd_users`.
 */
async function seedDemoContent(
  client: Client,
  options: SeedOptions,
  /** Recebe os pontos criados AQUI, para o desfazer poder limpa-los. */
  pontos: string[],
  known?: Admin[],
): Promise<SeedSummary> {
  const admins = known ?? (await demoAdmins(client.id));

  const data = buildDemoData({
    seed: options.seedKey,
    people: options.people,
    places: options.places,
    admins: admins.length,
    usedPhones: admins.map((row) => row.phone ?? ''),
    catalog: options.schools.places,
    addresses: options.schools.addresses,
  });

  // AS PESSOAS PRIMEIRO. A ordem nao e detalhe: resolver coordenada conversa
  // com um provedor externo, e uma consulta lenta — ou sessenta delas — gasta
  // todo o tempo que a funcao tem. Quando isso acontecia ANTES da escrita, a
  // criacao morria com o time ja criado e NENHUMA pessoa dentro: cartoes
  // zerados, grafico vazio, lista vazia. Agora o que as telas mostram ja esta
  // gravado antes de o primeiro endereco ser perguntado.
  const members = await seedMembers(client, data, admins);

  // Coordenada e ENFEITE perto disso: ela melhora o mapa e nao pode derrubar
  // a criacao. Qualquer falha aqui deixa os vinculos sem ponto, e a rotina de
  // correcao ("Refazer dados") tenta de novo depois.
  let locations: SeededLocations = { places: [], residences: [] };
  try {
    locations = await seedLocations(data, pontos, options.schools);
  } catch {
    locations = { places: [], residences: [] };
  }

  await seedMemberLocations(client.id, data, members, locations).catch(() => undefined);

  const encontrados = [...locations.places, ...locations.residences].filter(
    (outcome) => outcome.point !== null,
  ).length;
  const total = locations.places.length + locations.residences.length;

  return {
    people: data.people.length,
    places: data.places.length,
    cities: data.cities.length,
    points: { resolved: encontrados, missing: total - encontrados },
  };
}

interface PointSlot {
  point: { locationId: string } | null;
  hash: string;
  error: string | null;
  /** Ate onde o endereco chega: rua, bairro ou municipio. */
  precision: string | null;
}

interface SeededLocations {
  /** Resultado de cada local de votacao, na ordem de `data.places`. */
  places: PointSlot[];
  /** Resultado de cada endereco de moradia, na ordem de `data.residences`. */
  residences: PointSlot[];
}

/**
 * Coordenadas de cada escola e de cada RUA — e nao uma por pessoa.
 *
 * E o mesmo comportamento do cache real (uma consulta serve a todos os
 * moradores daquela rua), e e o que faz os pinos se agruparem no mapa em vez
 * de virar um borrao de pontos soltos. Como o catalogo e curto e o cache e
 * compartilhado por consulta, o segundo Time DEMO nao consulta nada.
 *
 * Sequencial de proposito: duas consultas simultaneas do mesmo endereco
 * perguntariam duas vezes antes de existir cache — e cada consulta e cobrada.
 */
async function seedLocations(
  data: DemoData,
  pontos: string[],
  schools: DemoSchools,
): Promise<SeededLocations> {
  const places: PointSlot[] = [];
  const residences: PointSlot[] = [];

  // Escolas da tabela oficial: a coordenada e COPIADA, todas de uma vez, sem
  // provedor e sem prazo — e banco, nao consulta. Nao entram em `pontos`: sao
  // linhas compartilhadas com os times reais, e o desfazer nao as alcanca.
  const oficiais = data.places
    .map((entry) => (entry.place.officialId ? schools.official.get(entry.place.officialId) : undefined))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const pontosOficiais =
    oficiais.length > 0 ? await rememberOfficialPlaces(oficiais) : new Map<string, never>();

  // Prazo. O que ja esta no cache sai instantaneo; o que precisa do provedor
  // custa uma consulta de rede, e dezenas delas em fila gastam todo o tempo
  // que a funcao tem. Estourado o prazo, o resto fica sem ponto — e o time
  // continua completo, com as pessoas, os numeros e as listas no lugar. A
  // rotina de correcao resolve o restante depois, e ai cada endereco ja
  // resolvido e de graca.
  const prazo = Date.now() + LOCATION_BUDGET_MS;
  const vencido = () => Date.now() > prazo;

  for (const entry of data.places) {
    if (entry.place.officialId) {
      const ponto = pontosOficiais.get(entry.place.officialId) ?? null;
      places.push({
        point: ponto,
        hash: ponto?.hash ?? '',
        error: null,
        precision: null,
      });
      continue;
    }
    if (vencido()) {
      places.push({ point: null, hash: '', error: 'TIMEOUT', precision: null });
      continue;
    }
    const query = pollingPlaceLookup(entry.place);
    if (!query) {
      places.push({ point: null, hash: '', error: 'MISSING_DATA', precision: null });
      continue;
    }
    const outcome = await resolveDemoPoint(query, {
      city: entry.place.city,
      state: entry.place.state,
    });
    if (outcome.point?.created) pontos.push(outcome.point.locationId);
    places.push({
      point: outcome.point,
      hash: outcome.hash,
      error: outcome.error,
      // Precisao e coisa de endereco declarado, nao de local de votacao: o
      // pino da escola esta no predio, e a tela nao fala em aproximacao.
      precision: null,
    });
  }

  for (const entry of data.residences) {
    if (vencido()) {
      residences.push({ point: null, hash: '', error: 'TIMEOUT', precision: null });
      continue;
    }
    const lookup = residenceLookupFor(entry);
    if (!lookup) {
      residences.push({ point: null, hash: '', error: 'MISSING_DATA', precision: null });
      continue;
    }
    const outcome = await resolveDemoPoint(lookup.query, {
      city: entry.city,
      state: entry.state,
    });
    if (outcome.point?.created) pontos.push(outcome.point.locationId);
    residences.push({
      point: outcome.point,
      hash: outcome.hash,
      error: outcome.error,
      precision: lookup.precision,
    });
  }

  return { places, residences };
}

/** Pessoas ficticias, na tabela real de integrantes. */
async function seedMembers(
  client: Client,
  data: DemoData,
  admins: Admin[],
): Promise<Pick<MemberRow, 'id' | 'name' | 'phone'>[]> {
  // Opcoes de vinculo do formulario recem-criado: o Time DEMO usa o MESMO
  // construtor de formulario, entao os identificadores sao os dele.
  const vinculo = client.form.fields.find((field) => field.systemKey === 'relationship');
  const opcoes = vinculo?.options ?? [];

  const linhas = data.people.map((person) => {
    const responsavel = admins[person.adminIndex % admins.length];
    const opcao = opcoes.length > 0 ? opcoes[person.relationshipIndex % opcoes.length] : null;

    return {
      client_id: client.id,
      name: person.name,
      phone: normalizePhone(person.phone),
      gender: person.gender,
      street: person.street,
      district: person.district,
      city: person.city,
      state: person.state,
      zone: person.zone,
      section: person.section,
      relationship_option_id: opcao?.id ?? null,
      relationship_label: opcao?.label ?? null,
      // Cadastro pelo link, como a maior parte de um time real.
      source: 'invite',
      // A marca da geracao: e por ela, e so por ela, que a correcao sabe o
      // que pode refazer. Quem foi cadastrado a mao nao a tem, e fica.
      demo_seed: DEMO_SEED_VERSION,
      // O responsavel e um administrador do proprio time: a guarda do banco
      // confere time e perfil linha a linha.
      recruited_by_user_id: responsavel.id,
      recruited_by_name: responsavel.name,
      recruited_by_role: 'CANDIDATE',
      // Datas espalhadas entre hoje, os sete dias e o mes: sao estes mesmos
      // registros que alimentam os tres indicadores e o grafico.
      created_at: person.createdAt,
      updated_at: person.createdAt,
      // CPF, titulo, e-mail e consentimento ficam vazios de proposito.
    };
  });

  // Em lotes: cinco mil pessoas em um envio so estouraria o corpo da
  // requisicao, e a criacao inteira falharia no fim.
  try {
    return await insertRowsInChunks<MemberRow>(TABLES.members, linhas, 'id,name,phone');
  } catch (error) {
    // Banco sem a migration 034: a coluna `demo_seed` ainda nao existe. Ela
    // serve a UMA coisa — saber o que a rotina de correcao pode refazer — e
    // nao vale derrubar a criacao inteira por causa dela. As pessoas entram
    // sem a marca, e a marca aparece quando a migration for executada.
    const faltaColuna = error instanceof SupabaseRequestError && error.isMissingSchema;
    if (!faltaColuna) throw error;

    const semMarca = linhas.map((linha) => {
      const copia: Record<string, unknown> = { ...linha };
      delete copia.demo_seed;
      return copia as typeof linha;
    });
    return insertRowsInChunks<MemberRow>(TABLES.members, semMarca, 'id,name,phone');
  }
}

/**
 * Vinculos do mapa.
 *
 * Duas linhas por pessoa, como em um cadastro real que ja passou pela
 * localizacao: a moradia aproximada (pino da camada "Pessoas") e o local de
 * votacao (pino agrupado da escola).
 *
 * SUCCESS somente quando existe coordenada conferida. Sem ela o vinculo fica
 * NOT_FOUND (o provedor nao devolveu resultado confiavel) ou FAILED (a
 * consulta nao pode ser feita) — a tela conta o integrante como pendente, e
 * o mapa nao ganha um pino que nao corresponde a lugar nenhum.
 */
async function seedMemberLocations(
  clientId: string,
  data: DemoData,
  members: Pick<MemberRow, 'id' | 'phone'>[],
  locations: SeededLocations,
): Promise<void> {
  const agora = new Date().toISOString();
  const linhas: Record<string, string | null>[] = [];

  // O vinculo e feito pelo TELEFONE, que e unico no time, e nao pela ordem
  // em que o banco devolveu as linhas: depender da ordem faria a pessoa
  // receber o endereco e a escola de outra no dia em que ela mudasse.
  const porTelefone = new Map(members.map((member) => [normalizePhone(member.phone), member.id]));

  /**
   * Uma linha, com as MESMAS chaves em todos os casos: em um envio em lote o
   * PostgREST exige que todas as linhas tenham exatamente as mesmas chaves e
   * recusa o lote inteiro quando uma delas falta (PGRST102).
   */
  function link(
    memberId: string,
    kind: 'RESIDENCE' | 'POLLING_PLACE',
    slot: PointSlot | undefined,
  ): Record<string, string | null> {
    const found = slot?.point ?? null;
    return {
      client_id: clientId,
      member_id: memberId,
      location_kind: kind,
      status: found ? 'SUCCESS' : slot?.error ? 'FAILED' : 'NOT_FOUND',
      query_hash: slot?.hash || null,
      location_id: found?.locationId ?? null,
      location_precision: found ? (slot?.precision ?? null) : null,
      error_code: found ? null : (slot?.error ?? null),
      resolved_at: agora,
    };
  }

  data.people.forEach((person) => {
    const memberId = porTelefone.get(normalizePhone(person.phone));
    if (!memberId) return;

    // O ponto e o da RUA (ou do bairro, ou do municipio), nunca o da casa: e
    // o mesmo limite que o sistema real respeita ao mostrar moradia no mapa.
    linhas.push(link(memberId, 'RESIDENCE', locations.residences[person.residenceIndex]));
    linhas.push(link(memberId, 'POLLING_PLACE', locations.places[person.placeIndex]));
  });

  // Sao DUAS linhas por pessoa: o lote aqui e o dobro do de integrantes.
  if (linhas.length > 0) await insertRowsInChunks(TABLES.memberLocations, linhas, 'id');
}

/** UF unica do Time DEMO, exposta para quem precisar conferir. */
export const DEMO_TEAM_STATE = DEMO_STATE;

/* -------------------------------------------------------------------------
   Segunda camada: quem da equipe tambem recruta
   ------------------------------------------------------------------------- */

/**
 * As pessoas TRAZIDAS pela equipe, e quem as trouxe.
 *
 * Um time real tem duas camadas. O administrador cadastra gente pelo link
 * dele; parte dessa gente ganha o proprio link e cadastra MAIS GENTE. O Time
 * DEMO so tinha a primeira: as mil pessoas apareciam todas como cadastradas
 * pelo administrador, e o "Ranking de cadastros equipe" abria com a lista
 * inteira em zero.
 *
 * A segunda camada ACRESCENTA. Ela nao reparte as pessoas que ja existem —
 * essas continuam do administrador, que foi quem as trouxe. Ela gera gente
 * NOVA, cadastrada pelos recrutadores, exatamente como aconteceria em campo:
 * o time cresce quando a equipe traz alguem. Por isso "Equipe cadastrada"
 * sobe, e por isso as pessoas novas entram no MAPA com moradia e local de
 * votacao, como qualquer outra.
 *
 * Chamar de novo REFAZ a camada: a anterior sai inteira — pessoas, vinculos
 * de mapa e recrutadores — e a nova entra. Zero em qualquer um dos dois
 * numeros devolve o time a uma camada so, e as pessoas do administrador
 * ficam intactas.
 *
 * O ACESSO CONTINUA FECHADO. O usuario de cada recrutador nasce
 * `is_active: false`, e o login por link do time + telefone so aceita
 * usuario ativo (`team-access.service`). Eles existem para a HIERARQUIA —
 * "Cadastrado por", ranking, arvore da equipe —, nunca para entrar: as
 * pessoas de um Time DEMO sao dados e os telefones delas sao ficticios.
 *
 * Por isso a linha em `cmd_users` e escrita AQUI, e nao por
 * `createMemberAccess`: aquela concede acesso de verdade e recusa Time DEMO
 * de proposito. Esta e a unica porta por onde um integrante de Time DEMO
 * ganha linha de usuario, e ela entrega hierarquia sem entrada.
 */
export interface DemoRecruitersInput {
  /** Quantas pessoas do time tambem recrutam. */
  recruiters: number;
  /** Quantas pessoas elas trazem, ao todo. */
  people: number;
}

export interface DemoRecruitersReport {
  recruiters: number;
  people: number;
  points: { resolved: number; missing: number };
}

/**
 * As pessoas da segunda camada, reconhecidas pela MARCA PROPRIA.
 *
 * Nao por "tem responsavel do perfil EQUIPE": esse criterio pegaria tambem
 * as pessoas da PRIMEIRA camada que uma versao anterior desta funcao passou
 * para a equipe — e apagaria gente que o administrador trouxe.
 */
const SECOND_LAYER_FILTERS = { demo_seed: `eq.${DEMO_SECOND_LAYER_SEED}` } as const;

/**
 * Tira a segunda camada inteira: pessoas, vinculos de mapa e recrutadores.
 *
 * A ordem importa. As PESSOAS saem antes dos usuarios porque, com o usuario
 * apagado primeiro, o `on delete set null` da chave estrangeira tocaria a
 * origem das linhas que ainda apontavam para ele — e mexer em origem e
 * justamente o que a guarda do banco vigia. Apagando a ponta primeiro, nao
 * sobra ninguem apontando.
 *
 * As pessoas da PRIMEIRA camada nao sao tocadas: elas sao do administrador,
 * que foi quem as trouxe.
 */
async function clearSecondLayer(clientId: string): Promise<void> {
  // 1. As pessoas TRAZIDAS pela equipe. So as que tem a marca propria: e
  //    isso que separa a gente gerada por esta funcao das pessoas que o
  //    administrador trouxe.
  const pessoas = await selectRows<Pick<MemberRow, 'id'>>(TABLES.members, {
    select: 'id',
    filters: { client_id: `eq.${clientId}`, ...SECOND_LAYER_FILTERS },
  });

  if (pessoas.length > 0) {
    const ids = pessoas.map((pessoa) => pessoa.id);
    // Os pinos saem junto: uma pessoa apagada nao pode continuar no mapa.
    await deleteRows(TABLES.memberLocations, { member_id: inFilter(ids) });
    await deleteRows(TABLES.members, { id: inFilter(ids) });
  }

  // 2. HERANCA de uma versao anterior desta funcao, que em vez de acrescentar
  //    gente repartia as pessoas que ja existiam: parte da PRIMEIRA camada
  //    ficou com responsavel do perfil EQUIPE. Elas sao do administrador, que
  //    foi quem as trouxe, e voltam para ele — apagar seria destruir cadastro
  //    que nunca foi desta camada.
  //
  //    Este e um UPDATE de origem, e passa pela guarda do banco justamente
  //    pela excecao da migration 039: sao linhas GERADAS, de marca conhecida.
  const herdadas = await selectRows<Pick<MemberRow, 'id'>>(TABLES.members, {
    select: 'id',
    filters: {
      client_id: `eq.${clientId}`,
      demo_seed: `eq.${DEMO_SEED_VERSION}`,
      recruited_by_role: 'eq.EQUIPE',
    },
  });

  if (herdadas.length > 0) {
    const [responsavel] = await demoAdmins(clientId);
    await updateRows(
      TABLES.members,
      { id: inFilter(herdadas.map((pessoa) => pessoa.id)) },
      {
        recruited_by_user_id: responsavel.id,
        recruited_by_name: responsavel.name,
        recruited_by_role: 'CANDIDATE',
      },
      'id',
    );
  }

  // 3. Os recrutadores. Por ultimo: com o usuario apagado antes, o
  //    `on delete set null` tocaria a origem de quem ainda apontava para ele.
  const recrutadores = await selectRows<Pick<UserRow, 'id'>>(TABLES.users, {
    select: 'id',
    filters: { client_id: `eq.${clientId}`, role: 'eq.EQUIPE' },
  });
  if (recrutadores.length > 0) {
    await deleteRows(TABLES.users, { id: inFilter(recrutadores.map((row) => row.id)) });
  }
}

export async function setDemoRecruiters(
  clientId: string,
  input: DemoRecruitersInput,
): Promise<DemoRecruitersReport> {
  const client = await getClient(clientId);
  if (!client) throw notFound('Time não encontrado.');
  if (!client.isDemo) throw badRequest('A segunda camada é só do Time DEMO.');

  const vazio: DemoRecruitersReport = {
    recruiters: 0,
    people: 0,
    points: { resolved: 0, missing: 0 },
  };

  // Refazer e sempre do zero: a camada anterior sai inteira antes de a nova
  // entrar. Ajustar em cima da que existe exigiria reescrever a origem de
  // cadastros ja gravados, que e o que a guarda do banco recusa — e com
  // razao.
  await clearSecondLayer(clientId);

  // As pessoas da PRIMEIRA camada: e entre elas que se escolhe quem recruta.
  // Um recrutador e alguem que o administrador ja trouxe.
  const daPrimeira = await selectRows<Pick<MemberRow, 'id' | 'name' | 'phone'>>(TABLES.members, {
    select: 'id,name,phone',
    filters: {
      client_id: `eq.${clientId}`,
      demo_seed: `eq.${DEMO_SEED_VERSION}`,
      recruited_by_role: 'eq.CANDIDATE',
    },
    order: 'created_at.asc',
  });

  const quantos = clampRecruiters(input.recruiters, daPrimeira.length + 1);
  const quantas = Math.max(0, Math.trunc(input.people) || 0);
  if (quantos === 0 || quantas === 0) return vazio;

  // 1. Os recrutadores ganham a linha de usuario, com o acesso DESLIGADO.
  const escolhidos = daPrimeira.slice(0, quantos);
  const recrutadores: { userId: string; name: string }[] = [];

  for (const pessoa of escolhidos) {
    const criado = await insertOne<Pick<UserRow, 'id'>>(
      TABLES.users,
      {
        name: pessoa.name.slice(0, 120),
        email: null,
        phone: normalizePhone(pessoa.phone ?? ''),
        role: 'EQUIPE',
        client_id: clientId,
        member_id: pessoa.id,
        password_hash: null,
        must_change_password: false,
        // DESLIGADO. Ver a nota acima: hierarquia sim, entrada nao.
        is_active: false,
      },
      'id',
    );
    recrutadores.push({ userId: criado.id, name: pessoa.name });
  }

  // 2. A gente NOVA. Mesmo gerador do time, mesma Alagoas, mesmos locais de
  //    votacao do catalogo — o cache de coordenadas ja tem esses enderecos,
  //    entao nenhuma escola nova e criada e quase nada e consultado de novo.
  const telefonesEmUso = await selectRows<Pick<MemberRow, 'phone'>>(TABLES.members, {
    select: 'phone',
    filters: { client_id: `eq.${clientId}` },
  });

  // As escolas do PROPRIO time: quem a equipe traz vota onde o time ja vota.
  const schools = await demoSchoolsOfTeam(clientId);
  const data = buildDemoData({
    // Semente propria: a gente da segunda camada nao pode sair com os mesmos
    // nomes e telefones da primeira.
    seed: `${clientId}:camada2:${quantos}:${quantas}`,
    people: quantas,
    places: schools.places.length,
    admins: recrutadores.length,
    usedPhones: telefonesEmUso.map((row) => row.phone ?? ''),
    catalog: schools.places,
    addresses: schools.addresses,
  });

  // 3. Quem trouxe quem, de forma DESIGUAL: um ranking empatado nao mostra
  //    quem esta trazendo gente e quem nao esta, que e a pergunta do quadro.
  const fatias = shareAmongRecruiters(recrutadores.length, data.people.length, 1);
  const donoDaPessoa: { userId: string; name: string }[] = [];
  for (const fatia of fatias) {
    const dono = recrutadores[fatia.index];
    for (let i = 0; i < fatia.count; i += 1) donoDaPessoa.push(dono);
  }
  // A sobra do arredondamento fica com o primeiro: ninguem pode entrar sem
  // responsavel.
  while (donoDaPessoa.length < data.people.length) donoDaPessoa.push(recrutadores[0]);

  const membros = await seedSecondLayerMembers(client, data, donoDaPessoa);

  // 4. O mapa. Sem isto as pessoas novas existiriam nas listas e nos numeros
  //    e nao apareceriam no mapa — meia demonstracao.
  let locations: SeededLocations = { places: [], residences: [] };
  const pontos: string[] = [];
  try {
    locations = await seedLocations(data, pontos, schools);
  } catch {
    locations = { places: [], residences: [] };
  }
  await seedMemberLocations(clientId, data, membros, locations).catch(() => undefined);

  const encontrados = [...locations.places, ...locations.residences].filter(
    (slot) => slot.point !== null,
  ).length;
  const total = locations.places.length + locations.residences.length;

  return {
    recruiters: recrutadores.length,
    people: membros.length,
    points: { resolved: encontrados, missing: total - encontrados },
  };
}

/**
 * Grava a gente da segunda camada.
 *
 * Igual a `seedMembers`, com UMA diferenca: o responsavel e um RECRUTADOR
 * (perfil EQUIPE), e nao um administrador. A origem ja nasce certa no
 * INSERT, entao nenhuma linha existente tem a origem reescrita — e a guarda
 * do banco, que vigia exatamente isso, nao e provocada.
 */
async function seedSecondLayerMembers(
  client: Client,
  data: DemoData,
  donos: { userId: string; name: string }[],
): Promise<Pick<MemberRow, 'id' | 'name' | 'phone'>[]> {
  const vinculo = client.form.fields.find((field) => field.systemKey === 'relationship');
  const opcoes = vinculo?.options ?? [];

  const linhas = data.people.map((person, index) => {
    const dono = donos[index] ?? donos[0];
    const opcao = opcoes.length > 0 ? opcoes[person.relationshipIndex % opcoes.length] : null;

    return {
      client_id: client.id,
      name: person.name,
      phone: normalizePhone(person.phone),
      gender: person.gender,
      street: person.street,
      district: person.district,
      city: person.city,
      state: person.state,
      zone: person.zone,
      section: person.section,
      relationship_option_id: opcao?.id ?? null,
      relationship_label: opcao?.label ?? null,
      source: 'invite',
      // Marca PROPRIA: e por ela que esta camada e refeita sem tocar em
      // quem o administrador trouxe.
      demo_seed: DEMO_SECOND_LAYER_SEED,
      recruited_by_user_id: dono.userId,
      recruited_by_name: dono.name,
      // E o que poe a pessoa no ranking da EQUIPE, e nao no do administrador.
      recruited_by_role: 'EQUIPE',
      created_at: person.createdAt,
      updated_at: person.createdAt,
    };
  });

  return insertRowsInChunks<MemberRow>(TABLES.members, linhas, 'id,name,phone');
}

/** Como a segunda camada esta hoje: e o que a tela abre preenchido. */
export async function countDemoRecruiters(
  clientId: string,
): Promise<{ recruiters: number; people: number }> {
  const [recrutadores, pessoas] = await Promise.all([
    selectRows<Pick<UserRow, 'id'>>(TABLES.users, {
      select: 'id',
      filters: { client_id: `eq.${clientId}`, role: 'eq.EQUIPE' },
    }),
    selectRows<Pick<MemberRow, 'id'>>(TABLES.members, {
      select: 'id',
      filters: { client_id: `eq.${clientId}`, ...SECOND_LAYER_FILTERS },
    }),
  ]);

  return { recruiters: recrutadores.length, people: pessoas.length };
}
