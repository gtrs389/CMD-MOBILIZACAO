import 'server-only';
import {
  buildQuery,
  residenceLookup,
  type AddressParts,
  type LocationPrecision,
  type MapErrorCode,
  type MapPlace,
} from '@/lib/domain/map-location';
import type { DemoResidence } from '@/lib/domain/demo';
import { isUsableDemoCoordinate, type DemoPollingPlace } from '@/lib/domain/demo-catalog';
import { TABLES, type MapLocationRow, type PollingPlaceRow } from '@/lib/supabase/tables';
import { inFilter, insertOne, insertRowsInChunks, selectOne, selectRows } from '@/lib/supabase/rest';
import {
  pollingPlaceCacheRow,
  pollingPlaceHash,
  queryHash,
  rememberPollingPlace,
} from './map-location.service';
import { lookupPlace, MapLookupError } from './serpapi.service';

/**
 * Coordenadas do Time DEMO.
 *
 * Nenhuma coordenada e escrita a mao e nenhuma e calculada. Cada ponto sai do
 * MESMO caminho que poe um integrante real no mapa: a consulta do endereco
 * pelo geocodificador do proprio sistema, guardada no cache de
 * `cmd_map_locations` pela consulta normalizada.
 *
 * Era exatamente isto que faltava. Antes, as coordenadas do Time DEMO eram
 * ancoras que eu havia digitado de memoria, mais um deslocamento aleatorio —
 * e o resultado foi um mapa em Recife, com pinos no mar. O deslocamento
 * deixou de existir e as ancoras tambem.
 *
 * O CACHE E O MESMO DO SISTEMA, e isso e de proposito: a chave e o hash da
 * consulta, nao do time. Como o catalogo tem poucos enderecos reais, o
 * primeiro Time DEMO resolve cada um uma vez e todos os seguintes aproveitam
 * a linha ja gravada — sem nova consulta e sem nova cobranca. Se um
 * integrante real de Maceio morar na mesma rua, ele aproveita o mesmo ponto,
 * como ja acontece entre dois integrantes reais da mesma rua.
 *
 * TRES BARREIRAS antes de um ponto ser aceito:
 *   1. o proprio provedor so devolve resultado cujo endereco bate com o
 *      municipio e a UF pedidos (`parsePlace`);
 *   2. `isUsableDemoCoordinate` recusa nula, NaN, `0,0` e qualquer ponto fora
 *      de Alagoas;
 *   3. o que nao passa NAO vira ponto: o vinculo fica sem coordenada e a tela
 *      mostra o integrante como pendente, em vez de o mapa mentir um lugar.
 */

/** Ponto aceito, ja gravado no cache de coordenadas. */
export interface DemoPoint {
  /** Linha de `cmd_map_locations`. */
  locationId: string;
  hash: string;
  latitude: number;
  longitude: number;
  /** Esta execucao criou a linha? So o que ela criou pode ser desfeito. */
  created: boolean;
}

/**
 * Resultado da busca de um endereco do catalogo.
 *
 * Sem ponto, o motivo importa: `error` preenchido e falha de consulta (sem
 * chave, provedor fora do ar, tempo esgotado) e vira vinculo FAILED; `error`
 * nulo e ausencia de resultado confiavel, e vira NOT_FOUND. As duas coisas
 * sao verdadeiras e visiveis — e nenhuma delas inventa coordenada.
 */
export interface DemoPointOutcome {
  query: string;
  hash: string;
  point: DemoPoint | null;
  error: MapErrorCode | null;
}

/**
 * Consulta do local de votacao: nome do local + endereco publicado.
 *
 * O nome basta quando a divulgacao nao trouxe rua — e assim que a propria
 * Justica Eleitoral identifica o local, e e o mesmo caminho que o sistema usa
 * para o domicilio eleitoral de um integrante real.
 */
export function pollingPlaceLookup(place: DemoPollingPlace): string | null {
  const logradouro =
    place.street && place.number ? `${place.street}, ${place.number}` : place.street;

  return buildQuery({
    place: place.name,
    street: logradouro,
    district: place.district,
    city: place.city,
    state: place.state,
  });
}

/**
 * Consulta da moradia: rua, bairro, municipio e UF. Nunca o numero.
 *
 * A precisao vem junto e diz ate onde o endereco chega — rua, bairro ou
 * municipio. E ela que o balao do mapa mostra, para a tela nunca sugerir a
 * casa exata de ninguem.
 */
export function residenceLookupFor(
  residence: DemoResidence,
): { query: string; precision: LocationPrecision } | null {
  return residenceLookup(residence);
}

async function cachedPoint(hash: string): Promise<MapLocationRow | null> {
  return selectOne<MapLocationRow>(TABLES.mapLocations, {
    select: '*',
    filters: { query_hash: `eq.${hash}` },
  });
}

