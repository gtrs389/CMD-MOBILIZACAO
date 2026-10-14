import { tierOf } from '@/lib/domain/team-tier';
import { recruiterText } from '@/lib/domain/recruitment';
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import {
  normalizeQuery,
  residenceLookup,
  type AddressParts,
  type LocationKind,
  type LocationPrecision,
  type MapErrorCode,
  type MapPlace,
} from '@/lib/domain/map-location';
import {
  addToLeader,
  genderBucket,
  leaderKey,
  pollingPlaceKey,
  sectionKey,
  type MapOverviewPayload,
  type MapPin,
  type PlaceMember,
  type PlaceMembersPayload,
  type PollingPlacePin,
} from '@/lib/domain/map-pin';
import type { TseResult } from '@/lib/domain/verification';
import type { Member } from '@/lib/types';
import {
  TABLES,
  type ClientRow,
  type MapLocationRow,
  type MemberLocationRow,
  type MemberRow,
  type MemberVerificationRow,
  type PollingPlaceRow,
  type UserRow,
} from '@/lib/supabase/tables';
import {
  deleteRows,
  inFilter,
  insertOne,
  notInFilter,
  selectOne,
  selectRows,
  updateRows,
} from '@/lib/supabase/rest';
import { signedUrls } from '@/lib/supabase/storage';
import { decryptJson } from './crypto';
import { offBooksClientIds, withoutDemoClients } from './demo-scope';
import { sheetEnabled, sheetVisibilityFilter } from './sheet-visibility';
import { lookupPlace, MapLookupError } from './serpapi.service';
import {
  findPollingPlace,
  pollingPlaceAddress,
  pollingPlaceIn,
  pollingPlacesOfZones,
} from './polling-place.service';
import { equipeDaPlanilha } from './sheet-live.service';

/**
 * Coordenadas do integrante: moradia aproximada e local de votacao.
 *
 * As duas vem de lugares diferentes, e essa e a distincao central do arquivo:
 *
 *   MORADIA         e digitada no cadastro e nao existe em tabela nenhuma:
 *                   so um provedor sabe onde fica aquela rua. Ela E a
 *                   consulta paga (SerpAPI), com cache por endereco.
 *   LOCAL DE VOTACAO  e publico e ja esta no nosso banco, com a coordenada
 *                   oficial (migration 042). Nao ha provedor, nao ha
 *                   cobranca e nao ha palpite: acha-se por UF + zona + secao,
 *                   ou nao se acha.
 *
 * Regras que valem em todo o arquivo:
 *   - o cadastro e a verificacao nunca dependem daqui;
 *   - cada consulta AO PROVEDOR e cobrada: nada repete sozinho e o cache por
 *     consulta normalizada faz uma mesma rua ser perguntada uma unica vez;
 *   - um bloqueio atomico impede duas consultas simultaneas do mesmo vinculo;
 *   - nada disso vai para log: nem a consulta, nem a chave, nem a resposta.
 */

