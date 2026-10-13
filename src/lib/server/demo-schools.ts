import 'server-only';
import {
  DEMO_ADDRESSES,
  DEMO_CITIES,
  DEMO_POLLING_PLACES,
  DEMO_SEED_VERSION,
  DEMO_STATE,
  type DemoAddress,
  type DemoPollingPlace,
} from '@/lib/domain/demo-catalog';
import {
  MIN_OFFICIAL_PLACES,
  isUsableOfficialPlace,
  officialToDemoPlace,
  pickOfficialPlaces,
  residenceAddressesFor,
  type DemoSchoolSource,
  type OfficialPlace,
} from '@/lib/domain/demo-tse';
import { TABLES, type MemberRow, type PollingPlaceRow } from '@/lib/supabase/tables';
import { selectRows } from '@/lib/supabase/rest';
import { pollingPlacesOfZones } from './polling-place.service';

/**
 * De onde saem as escolas de um Time DEMO.
 *
 * PRIMEIRO a tabela oficial do TSE (`cmd_polling_places`, migration 042):
 * todas as escolas de Alagoas, com zona, secoes e coordenada oficial. E a
 * mesma tabela que poe a escola de um integrante real no mapa — e so LEITURA:
 * o Time DEMO nao grava, nao altera e nao apaga nenhuma linha dela.
 *
 * Sem a tabela carregada (banco novo, migration ainda nao rodada, carga de
 * outro estado), vale o catalogo conferido de sempre. O Time DEMO nunca
 * deixa de nascer por causa disto.
 */

/** As escolas de um Time DEMO, e o que vem com elas. */
export interface DemoSchools {
  source: DemoSchoolSource;
  /** Locais de votacao, na ordem de escolha. */
  places: readonly DemoPollingPlace[];
  /** Enderecos de moradia possiveis, sempre nos municipios das escolas. */
  addresses: readonly DemoAddress[];
  /**
   * Linhas oficiais por `officialId`. E delas que sai a coordenada da
   * escola: copiada da tabela, sem consulta paga.
   */
  official: ReadonlyMap<string, PollingPlaceRow>;
}

const COLUNAS = 'id,uf,city_code,city,zone,name,address,district,latitude,longitude,sections';

/** O catalogo conferido, como fonte. */
function fromCatalog(): DemoSchools {
  return {
    source: 'CATALOGO',
    places: DEMO_POLLING_PLACES,
    addresses: DEMO_ADDRESSES,
    official: new Map(),
  };
}

/**
 * Todas as escolas de Alagoas que servem ao Time DEMO.
 *
 * So as que tem coordenada: e a primeira coisa que o filtro do banco corta,
 * para a leitura nao trazer o que nunca viraria pino. Falha de leitura —
 * tabela inexistente, banco fora do ar — vira lista vazia, e quem chama cai
 * no catalogo conferido.
 */
async function officialRows(): Promise<PollingPlaceRow[]> {
  const rows = await selectRows<PollingPlaceRow>(TABLES.pollingPlaces, {
    select: COLUNAS,
    filters: { uf: `eq.${DEMO_STATE}`, latitude: 'not.is.null', longitude: 'not.is.null' },
    order: 'id.asc',
  }).catch(() => [] as PollingPlaceRow[]);

  return rows.filter((row) => isUsableOfficialPlace(row as OfficialPlace));
}

/**
 * As escolas de um Time DEMO novo (ou refeito): sorteadas da tabela oficial
 * pela semente do time.
 */
export async function demoSchoolsFor(count: number, seed: string): Promise<DemoSchools> {
  const rows = await officialRows();
  if (rows.length < MIN_OFFICIAL_PLACES) return fromCatalog();

  const places = pickOfficialPlaces(rows, count, seed);
  if (places.length === 0) return fromCatalog();

  const escolhidas = new Set(places.map((place) => place.officialId));
  return {
    source: 'TSE',
    places,
    addresses: residenceAddressesFor(places),
    official: new Map(
      rows.filter((row) => escolhidas.has(row.id)).map((row) => [row.id, row] as const),
    ),
  };
}

/**
 * As escolas em que o Time DEMO JA vota, lidas das proprias pessoas dele.
 *
 * Serve a segunda camada: quem a equipe traz vota nas MESMAS escolas do
 * time, e nao em um sorteio novo — senao o mapa ganharia escolas que o time
 * nunca teve. A escola de cada pessoa e achada como no caminho real: UF +
 * zona + secao.
 *
 * Time criado antes da tabela oficial (zona e secao do catalogo, quase
 * sempre vazias) continua no catalogo conferido.
 */
export async function demoSchoolsOfTeam(clientId: string): Promise<DemoSchools> {
  const pessoas = await selectRows<Pick<MemberRow, 'zone' | 'section'>>(TABLES.members, {
    select: 'zone,section',
    filters: { client_id: `eq.${clientId}`, demo_seed: `eq.${DEMO_SEED_VERSION}` },
  }).catch(() => [] as Pick<MemberRow, 'zone' | 'section'>[]);

  const chave = (zone: string | number | null, section: string | number | null) =>
    `${Number.parseInt(String(zone ?? ''), 10)}:${Number.parseInt(String(section ?? ''), 10)}`;
  const comSecao = pessoas.filter((pessoa) => pessoa.zone?.trim() && pessoa.section?.trim());
  if (comSecao.length === 0) return fromCatalog();

  const locais = await pollingPlacesOfZones(
    DEMO_STATE,
    comSecao.map((pessoa) => pessoa.zone),
  );

  const secoes = new Set(comSecao.map((pessoa) => chave(pessoa.zone, pessoa.section)));
  const doTime = locais
    .filter((row) => isUsableOfficialPlace(row as OfficialPlace))
    .filter((row) => row.sections.some((secao) => secoes.has(chave(row.zone, secao))))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (doTime.length === 0) return fromCatalog();

  // O time nasceu da tabela oficial? Quase todo mundo dele tem de votar em
  // uma escola dela. Um time ANTIGO, do catalogo conferido, casa uma ou duas
  // secoes por coincidencia — e a segunda camada inteira iria parar ali.
  const achadas = new Set(doTime.flatMap((row) => row.sections.map((secao) => chave(row.zone, secao))));
  const naTabela = pessoas.filter((pessoa) => achadas.has(chave(pessoa.zone, pessoa.section))).length;
  if (naTabela < pessoas.length * 0.9) return fromCatalog();

  const places = doTime.map((row) => officialToDemoPlace(row as OfficialPlace));
  return {
    source: 'TSE',
    places,
    addresses: residenceAddressesFor(places),
    official: new Map(doTime.map((row) => [row.id, row] as const)),
  };
}

/** O que a tela de criacao mostra: de onde vem e quanto ha. */
export interface DemoCatalogSummary {
  source: DemoSchoolSource;
  schools: number;
  cities: number;
}

export async function demoCatalogSummary(): Promise<DemoCatalogSummary> {
  const rows = await officialRows();
  if (rows.length < MIN_OFFICIAL_PLACES) {
    return { source: 'CATALOGO', schools: DEMO_POLLING_PLACES.length, cities: DEMO_CITIES.length };
  }
  return {
    source: 'TSE',
    schools: rows.length,
    cities: new Set(rows.map((row) => row.city)).size,
  };
}