/**
 * Grava o ponto encontrado.
 *
 * `provider` diz a verdade: a coordenada veio da consulta paga, e nao de uma
 * lista semeada. Em corrida entre duas execucoes, a unicidade do banco decide
 * e a linha da outra serve.
 */
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

  return row ?? (await cachedPoint(hash));
}

function accepted(row: MapLocationRow, created: boolean): DemoPoint | null {
  if (!isUsableDemoCoordinate(row.latitude, row.longitude)) return null;
  return {
    locationId: row.id,
    hash: row.query_hash,
    latitude: row.latitude,
    longitude: row.longitude,
    created,
  };
}

/**
 * Resolve um endereco do catalogo: cache primeiro, provedor so no que for
 * inedito.
 */
export async function resolveDemoPoint(
  query: string,
  expected: AddressParts,
): Promise<DemoPointOutcome> {
  const hash = queryHash(query);

  const hit = await cachedPoint(hash);
  if (hit) return { query, hash, point: accepted(hit, false), error: null };

  let found: MapPlace | null;
  try {
    found = await lookupPlace(query, expected);
  } catch (error) {
    // Sem chave, provedor fora do ar ou tempo esgotado: o Time DEMO nasce
    // sem aquele ponto, e nao com um ponto errado. A rotina de correcao
    // (`refreshDemoTeam`) tenta de novo depois.
    return {
      query,
      hash,
      point: null,
      error: error instanceof MapLookupError ? error.code : 'UNEXPECTED',
    };
  }

  if (!found) return { query, hash, point: null, error: null };

  // Endereco de Alagoas que resolveu para fora de Alagoas e resultado errado:
  // ele nao entra no cache, para nao estragar tambem a consulta de um time
  // real que um dia pergunte o mesmo endereco.
  if (!isUsableDemoCoordinate(found.latitude, found.longitude)) {
    return { query, hash, point: null, error: null };
  }

  const saved = await remember(hash, found);
  if (!saved) return { query, hash, point: null, error: 'UNEXPECTED' };

  return { query, hash, point: accepted(saved, true), error: null };
}

/**
 * Pinos das escolas da tabela oficial do TSE, todos de uma vez.
 *
 * NADA E CONSULTADO: a coordenada e copiada da tabela, pelo MESMO formato que
 * o caminho real grava quando um integrante de verdade vota naquela escola
 * (`pollingPlaceCacheRow`, mesma chave, mesmo titulo, mesmo endereco). Por
 * isso a linha e compartilhada: se um time real ja tem gente naquela escola,
 * o Time DEMO aponta para a linha que ja existe, e nada e reescrito.
 *
 * Em LOTE, e nao escola por escola: trezentas escolas uma a uma seriam
 * seiscentas idas ao banco, e a criacao gastaria nisso todo o tempo que tem.
 * Uma leitura do que ja existe, uma escrita do que falta e uma releitura.
 *
 * Estas linhas NUNCA entram na lista do desfazer da criacao: sao dado
 * publico, iguais para todos os times, e uma escola que um time real use nao
 * pode sumir porque uma demonstracao falhou.
 *
 * Devolve o ponto de cada escola pelo id da linha oficial. Escola fora de
 * Alagoas ou sem coordenada nao entra — nao vira pino.
 */
export async function rememberOfficialPlaces(
  rows: readonly PollingPlaceRow[],
): Promise<Map<string, DemoPoint>> {
  const comPonto = rows.filter((row) => isUsableDemoCoordinate(row.latitude, row.longitude));
  const resultado = new Map<string, DemoPoint>();
  if (comPonto.length === 0) return resultado;

  const porHash = new Map(comPonto.map((row) => [pollingPlaceHash(row.id), row] as const));
  const hashes = [...porHash.keys()];

  const ler = () =>
    selectRows<MapLocationRow>(TABLES.mapLocations, {
      select: '*',
      filters: { query_hash: inFilter(hashes) },
    });

  let existentes = await ler();
  const ja = new Set(existentes.map((row) => row.query_hash));
  const faltam = comPonto.filter((row) => !ja.has(pollingPlaceHash(row.id)));

  if (faltam.length > 0) {
    try {
      await insertRowsInChunks(TABLES.mapLocations, faltam.map(pollingPlaceCacheRow), 'id');
    } catch {
      // Corrida com outra execucao (a unicidade da chave recusou o lote):
      // escola por escola, pelo caminho real, que sabe aproveitar a linha
      // que a outra gravou.
      for (const row of faltam) await rememberPollingPlace(row).catch(() => null);
    }
    existentes = await ler();
  }

  for (const linha of existentes) {
    const oficial = porHash.get(linha.query_hash);
    const ponto = oficial ? accepted(linha, false) : null;
    if (oficial && ponto) resultado.set(oficial.id, ponto);
  }

  return resultado;
}