const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export function queryHash(query: string): string {
  return createHash('sha256').update(normalizeQuery(query), 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------
   Vinculos
   ------------------------------------------------------------------------- */

async function findLink(
  memberId: string,
  kind: LocationKind,
): Promise<MemberLocationRow | null> {
  return selectOne<MemberLocationRow>(TABLES.memberLocations, {
    select: '*',
    filters: { member_id: `eq.${memberId}`, location_kind: `eq.${kind}` },
  });
}

/**
 * A moradia aproximada esta ligada neste time?
 *
 * Ela e a UNICA consulta paga que sobrou (o local de votacao sai da nossa
 * tabela desde a migration 042), e quem manda nela e a mesma chave que
 * manda nas outras consultas externas: "Conferir CPF e título de eleitor".
 * Time com a conferencia desligada e time que optou por nao consultar
 * fornecedor nenhum — e o mapa de moradia nao pode ser a excecao que
 * continua gastando.
 *
 * A pergunta e feita aqui, no unico caminho por onde toda consulta passa,
 * em vez de em cada rota: esquecer uma rota seria gastar pela porta
 * esquecida.
 */
async function residenceLookupEnabled(clientId: string): Promise<boolean> {
  const row = await selectOne<Pick<ClientRow, 'verification_enabled'>>(TABLES.clients, {
    select: 'verification_enabled',
    filters: { id: `eq.${clientId}` },
  });
  return row?.verification_enabled !== false;
}

/** O mesmo, a partir do integrante: o vinculo guarda o time dele. */
async function residenceEnabledForMember(memberId: string): Promise<boolean> {
  const row = await selectOne<Pick<MemberRow, 'client_id'>>(TABLES.members, {
    select: 'client_id',
    filters: { id: `eq.${memberId}` },
  });
  return row ? residenceLookupEnabled(row.client_id) : false;
}

/** Cria o vinculo PENDING. Idempotente: um registro por integrante e tipo. */
export async function createPendingLocation(
  clientId: string,
  memberId: string,
  kind: LocationKind,
): Promise<void> {
  const existing = await findLink(memberId, kind);
  if (existing) return;

  // Sem moradia em time com a conferencia desligada: o vinculo nem nasce,
  // entao nao fica pendencia acumulada esperando uma consulta que nao vai
  // acontecer.
  if (kind === 'RESIDENCE' && !(await residenceLookupEnabled(clientId))) return;

  await insertOne(
    TABLES.memberLocations,
    { client_id: clientId, member_id: memberId, location_kind: kind, status: 'PENDING' },
    'id',
  ).catch(() => undefined);
}

/**
 * Invalida apenas o tipo informado.
 *
 * Mudar o endereco declarado nao mexe no local de votacao, e uma nova consulta
 * eleitoral nao mexe na moradia.
 */
export async function invalidateLocation(
  clientId: string,
  memberId: string,
  kind: LocationKind,
): Promise<void> {
  const existing = await findLink(memberId, kind);
  if (!existing) {
    await createPendingLocation(clientId, memberId, kind);
    return;
  }

  await updateRows(
    TABLES.memberLocations,
    { member_id: `eq.${memberId}`, location_kind: `eq.${kind}` },
    {
      status: 'PENDING',
      query_hash: null,
      location_id: null,
      error_code: null,
      resolved_at: null,
      lock_token: null,
      locked_at: null,
    },
    'id',
  );
}

/* -------------------------------------------------------------------------
   Consulta
   ------------------------------------------------------------------------- */

async function cached(hash: string): Promise<MapLocationRow | null> {
  return selectOne<MapLocationRow>(TABLES.mapLocations, {
    select: '*',
    filters: { query_hash: `eq.${hash}` },
  });
}

async function remember(hash: string, place: MapPlace): Promise<MapLocationRow | null> {
  const row = await insertOne<MapLocationRow>(TABLES.mapLocations, {
    query_hash: hash,
    latitude: place.latitude,
    longitude: place.longitude,
    title: place.title,
    address: place.address,
    place_id: place.placeId,
    data_id: place.dataId,
    image_url: place.imageUrl,
    provider: 'SERPAPI_GOOGLE_MAPS',
    searched_at: new Date().toISOString(),
  }).catch(() => null);

  // Corrida entre duas execucoes: a unicidade decide e a outra linha serve.
  return row ?? (await cached(hash));
}

async function acquireLock(memberId: string, kind: LocationKind): Promise<MemberLocationRow | null> {
  const token = randomBytes(16).toString('hex');
  const now = new Date();
  const stale = new Date(now.getTime() - LOCK_TIMEOUT_MS).toISOString();

  const [locked] = await updateRows<MemberLocationRow>(
    TABLES.memberLocations,
    {
      member_id: `eq.${memberId}`,
      location_kind: `eq.${kind}`,
      or: `(lock_token.is.null,locked_at.lt.${stale})`,
    },
    { lock_token: token, locked_at: now.toISOString(), status: 'PROCESSING' },
  );

  return locked ?? null;
}

async function release(
  memberId: string,
  kind: LocationKind,
  patch: Record<string, string | number | null>,
): Promise<void> {
  await updateRows(
    TABLES.memberLocations,
    { member_id: `eq.${memberId}`, location_kind: `eq.${kind}` },
    { ...patch, lock_token: null, locked_at: null },
    'id',
  );
}

function errorCodeOf(error: unknown): MapErrorCode {
  return error instanceof MapLookupError ? error.code : 'UNEXPECTED';
}

/**
 * Endereco da MORADIA, montado a partir do que ja esta guardado.
 *
 * So da moradia: o local de votacao nao passa por aqui desde a migration
 * 042, porque ele nao e uma consulta — e uma linha do nosso banco.
 */
async function addressFor(
  memberId: string,
): Promise<{ query: string; expected: AddressParts; precision: LocationPrecision } | null> {
  const member = await selectOne<MemberRow>(TABLES.members, {
    select: 'id,client_id,street,district,city,state',
    filters: { id: `eq.${memberId}` },
  });
  if (!member) return null;

  const lookup = residenceLookup(member);
  return lookup
    ? {
        query: lookup.query,
        expected: { city: member.city, state: member.state },
        precision: lookup.precision,
      }
    : null;
}

/**
 * Onde a pessoa vota, pela nossa tabela.
 *
 * Tres numeros decidem: UF, zona e secao. De onde eles vem, em ordem:
 *
 *   1. a consulta eleitoral, quando o time confirma dados e ela deu certo —
 *      e a resposta da propria Justica Eleitoral;
 *   2. o que esta no cadastro, com a UF DO TIME. Zona e secao foram digitadas
 *      por quem preencheu (obrigatorias no time sem confirmacao, migration
 *      041), e a UF do time e o recorte que o proprio cadastro do time ja
 *      informa — numero de zona se repete entre estados;
 *   3. a UF declarada pela pessoa, quando o time e antigo e nao tem estado.
 *
 * Devolve nulo quando falta qualquer um dos tres: sem os tres nao existe
 * busca, e um local errado seria pior do que nenhum.
 */
async function pollingPlaceFor(memberId: string): Promise<PollingPlaceRow | null> {
  const member = await selectOne<MemberRow>(TABLES.members, {
    select: 'id,client_id,state,zone,section',
    filters: { id: `eq.${memberId}` },
  });
  if (!member) return null;

  const [client, verification] = await Promise.all([
    selectOne<Pick<ClientRow, 'state_uf'>>(TABLES.clients, {
      select: 'state_uf',
      filters: { id: `eq.${member.client_id}` },
    }).catch(() => null),
    selectOne<MemberVerificationRow>(TABLES.memberVerifications, {
      select: 'tse_payload,tse_status',
      filters: { member_id: `eq.${memberId}` },
    }).catch(() => null),
  ]);

  const eleitoral = decryptJson<TseResult>(verification?.tse_payload);

  return findPollingPlace({
    uf: eleitoral?.uf ?? client?.state_uf ?? member.state,
    zone: eleitoral?.zona ?? member.zone,
    section: eleitoral?.secao ?? member.section,
  });
}

/**
 * Guarda o local de votacao no cache de coordenadas.
 *
 * Nada e consultado: a linha e copiada da nossa tabela. O identificador da
 * consulta e o proprio local, entao todos os integrantes que votam naquela
 * escola apontam para a MESMA linha — que e o que o mapa agrupa em um pino.
 */
async function rememberPollingPlace(place: PollingPlaceRow): Promise<MapLocationRow | null> {
  if (place.latitude === null || place.longitude === null) return null;

  const hash = queryHash(`local-de-votacao:${place.id}`);
  const hit = await cached(hash);
  if (hit) return hit;

  const row = await insertOne<MapLocationRow>(TABLES.mapLocations, {
    query_hash: hash,
    latitude: place.latitude,
    longitude: place.longitude,
    title: place.name,
    address: pollingPlaceAddress(place),
    place_id: null,
    data_id: null,
    image_url: null,
    provider: 'CMD_LOCAIS_DE_VOTACAO',
    searched_at: new Date().toISOString(),
  }).catch(() => null);

  // Corrida entre duas execucoes: a unicidade decide e a outra linha serve.
  return row ?? (await cached(hash));
}

/**
 * Resolve o local de votacao, SEM provedor nenhum.
 *
 * Nao encontrado quer dizer exatamente isso: aquela UF ainda nao foi
 * importada, a secao e nova, ou o numero digitado nao existe. Nao ha
 * tentativa paga de adivinhar — o integrante fica no mapa so pela moradia, e
 * o painel mostra que o local nao foi encontrado, que e a verdade.
 */
async function resolvePollingPlaceLink(
  memberId: string,
  locked: MemberLocationRow,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const place = await pollingPlaceFor(memberId);

  if (!place) {
    await release(memberId, 'POLLING_PLACE', {
      status: 'NOT_FOUND',
      location_id: null,
      error_code: null,
      attempts: locked.attempts + 1,
      requested_at: startedAt,
      resolved_at: new Date().toISOString(),
    });
    return;
  }

  const saved = await rememberPollingPlace(place);

  if (!saved) {
    // Local sem coordenada na planilha do TSE: ele existe, mas nao vira
    // pino. Inventar um ponto seria pior do que nao ter nenhum.
    await release(memberId, 'POLLING_PLACE', {
      status: 'NOT_FOUND',
      location_id: null,
      error_code: null,
      attempts: locked.attempts + 1,
      requested_at: startedAt,
      resolved_at: new Date().toISOString(),
    });
    return;
  }

  await release(memberId, 'POLLING_PLACE', {
    status: 'SUCCESS',
    query_hash: saved.query_hash,
    location_id: saved.id,
    location_precision: 'STREET',
    error_code: null,
    attempts: locked.attempts + 1,
    requested_at: startedAt,
    resolved_at: new Date().toISOString(),
  });
}

/**
 * Resolve um vinculo pendente.
 *
 * Local de votacao sai da nossa tabela, sem provedor e sem cobranca. Moradia
 * consulta o cache primeiro e so chama o provedor quando aquele endereco e
 * inedito — e nunca repete uma consulta que falhou: isso e decisao do ADMIN.
 */
export async function resolveLocation(memberId: string, kind: LocationKind): Promise<void> {
  const current = await findLink(memberId, kind);
  if (!current || current.status === 'SUCCESS' || current.status === 'PROCESSING') return;

  // Ultima porta antes do provedor: nenhuma moradia e consultada em time com
  // a conferencia desligada, venha o pedido de onde vier — envio do
  // formulario, fila de pendentes ou o botao de tentar de novo. Vinculos
  // criados antes de desligar param aqui.
  if (kind === 'RESIDENCE' && !(await residenceEnabledForMember(memberId))) return;

  const locked = await acquireLock(memberId, kind);
  if (!locked) return;

  if (kind === 'POLLING_PLACE') {
    await resolvePollingPlaceLink(memberId, locked);
    return;
  }

  const address = await addressFor(memberId);
  if (!address) {
    await release(memberId, kind, {
      status: 'NOT_FOUND',
      error_code: 'MISSING_DATA',
      resolved_at: new Date().toISOString(),
    });
    return;
  }

  const hash = queryHash(address.query);
  const hit = await cached(hash);

  if (hit) {
    // Mesma rua ou mesma escola de outro integrante: nada e consultado.
    await release(memberId, kind, {
      status: 'SUCCESS',
      query_hash: hash,
      location_id: hit.id,
      location_precision: address.precision,
      error_code: null,
      requested_at: locked.requested_at ?? new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    });
    return;
  }

  const startedAt = new Date().toISOString();

  try {
    const place = await lookupPlace(address.query, address.expected);

    if (!place) {
      await release(memberId, kind, {
        status: 'NOT_FOUND',
        query_hash: hash,
        location_id: null,
        error_code: null,
        attempts: locked.attempts + 1,
        requested_at: startedAt,
        resolved_at: new Date().toISOString(),
      });
      return;
    }

    const saved = await remember(hash, place);
    await release(memberId, kind, {
      status: saved ? 'SUCCESS' : 'FAILED',
      query_hash: hash,
      location_id: saved?.id ?? null,
      location_precision: saved ? address.precision : null,
      error_code: saved ? null : 'UNEXPECTED',
      attempts: locked.attempts + 1,
      requested_at: startedAt,
      resolved_at: new Date().toISOString(),
    });
  } catch (error) {
    await release(memberId, kind, {
      status: 'FAILED',
      query_hash: hash,
      error_code: errorCodeOf(error),
      attempts: locked.attempts + 1,
      requested_at: startedAt,
      resolved_at: new Date().toISOString(),
    });
  }
}

/**
 * Garante o vinculo de moradia de quem ainda nao tem.
 *
 * Basta municipio e UF: rua e bairro apenas deixam o ponto mais preciso.
 * Idempotente e sem consultar nada.
 */
export async function ensureResidenceLinks(limit = 200): Promise<void> {
  const [members, links, clients] = await Promise.all([
    selectRows<MemberRow>(TABLES.members, {
      select: 'id,client_id,city,state',
      order: 'created_at.desc',
      limit,
    }),
    selectRows<MemberLocationRow>(TABLES.memberLocations, {
      select: 'member_id,location_kind',
      filters: { location_kind: 'eq.RESIDENCE' },
      limit: 2000,
    }),
    // Times com a conferencia desligada nao entram: sem isto, cada abertura
    // do mapa percorreria as mesmas pessoas para nao criar vinculo nenhum.
    selectRows<Pick<ClientRow, 'id' | 'verification_enabled'>>(TABLES.clients, {
      select: 'id,verification_enabled',
    }),
  ]);

  const existing = new Set(links.map((link) => link.member_id));
  const desligados = new Set(
    clients.filter((row) => row.verification_enabled === false).map((row) => row.id),
  );

  for (const member of members) {
    if (existing.has(member.id)) continue;
    if (desligados.has(member.client_id)) continue;
    if (!member.city?.trim() || !member.state?.trim()) continue;
    await createPendingLocation(member.client_id, member.id, 'RESIDENCE');
  }
}

/**
 * Processa os vinculos pendentes, um de cada vez.
 *
 * Sequencial de proposito: consultas simultaneas poderiam perguntar duas vezes
 * o mesmo endereco antes de o cache existir.
 */
export async function resolvePending(limit = 25): Promise<{ processed: number }> {
  const pending = await selectRows<MemberLocationRow>(TABLES.memberLocations, {
    select: 'member_id,location_kind',
    filters: { status: `eq.PENDING`, lock_token: 'is.null' },
    order: 'created_at.asc',
    limit,
  });

  let processed = 0;
  for (const row of pending) {
    await resolveLocation(row.member_id, row.location_kind);
    processed += 1;
  }

  return { processed };
}

/** Nova tentativa manual, pedida pelo ADMIN. Pode gerar cobranca. */
export async function retryLocation(memberId: string, kind: LocationKind): Promise<void> {
  await updateRows(
    TABLES.memberLocations,
    { member_id: `eq.${memberId}`, location_kind: `eq.${kind}` },
    { status: 'PENDING', error_code: null, lock_token: null, locked_at: null },
    'id',
  );
  await resolveLocation(memberId, kind);
}

/* -------------------------------------------------------------------------
   Leitura pelo ADMIN
   ------------------------------------------------------------------------- */

/** Restringe os vinculos aos integrantes de um unico time. */
/** Teto de vinculos desenhados de uma vez, no mapa geral e no do time. */
const MAP_LINK_LIMIT = 2000;

/**
 * Vinculos de UM time, buscados NO BANCO pelos integrantes dele.
 *
 * Antes, o mapa do time lia os 2.000 vinculos mais recentes do sistema
 * INTEIRO e so depois peneirava, em memoria, os que eram daquele time. Isso
 * funcionou enquanto o sistema todo cabia em 2.000 vinculos. Quando um Time
 * DEMO — que hoje vai a 5.000 pessoas — foi gerado, os vinculos dele, recem
 * gravados, tomaram a janela inteira por serem os mais RECENTES, e o time
 * real, mais antigo, simplesmente nao vinha na consulta. A peneira entao
 * nao achava nada e a pagina do time mostrava o mapa vazio, com todos os
 * numeros zerados — inclusive "pendentes", que e o sinal de que nao houve
 * filtro nenhum: nao havia dado.
 *
 * Agora o recorte e do BANCO: pedimos os vinculos DESTE time. O que outro
 * time gravou, por mais recente e por mais numeroso que seja, nao disputa
 * mais espaco com ele.
 */
/**
 * Lideres do banco sem aba na planilha do Sheets (052): com a planilha
 * ligada, os Lideres do time sao os dela, e o mapa mostra quem a lista
 * mostra. Vazio em time sem planilha.
 */
async function lideresForaDaPlanilha(clientId: string): Promise<Set<string>> {
  if (!(await sheetEnabled(clientId))) return new Set();
  return (await equipeDaPlanilha(clientId))?.lideresForaDaPlanilha ?? new Set();
}

async function clientLinks(clientId: string): Promise<MemberLocationRow[]> {
  const [todosDoTime, foraDaPlanilha] = await Promise.all([
    selectRows<{ id: string }>(TABLES.members, {
    // O filtro do PostgREST precisa do operador: sem o `eq.` o banco recusa a
    // consulta e o mapa do time nao abre.
    select: 'id',
    // Mesmo recorte da lista do time: no duplicado com planilha do Sheets
    // (052), o mapa mostra quem a lista mostra.
    filters: { client_id: `eq.${clientId}`, ...(await sheetVisibilityFilter(clientId)) },
    }),
    lideresForaDaPlanilha(clientId),
  ]);
  const clientMembers = todosDoTime.filter((member) => !foraDaPlanilha.has(member.id));

  if (clientMembers.length === 0) return [];

  const links = await selectRows<MemberLocationRow>(TABLES.memberLocations, {
    select: '*',
    filters: { member_id: inFilter(clientMembers.map((member) => member.id)) },
    order: 'updated_at.desc',
    // Sem `limit` AQUI de proposito: uma lista longa de identificadores sai
    // em LOTES (`selectRows`), e um teto na consulta cortaria cada lote, e
    // nao o conjunto — devolvendo um pedaco de cada pedaco. O teto e
    // aplicado abaixo, sobre o total ja reunido.
  });

  return links
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, MAP_LINK_LIMIT);
}

/* -------------------------------------------------------------------------
   Planilha do Google Sheets no mapa do time duplicado (migration 052)
   ------------------------------------------------------------------------- */

/** Uma pessoa da planilha, com a escola onde vota. */
interface PessoaDaPlanilhaNaEscola {
  member: Member;
  place: PollingPlaceRow;
  /** A mesma chave do pino da escola, para somar no pino certo. */
  key: string;
}

/**
 * Chave do pino de uma escola da tabela do TSE. E exatamente a chave que o
 * mapa usa para a mesma escola quando ela veio de um cadastro do banco
 * (`rememberPollingPlace` grava titulo e coordenada da mesma linha).
 */
function chaveDaEscola(place: PollingPlaceRow): string {
  return pollingPlaceKey({
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    title: place.name,
  });
}

/**
 * A Equipe da planilha, cada pessoa na escola onde vota — calculado NA HORA.
 *
 * A planilha e lida ao vivo e nada dela e gravado; por isso o local de
 * votacao tambem nao e: sai da zona + secao da planilha, procurado na tabela
 * do TSE do proprio sistema (so leitura, sem consulta paga). Quem nao tem
 * zona e secao, ou tem uma que a tabela nao conhece, conta como "local nao
 * encontrado", como qualquer cadastro.
 */
async function escolasDaPlanilha(
  clientId: string,
): Promise<{ pessoas: PessoaDaPlanilhaNaEscola[]; semLocal: number }> {
  const planilha = await equipeDaPlanilha(clientId);
  if (!planilha) return { pessoas: [], semLocal: 0 };

  const comSecao = planilha.membros.filter(
    (member) => member.tier === 'EQUIPE' && member.zone && member.section,
  );
  if (comSecao.length === 0) return { pessoas: [], semLocal: 0 };

  // Uma consulta so, com todas as zonas, na UF do time: a planilha nao tem
  // estado, e numero de zona se repete entre estados.
  const pessoas: PessoaDaPlanilhaNaEscola[] = [];
  let semLocal = 0;
  {
    const membros = comSecao;
    const locais = await pollingPlacesOfZones(planilha.estado, membros.map((member) => member.zone));
    for (const member of membros) {
      const place = pollingPlaceIn(locais, member.zone, member.section);
      if (!place || place.latitude === null || place.longitude === null) {
        semLocal += 1;
        continue;
      }
      pessoas.push({ member, place, key: chaveDaEscola(place) });
    }
  }
  return { pessoas, semLocal };
}

/** Prefixo do pino de escola que so tem gente da planilha (nao ha linha no banco). */
const ESCOLA_DA_PLANILHA = 'planilha-local:';

/**
 * Soma a Equipe da planilha nas escolas do mapa. A escola que ja tem pino
 * (por alguem do banco) ganha as pessoas da planilha no mesmo pino; a que
 * nao tem ganha um pino proprio.
 */
function somarPlanilha(
  payload: MapOverviewPayload,
  planilha: { pessoas: PessoaDaPlanilhaNaEscola[]; semLocal: number } | null,
): MapOverviewPayload {
  if (!planilha || (planilha.pessoas.length === 0 && planilha.semLocal === 0)) return payload;

  const escolas = [...payload.pollingPlaces];
  const porChave = new Map(
    escolas.map((pin) => [
      pollingPlaceKey({ latitude: pin.latitude, longitude: pin.longitude, title: pin.title }),
      pin,
    ]),
  );

  for (const { member, place, key } of planilha.pessoas) {
    let pin = porChave.get(key);
    if (!pin) {
      pin = {
        locationId: `${ESCOLA_DA_PLANILHA}${place.id}`,
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
        title: place.name,
        address: pollingPlaceAddress(place),
        city: place.city,
        state: place.uf,
        imageUrl: null,
        total: 0,
        men: 0,
        women: 0,
        others: 0,
        sections: [],
      } satisfies PollingPlacePin;
      porChave.set(key, pin);
      escolas.push(pin);
    }

    pin.total += 1;
    // A planilha nao tem genero: conta como "outros", como um cadastro sem ele.
    pin[genderBucket(member.gender)] += 1;

    const zona = member.zone?.trim() || null;
    const secao = member.section?.trim() || null;
    const chaveSecao = sectionKey({ zone: zona, section: secao });
    const existente = pin.sections.find((row) => sectionKey(row) === chaveSecao);
    if (existente) existente.total += 1;
    else pin.sections.push({ zone: zona, section: secao, total: 1 });

    // A planilha so traz Equipe: cada pessoa conta no Lider que a cadastrou.
    const lider = liderDaEquipe(member.recruitedBy?.userId, member.recruitedBy?.name);
    if (lider) addToLeader(pin, lider, genderBucket(member.gender), zona, secao);
  }

  return {
    ...payload,
    pollingPlaces: escolas,
    totals: {
      ...payload.totals,
      pollingPlace: payload.totals.pollingPlace + planilha.pessoas.length,
      notFound: payload.totals.notFound + planilha.semLocal,
    },
  };
}

/** As pessoas da planilha que votam na escola deste pino. */
async function pessoasDaPlanilhaNaEscola(locationId: string, clientId: string): Promise<Member[]> {
  const planilha = await escolasDaPlanilha(clientId);
  if (planilha.pessoas.length === 0) return [];

  if (locationId.startsWith(ESCOLA_DA_PLANILHA)) {
    const placeId = locationId.slice(ESCOLA_DA_PLANILHA.length);
    return planilha.pessoas.filter((row) => row.place.id === placeId).map((row) => row.member);
  }

  const local = await selectOne<Pick<MapLocationRow, 'latitude' | 'longitude' | 'title'>>(
    TABLES.mapLocations,
    { select: 'latitude,longitude,title', filters: { id: `eq.${locationId}` } },
  ).catch(() => null);
  if (!local) return [];
  const chave = pollingPlaceKey({
    latitude: Number(local.latitude),
    longitude: Number(local.longitude),
    title: local.title,
  });
  return planilha.pessoas.filter((row) => row.key === chave).map((row) => row.member);
}

/** O Lider de quem e da Equipe: chave e nome, como o filtro do mapa usa. */
function liderDaEquipe(userId: string | null | undefined, name: string | null | undefined): { id: string; name: string } | null {
  const nome = name?.trim();
  const id = leaderKey(userId, nome);
  return id && nome ? { id, name: nome } : null;
}

/** Quem e Lider nao tem Lider acima: so a Equipe entra na conta de alguem. */
function liderDoIntegrante(
  member: Pick<MemberRow, 'recruited_by_role' | 'recruited_by_user_id' | 'recruited_by_name'>,
): { id: string; name: string } | null {
  if (tierOf(member.recruited_by_role) !== 'EQUIPE') return null;
  return liderDaEquipe(member.recruited_by_user_id, member.recruited_by_name);
}

/**
 * A referencia de cada Lider do time (o filtro "Referência" do mapa), pela
 * chave que a Equipe usa para apontar para ele — o usuario dele ou, sem
 * usuario, o vinculo da planilha — e tambem pela chave do nome.
 *
 * Com a planilha ligada, o que a linha do Lider na aba dele diz vale (como
 * na lista do time), e os Lideres que so existem na planilha entram tambem.
 * Banco sem a coluna de referencia (antes da migration 051): sem filtro,
 * nunca sem mapa.
 */
async function referenciasDosLideres(clientId: string): Promise<Record<string, string>> {
  const [linhas, planilha] = await Promise.all([
    selectRows<Pick<MemberRow, 'id' | 'name' | 'reference'>>(TABLES.members, {
      select: 'id,name,reference',
      // So os Lideres: quem nao foi cadastrado por alguem da Equipe.
      filters: { client_id: `eq.${clientId}`, or: '(recruited_by_role.is.null,recruited_by_role.neq.EQUIPE)' },
    }).catch(() => [] as Pick<MemberRow, 'id' | 'name' | 'reference'>[]),
    equipeDaPlanilha(clientId).catch(() => null),
  ]);
  const usuarios = linhas.length
    ? await selectRows<Pick<UserRow, 'id' | 'member_id'>>(TABLES.users, {
        select: 'id,member_id',
        filters: { member_id: inFilter(linhas.map((row) => row.id)) },
      }).catch(() => [] as Pick<UserRow, 'id' | 'member_id'>[])
    : [];
  const usuarioDe = new Map(usuarios.map((row) => [row.member_id, row.id]));

  const referencias: Record<string, string> = {};
  const anotar = (chave: string | null | undefined, nome: string, referencia: string | null | undefined) => {
    const texto = referencia?.replace(/\s+/g, ' ').trim();
    if (!texto) return;
    if (chave) referencias[chave] = texto;
    const peloNome = leaderKey(null, nome);
    if (peloNome && !referencias[peloNome]) referencias[peloNome] = texto;
  };

  for (const row of linhas) {
    const linhaDaAba = planilha?.dadosDoLider.get(row.id);
    const chave = usuarioDe.get(row.id) ?? planilha?.vinculoDoLider.get(row.id) ?? null;
    anotar(chave, row.name, linhaDaAba?.reference || row.reference);
  }
  for (const membro of planilha?.membros ?? []) {
    if (membro.tier === 'LIDER') anotar(membro.userId, membro.name, membro.reference);
  }
  return referencias;
}

/**
 * Monta o mapa para o painel.
 *
 * Nada sensivel sai daqui: sem CPF, telefone, endereco residencial completo,
 * numero, ou qualquer parte do retorno da consulta cadastral.
 */
export async function mapOverview(clientId?: string): Promise<MapOverviewPayload> {
  // Mapa do TIME: junto, a referencia de cada Lider (o filtro "Referência").
  if (clientId) {
    const [payload, referencias] = await Promise.all([montarMapa(clientId), referenciasDosLideres(clientId)]);
    return { ...payload, referencias };
  }
  return montarMapa();
}

async function montarMapa(clientId?: string): Promise<MapOverviewPayload> {
  // Mapa do TIME: o recorte e do banco, pelos integrantes dele — inclusive
  // quando ele e o proprio Time DEMO, que dentro da propria pagina mostra
  // tudo. Mapa GERAL: os Times DEMO ficam de fora, como em toda metrica
  // global.
  const [scopedLinks, planilha] = await Promise.all([
    clientId
      ? clientLinks(clientId)
      : selectRows<MemberLocationRow>(TABLES.memberLocations, {
          select: '*',
          filters: await withoutDemoClients(),
          order: 'updated_at.desc',
          limit: MAP_LINK_LIMIT,
        }),
    // Mapa do time duplicado com a planilha do Sheets ligada (052): a Equipe
    // da planilha entra nas escolas, calculada na hora. Nulo no resto.
    clientId ? escolasDaPlanilha(clientId) : Promise.resolve(null),
  ]);

  const totals = { residence: 0, pollingPlace: 0, pending: 0, notFound: 0 };
  const resolved = scopedLinks.filter((link) => link.status === 'SUCCESS' && link.location_id);

  for (const link of scopedLinks) {
    if (link.status === 'SUCCESS' && link.location_id) {
      if (link.location_kind === 'RESIDENCE') totals.residence += 1;
      else totals.pollingPlace += 1;
    } else if (link.status === 'NOT_FOUND') totals.notFound += 1;
    else totals.pending += 1;
  }

  if (resolved.length === 0) return somarPlanilha({ pins: [], pollingPlaces: [], totals }, planilha);

  const locationIds = [...new Set(resolved.map((link) => link.location_id as string))];
  const memberIds = [...new Set(resolved.map((link) => link.member_id))];

  const [places, members] = await Promise.all([
    selectRows<MapLocationRow>(TABLES.mapLocations, {
      select: 'id,latitude,longitude,title,address,place_id,data_id,image_url',
      filters: { id: inFilter(locationIds) },
    }),
    selectRows<MemberRow>(TABLES.members, {
      select:
        'id,client_id,name,phone,gender,photo_path,street,district,city,state,zone,section,recruited_by_role,recruited_by_user_id,recruited_by_name',
      filters: { id: inFilter(memberIds) },
    }),
  ]);

  const clientIds = [...new Set(members.map((member) => member.client_id))];
  // Foto e e-mail so aparecem no pino de MORADIA, e o retorno eleitoral so
  // completa o pino de ESCOLA: cada um e buscado so para quem vai usar. O
  // retorno eleitoral, alem de pesado, e decifrado linha a linha.
  const residentes = new Set(
    resolved.filter((link) => link.location_kind === 'RESIDENCE').map((link) => link.member_id),
  );
  const eleitores = [
    ...new Set(resolved.filter((link) => link.location_kind !== 'RESIDENCE').map((link) => link.member_id)),
  ];
  const [clients, photos, verifications, emails] = await Promise.all([
    selectRows<{ id: string; name: string }>(TABLES.clients, {
      select: 'id,name',
      filters: { id: inFilter(clientIds) },
    }),
    signedUrls(members.map((member) => (residentes.has(member.id) ? member.photo_path : null))),
    eleitores.length
      ? selectRows<MemberVerificationRow>(TABLES.memberVerifications, {
          select: 'member_id,tse_payload',
          filters: { member_id: inFilter(eleitores) },
        })
      : Promise.resolve([] as MemberVerificationRow[]),
    memberEmails([...residentes], clientIds),
  ]);

  const placeById = new Map(places.map((place) => [place.id, place]));
  const memberById = new Map(members.map((member, index) => [member.id, { member, photo: photos[index] ?? null }]));
  const clientById = new Map(clients.map((client) => [client.id, client.name]));
  const tseById = new Map(
    verifications.map((row) => [row.member_id, decryptJson<TseResult>(row.tse_payload)]),
  );

  const pins: MapPin[] = [];

  /**
   * Locais de votacao agrupados: um pino por escola. Nenhum nome entra aqui;
   * as contagens vem dos integrantes cadastrados no CMD.
   */
  const grouped = new Map<string, PollingPlacePin>();

  for (const link of resolved) {
    const place = placeById.get(link.location_id as string);
    const entry = memberById.get(link.member_id);
    if (!place || !entry) continue;

    const { member, photo } = entry;

    if (link.location_kind === 'RESIDENCE') {
      pins.push({
        memberId: member.id,
        memberName: member.name,
        memberPhoto: photo,
        clientId: member.client_id,
        clientName: clientById.get(member.client_id) ?? 'Time',
        locationKind: 'RESIDENCE',
        latitude: place.latitude,
        longitude: place.longitude,
        place: member.street,
        district: member.district,
        city: member.city,
        state: member.state,
        zone: null,
        section: null,
        precision: link.location_precision ?? 'CITY',
        // Somente para o ADMIN autenticado, que e quem alcanca esta rota.
        phone: member.phone?.trim() ? member.phone : null,
        email: emails.get(member.id) ?? null,
        // Pino de Lider abre as acoes dele no mapa (Equipe, inconsistencias,
        // PDFs).
        tier: tierOf(member.recruited_by_role),
        leaderId: liderDoIntegrante(member)?.id ?? null,
      });
      continue;
    }

    const eleitoral = tseById.get(member.id);
    const key = pollingPlaceKey({
      placeId: place.place_id,
      dataId: place.data_id,
      latitude: place.latitude,
      longitude: place.longitude,
      title: place.title,
    });

    const current =
      grouped.get(key) ??
      ({
        locationId: place.id,
        latitude: place.latitude,
        longitude: place.longitude,
        title: place.title ?? eleitoral?.local ?? null,
        address: place.address ?? eleitoral?.logradouro ?? null,
        // Sem retorno eleitoral, vale o municipio declarado por quem vota
        // ali: sem isso o filtro por cidade escondia a escola inteira, e o
        // popup abria sem dizer onde ela fica.
        city: eleitoral?.municipio ?? member.city ?? null,
        state: eleitoral?.uf ?? member.state ?? null,
        imageUrl: place.image_url,
        total: 0,
        men: 0,
        women: 0,
        others: 0,
        sections: [],
      } satisfies PollingPlacePin);

    // Uma pessoa cadastrada que vota ali, um voto: e daqui que sai a
    // estimativa mostrada na escola.
    current.total += 1;
    // Genero declarado no cadastro; o que a consulta externa devolveu nao entra.
    current[genderBucket(member.gender)] += 1;

    // A mesma estimativa, quebrada por secao. Zona e secao saem do CADASTRO,
    // e nao do retorno da consulta: e o que a pessoa informou e confirmou.
    // Quem nao tem os dois entra em uma linha propria, para a soma das
    // secoes continuar fechando com o total da escola.
    const zona = member.zone?.trim() || null;
    const secao = member.section?.trim() || null;
    const chaveSecao = sectionKey({ zone: zona, section: secao });
    const secoes = current.sections;
    const existente = secoes.find((row) => sectionKey(row) === chaveSecao);

    if (existente) existente.total += 1;
    else secoes.push({ zone: zona, section: secao, total: 1 });

    // E por Lider: quantas pessoas cada um cadastrou nesta escola.
    const lider = liderDoIntegrante(member);
    if (lider) addToLeader(current, lider, genderBucket(member.gender), zona, secao);

    grouped.set(key, current);
  }

  return somarPlanilha({ pins, pollingPlaces: [...grouped.values()], totals }, planilha);
}

/* -------------------------------------------------------------------------
   Pessoas de um local de votacao
   ------------------------------------------------------------------------- */

/**
 * Lista as pessoas que votam em um local.
 *
 * Chamada somente depois do clique em "Ver pessoas". Devolve o minimo: foto,
 * nome, cliente, zona/secao e, quando existirem, telefone e e-mail. CPF,
 * dados da consulta cadastral, renda, parentescos e sinais do aparelho nunca
 * entram nesta lista.
 *
 * Com `clientId`, a lista fica restrita a equipe daquele time: e assim que o
 * Administrador do time enxerga um local de votacao sem ver quem e de outra
 * operacao. O recorte vem da sessao, nunca da URL.
 */
export async function placeMembers(
  locationId: string,
  options: {
    search?: string;
    page?: number;
    pageSize?: number;
    clientId?: string;
    /**
     * Time cuja planilha do Sheets entra na lista (052), sem recortar o resto.
     * E como o ADMIN geral, que ve todos os times, pede o mapa de um time.
     */
    sheetClientId?: string;
    /** So a Equipe deste Lider (chave de `leaderKey`): o filtro "Lider" do mapa. */
    leaderId?: string;
  } = {},
): Promise<PlaceMembersPayload> {
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(50, Math.max(5, Math.trunc(options.pageSize ?? 20)));

  // Escola que so tem gente da planilha do Sheets (052): nao ha linha dela
  // no banco, e a consulta abaixo nem e feita.
  const soDaPlanilha = locationId.startsWith(ESCOLA_DA_PLANILHA);

  const links = soDaPlanilha
    ? []
    : await selectRows<MemberLocationRow>(TABLES.memberLocations, {
        select: 'member_id,location_id,location_kind,status',
        filters: {
          location_id: `eq.${locationId}`,
          location_kind: 'eq.POLLING_PLACE',
          status: 'eq.SUCCESS',
          // Sem time pedido, a lista e a do mapa geral: Time DEMO e copia
          // ficam fora — menos o time do proprio mapa, quando o ADMIN abre o
          // mapa de um time duplicado: a escola lista quem o pino contou.
          ...(options.clientId ? {} : await withoutOffBooksExcept(options.sheetClientId)),
        },
        limit: 2000,
      });

  const memberIds = [...new Set(links.map((link) => link.member_id))];
  // ADMIN geral no mapa de um duplicado com a planilha ligada: a Equipe do
  // banco dessa copia fica escondida aqui tambem, como na lista do time.
  const esconderEquipeDe =
    options.sheetClientId && (await sheetEnabled(options.sheetClientId)) ? options.sheetClientId : null;
  const [linhasDoBanco, daPlanilha] = await Promise.all([
    memberIds.length === 0
      ? Promise.resolve([] as MemberRow[])
      : selectRows<MemberRow>(TABLES.members, {
          select: 'id,client_id,name,phone,photo_path,recruited_by_role,recruited_by_user_id,recruited_by_name',
          filters: {
            id: inFilter(memberIds),
            ...(options.clientId ? { client_id: `eq.${options.clientId}` } : {}),
            // Mesmo recorte da lista do time: com a planilha ligada, a Equipe
            // do banco da copia fica escondida (052).
            ...(options.clientId ? await sheetVisibilityFilter(options.clientId) : {}),
          },
          order: 'name.asc',
        }),
    // A Equipe da planilha que vota nesta escola, calculada na hora.
    options.clientId || options.sheetClientId
      ? pessoasDaPlanilhaNaEscola(locationId, (options.clientId ?? options.sheetClientId)!)
      : Promise.resolve([]),
  ]);

  const timeDaPlanilha = options.clientId ?? options.sheetClientId ?? null;
  const foraDaPlanilha = timeDaPlanilha ? await lideresForaDaPlanilha(timeDaPlanilha) : new Set<string>();
  const members = (
    esconderEquipeDe
      ? linhasDoBanco.filter(
          (row) => !(row.client_id === esconderEquipeDe && row.recruited_by_role === 'EQUIPE'),
        )
      : linhasDoBanco
  ).filter((row) => !foraDaPlanilha.has(row.id));

  type Linha = { tipo: 'banco'; row: MemberRow } | { tipo: 'planilha'; member: Member };
  const todas: Linha[] = [
    ...members.map((row) => ({ tipo: 'banco' as const, row })),
    ...daPlanilha.map((member) => ({ tipo: 'planilha' as const, member })),
  ];
  const nomeDe = (linha: Linha) => (linha.tipo === 'banco' ? linha.row.name : linha.member.name);
  if (daPlanilha.length > 0) todas.sort((a, b) => nomeDe(a).localeCompare(nomeDe(b), 'pt-BR'));

  const liderDe = (linha: Linha) =>
    linha.tipo === 'banco'
      ? liderDoIntegrante(linha.row)?.id
      : linha.member.tier === 'EQUIPE'
        ? liderDaEquipe(linha.member.recruitedBy?.userId, linha.member.recruitedBy?.name)?.id
        : undefined;
  const doLider = options.leaderId ? todas.filter((linha) => liderDe(linha) === options.leaderId) : todas;

  const term = normalizeQuery(options.search ?? '');
  const matched = term ? doLider.filter((linha) => normalizeQuery(nomeDe(linha)).includes(term)) : doLider;

  const total = matched.length;
  const slice = matched.slice((page - 1) * pageSize, page * pageSize);
  if (slice.length === 0) return { items: [], total, page, pageSize };

  const doBanco = slice.flatMap((linha) => (linha.tipo === 'banco' ? [linha.row] : []));
  const clientIds = [
    ...new Set([...doBanco.map((member) => member.client_id), ...daPlanilha.map((member) => member.clientId)]),
  ];
  const sliceIds = doBanco.map((member) => member.id);

  const [clients, photos, verifications, emails] = await Promise.all([
    selectRows<{ id: string; name: string }>(TABLES.clients, {
      select: 'id,name',
      filters: { id: inFilter(clientIds) },
    }),
    signedUrls(doBanco.map((member) => member.photo_path)),
    sliceIds.length === 0
      ? Promise.resolve([] as MemberVerificationRow[])
      : selectRows<MemberVerificationRow>(TABLES.memberVerifications, {
          select: 'member_id,tse_payload',
          filters: { member_id: inFilter(sliceIds) },
        }),
    memberEmails(sliceIds, clientIds),
  ]);

  const clientById = new Map(clients.map((client) => [client.id, client.name]));
  const photoById = new Map(doBanco.map((member, index) => [member.id, photos[index] ?? null]));
  const tseById = new Map(
    verifications.map((row) => [row.member_id, decryptJson<TseResult>(row.tse_payload)]),
  );

  const items: PlaceMember[] = slice.map((linha) => {
    if (linha.tipo === 'planilha') {
      const { member } = linha;
      return {
        memberId: member.id,
        name: member.name,
        photo: null,
        clientId: member.clientId,
        clientName: clientById.get(member.clientId) ?? 'Time',
        phone: member.phone?.trim() ? member.phone : null,
        email: null,
        zone: member.zone,
        section: member.section,
        cadastradoPor: member.recruitedBy ? recruiterText(member.recruitedBy) : null,
        tier: member.tier,
        lider: member.tier === 'EQUIPE' ? member.recruitedBy?.name.trim() || null : null,
      };
    }
    const member = linha.row;
    const eleitoral = tseById.get(member.id);
    const tier = tierOf(member.recruited_by_role);
    return {
      memberId: member.id,
      name: member.name,
      photo: photoById.get(member.id) ?? null,
      clientId: member.client_id,
      clientName: clientById.get(member.client_id) ?? 'Time',
      phone: member.phone?.trim() ? member.phone : null,
      email: emails.get(member.id) ?? null,
      zone: eleitoral?.zona ?? null,
      section: eleitoral?.secao ?? null,
      // Do snapshot gravado no cadastro: quem cadastra pelo link pessoal e
      // Lider (perfil EQUIPE no nivel de Lider).
      cadastradoPor: member.recruited_by_name
        ? recruiterText({
            userId: member.recruited_by_user_id,
            name: member.recruited_by_name,
            role: member.recruited_by_role ?? 'ADMIN',
            tier: member.recruited_by_role === 'EQUIPE' ? 'LIDER' : null,
            photo: null,
          })
        : null,
      tier,
      // Quem e da Equipe foi cadastrado pelo proprio Lider.
      lider: tier === 'EQUIPE' ? member.recruited_by_name?.trim() || null : null,
    };
  });

  return { items, total, page, pageSize };
}

/** O recorte do mapa geral, sem esconder o time do proprio mapa. */
async function withoutOffBooksExcept(clientId: string | undefined): Promise<Record<string, string>> {
  if (!clientId) return withoutDemoClients();
  const fora = (await offBooksClientIds()).filter((id) => id !== clientId);
  return fora.length > 0 ? { client_id: notInFilter(fora) } : {};
}

/** E-mail, quando o cliente tiver um campo desse tipo preenchido. */
async function memberEmails(
  memberIds: string[],
  clientIds: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (memberIds.length === 0 || clientIds.length === 0) return found;

  const fields = await selectRows<{ id: string }>(TABLES.formFields, {
    select: 'id',
    filters: { client_id: inFilter(clientIds), type: 'eq.email' },
  });
  if (fields.length === 0) return found;

  const responses = await selectRows<{ member_id: string; field_id: string; value: unknown }>(
    TABLES.memberResponses,
    {
      select: 'member_id,field_id,value',
      filters: { member_id: inFilter(memberIds), field_id: inFilter(fields.map((f) => f.id)) },
    },
  );

  for (const row of responses) {
    const value = typeof row.value === 'string' ? row.value.trim() : '';
    if (value && !found.has(row.member_id)) found.set(row.member_id, value.slice(0, 160));
  }

  return found;
}

/** Usado quando o integrante e removido: o lugar continua servindo aos demais. */
export async function deleteMemberLocations(memberId: string): Promise<void> {
  await deleteRows(TABLES.memberLocations, { member_id: `eq.${memberId}` }, 'id');
}
