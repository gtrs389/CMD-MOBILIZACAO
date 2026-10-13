import {
  DEMO_ADDRESSES,
  DEMO_STATE,
  isUsableDemoCoordinate,
  type DemoAddress,
  type DemoPollingPlace,
} from './demo-catalog';
import { createRandom } from './demo';

/**
 * Escolas do Time DEMO a partir da TABELA OFICIAL do TSE.
 *
 * O catalogo conferido (`demo-catalog.ts`) tem trinta e poucas escolas, e foi
 * o que o Time DEMO teve enquanto a tabela do TSE nao existia. Desde a
 * migration 042 o banco tem `cmd_polling_places`: TODOS os locais de votacao
 * de Alagoas, com nome, endereco, zona, secoes e a coordenada oficial de cada
 * um. Com ela, a demonstracao deixa de ser um punhado de escolas e passa a
 * ter a cara de uma operacao estadual: centenas de escolas reais, em dezenas
 * de municipios, sem uma consulta paga sequer.
 *
 * Modulo PURO, como `demo.ts`: recebe as linhas ja lidas e uma semente, e
 * devolve sempre a mesma escolha. Nada aqui inventa lugar — tudo o que sai e
 * uma linha da tabela, com os numeros que a Justica Eleitoral publicou.
 */

/** O minimo de uma linha de `cmd_polling_places` que o Time DEMO usa. */
export interface OfficialPlace {
  id: string;
  city: string;
  zone: number;
  name: string;
  address: string | null;
  district: string | null;
  latitude: number | null;
  longitude: number | null;
  sections: number[];
}

/** De onde vieram as escolas de um Time DEMO. */
export type DemoSchoolSource = 'TSE' | 'CATALOGO';

/**
 * Abaixo disto a tabela e tratada como nao carregada.
 *
 * Um banco com meia duzia de linhas de teste nao e "a tabela do TSE": o Time
 * DEMO cairia nelas e ficaria menor do que com o catalogo conferido.
 */
export const MIN_OFFICIAL_PLACES = 40;

/** Rotulo da fonte, anotado em cada local escolhido. */
export const TSE_SOURCE = 'TSE — locais de votação (cmd_polling_places)';

/* -------------------------------------------------------------------------
   Texto
   ------------------------------------------------------------------------- */

/** Palavras que ficam minusculas no meio de um nome. */
const PARTICULAS = new Set(['a', 'as', 'o', 'os', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'na', 'no']);

/** Siglas que continuam em caixa alta. */
const SIGLAS = new Set(['AL', 'BR', 'PE', 'SE', 'BA', 'CEP', 'CAIC', 'COHAB', 'SESI', 'SENAI', 'UFAL', 'IFAL']);

/** Numero romano curto: "II", "IV", "XV". */
const ROMANO = /^[IVXL]{1,4}$/;

/**
 * Caixa de titulo em portugues: "RUA DR. JOSE DE ALENCAR" vira
 * "Rua Dr. Jose de Alencar".
 *
 * A planilha do TSE vem toda em maiusculas. Rua e bairro vao para a ficha da
 * pessoa e para o balao do mapa, lado a lado com cadastros digitados a mao —
 * em caixa alta, a demonstracao gritaria. O nome da ESCOLA nao passa por
 * aqui: ele vai para o cache de coordenadas compartilhado com os times reais,
 * e la fica exatamente como o caminho real o grava.
 */
export function tituloPt(text: string | null | undefined): string | null {
  const limpo = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;

  return limpo
    .split(' ')
    .map((palavra, index) => {
      const maiuscula = palavra.toUpperCase();
      const nua = maiuscula.replace(/[^A-Z0-9ÁÉÍÓÚÂÊÔÃÕÇÀÜ]/g, '');

      if (SIGLAS.has(nua) || ROMANO.test(nua) || /\d/.test(palavra)) return maiuscula;
      // Abreviacao com ponto entre letras: "E.E.", "U.M.E.".
      if (/^([A-ZÁÉÍÓÚÂÊÔÃÕÇ]\.){2,}$/i.test(palavra)) return maiuscula;

      const minuscula = palavra.toLocaleLowerCase('pt-BR');
      if (index > 0 && PARTICULAS.has(minuscula)) return minuscula;
      return minuscula.charAt(0).toLocaleUpperCase('pt-BR') + minuscula.slice(1);
    })
    .join(' ');
}

/** Endereco rural: "POVOADO X", "SITIO Y". Nao e rua, e nao vira rua. */
const RURAL = /^(POVOADO|POV\.|SITIO|SÍTIO|FAZENDA|FAZ\.|ZONA RURAL|ASSENTAMENTO|ALDEIA|COMUNIDADE)\b/i;

/** Palavras que, antes de um numero, fazem dele parte do nome da via. */
const NUMERO_DO_NOME = /\b(AL|BR|KM|QUADRA|QD\.?|LOTE|LT\.?|ETAPA|CONJUNTO|CJ\.?|RODOVIA|ROD\.?)$/i;

/**
 * Separa a rua do numero, como o TSE os publica.
 *
 * A planilha traz o endereco em um campo so, em formatos variados:
 * "RUA BARAO DE AGUA BRANCA - NUMERO 50", "AV. FERNANDES LIMA, 123",
 * "RUA X, S/N", "RODOVIA AL-101 NORTE, KM 5". A rua e o que vem antes da
 * primeira virgula ou do primeiro " - "; o numero, quando ha, e o que a
 * marca de numero aponta. Endereco rural (povoado, sitio) nao tem rua: ele
 * vale como localidade, e quem decide isso e quem chama.
 */
export function splitTseAddress(address: string | null | undefined): {
  street: string | null;
  number: string | null;
  rural: boolean;
} {
  const limpo = (address ?? '').replace(/\s+/g, ' ').trim();
  if (!limpo) return { street: null, number: null, rural: false };

  const rural = RURAL.test(limpo);

  // Numero: "NUMERO 50", "Nº 50", ", 50", " - 50". "S/N" nao e numero.
  const marcado =
    /\b(?:N[ÚU]MERO|N[º°O]\.?|N\.)\s*(\d+[A-Z]?)\b/i.exec(limpo) ??
    /(?:,|\s-\s)\s*(\d+[A-Z]?)\s*(?:$|,|\s-\s)/i.exec(limpo);
  const number = marcado ? marcado[1] : null;

  let street = limpo.split(/\s*,\s*|\s+-\s+/)[0]?.trim() ?? '';
  // Numero colado no fim da rua ("RUA X 123"), quando nao faz parte do nome
  // da via ("RODOVIA AL 101", "QUADRA 5").
  // "RUA 7" e o nome da rua, e fica inteiro: so sai o numero de quem ainda
  // tem nome depois de perde-lo.
  const colado = /^(.*?)\s+(?:\b(?:N[ÚU]MERO|N[º°O]\.?|N\.))?\s*\d+[A-Z]?$/i.exec(street);
  const resto = colado?.[1]?.trim() ?? '';
  if (resto.split(' ').length >= 2 && !NUMERO_DO_NOME.test(resto)) street = resto;
  street = street.replace(/\s+(?:S\/N|S\.N\.?|SN)$/i, '').trim();

  return { street: street || null, number, rural };
}

/* -------------------------------------------------------------------------
   Conversao
   ------------------------------------------------------------------------- */

/**
 * A linha serve ao Time DEMO?
 *
 * Tres exigencias, e nenhuma e estetica. COORDENADA dentro de Alagoas — a
 * escola vira pino, e o pino nao pode cair no mar. SECOES publicadas — e por
 * elas que a pessoa ganha zona e secao, e e por elas que o mapa e a Sala de
 * Apuracao quebram os votos. NOME — sem ele o pino nao diz o que e.
 */
export function isUsableOfficialPlace(row: OfficialPlace): boolean {
  return (
    Boolean(row.id) &&
    Boolean(row.name?.trim()) &&
    Boolean(row.city?.trim()) &&
    Number.isInteger(row.zone) &&
    row.zone > 0 &&
    Array.isArray(row.sections) &&
    row.sections.some((section) => Number.isInteger(section) && section > 0) &&
    isUsableDemoCoordinate(row.latitude, row.longitude)
  );
}

/** Uma linha da tabela, no formato do catalogo do Time DEMO. */
export function officialToDemoPlace(row: OfficialPlace): DemoPollingPlace {
  const { street, number, rural } = splitTseAddress(row.address);
  const localidade = rural ? tituloPt(row.address) : null;

  return {
    id: `tse-${row.id}`,
    // Como a Justica Eleitoral publicou. E o mesmo texto que o caminho real
    // grava no cache de coordenadas, e o que o pino mostra.
    name: row.name.trim(),
    street: rural ? null : tituloPt(street),
    number: rural ? null : number,
    district: tituloPt(row.district) ?? localidade,
    city: tituloPt(row.city) ?? row.city,
    state: DEMO_STATE,
    zone: String(row.zone),
    sections: [...new Set(row.sections.filter((section) => Number.isInteger(section) && section > 0))]
      .sort((a, b) => a - b)
      .map(String),
    source: TSE_SOURCE,
    officialId: row.id,
  };
}

/* -------------------------------------------------------------------------
   Escolha das escolas
   ------------------------------------------------------------------------- */

/** Sorteio com peso, sem reposicao. A mesma semente, a mesma escolha. */
function weightedSample<T>(
  random: () => number,
  items: readonly T[],
  weight: (item: T) => number,
  count: number,
): T[] {
  const restantes = [...items];
  const escolhidos: T[] = [];

  while (escolhidos.length < count && restantes.length > 0) {
    const pesos = restantes.map((item) => Math.max(0.0001, weight(item)));
    const soma = pesos.reduce((total, peso) => total + peso, 0);
    let alvo = random() * soma;
    let indice = 0;
    for (; indice < pesos.length - 1; indice += 1) {
      alvo -= pesos[indice];
      if (alvo <= 0) break;
    }
    escolhidos.push(restantes[indice]);
    restantes.splice(indice, 1);
  }

  return escolhidos;
}

/**
 * Quantos municipios uma operacao de N escolas alcanca.
 *
 * Cresce mais devagar do que as escolas: uma operacao de verdade se adensa
 * onde ja esta antes de abrir cidade nova. Doze escolas em oito municipios,
 * sessenta em dezessete, trezentas em trinta e oito.
 */
export function citiesForSchools(schools: number): number {
  if (schools <= 0) return 0;
  return Math.max(1, Math.min(schools, Math.round(2.2 * Math.sqrt(schools))));
}

/**
 * Escolhe as escolas do Time DEMO entre as linhas oficiais.
 *
 * Como uma operacao estadual de verdade se distribui:
 *
 *   1. MUNICIPIOS. Os dois maiores eleitorados (Maceio e Arapiraca) entram
 *      sempre — nenhuma campanha em Alagoas os deixa de fora. Os demais sao
 *      sorteados com peso pelo eleitorado (soma das secoes): cidade grande
 *      entra mais vezes, mas o sertao e o litoral tambem aparecem.
 *   2. ESCOLAS POR MUNICIPIO. Em proporcao ao eleitorado, amaciada (raiz de
 *      0,7), para a capital nao engolir o mapa inteiro. Toda cidade escolhida
 *      tem ao menos uma escola, e nenhuma recebe mais do que tem.
 *   3. QUAIS ESCOLAS. Sorteadas com peso pelo numero de secoes: o colegio
 *      grande do centro aparece mais do que a escolinha rural — mas a
 *      escolinha rural tambem aparece.
 *
 * Determinístico: a mesma semente e as mesmas linhas devolvem a mesma lista,
 * e e isso que faz "Refazer dados" reproduzir o time que o ADMIN ja conhece.
 * As linhas sao ordenadas antes de tudo, porque o banco nao promete ordem.
 */
export function pickOfficialPlaces(
  rows: readonly OfficialPlace[],
  count: number,
  seed: string,
): DemoPollingPlace[] {
  const unicas = new Map<string, OfficialPlace>();
  for (const row of rows) if (isUsableOfficialPlace(row)) unicas.set(row.id, row);

  const usaveis = [...unicas.values()].sort(
    (a, b) =>
      a.city.localeCompare(b.city) ||
      a.zone - b.zone ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

  const total = Math.min(Math.max(0, Math.trunc(count) || 0), usaveis.length);
  if (total === 0) return [];

  const random = createRandom(`${seed}:escolas-tse`);

  // Municipios, com o eleitorado de cada um (soma das secoes).
  const porCidade = new Map<string, OfficialPlace[]>();
  for (const row of usaveis) {
    const lista = porCidade.get(row.city) ?? [];
    lista.push(row);
    porCidade.set(row.city, lista);
  }
  const eleitorado = (city: string) =>
    (porCidade.get(city) ?? []).reduce((soma, row) => soma + row.sections.length, 0);

  const ranking = [...porCidade.keys()].sort(
    (a, b) => eleitorado(b) - eleitorado(a) || a.localeCompare(b),
  );

  const quantasCidades = Math.min(ranking.length, citiesForSchools(total));
  const fixas = ranking.slice(0, Math.min(2, quantasCidades));
  const sorteadas = weightedSample(
    random,
    ranking.slice(fixas.length),
    eleitorado,
    quantasCidades - fixas.length,
  );
  const cidades = [...fixas, ...sorteadas].sort(
    (a, b) => eleitorado(b) - eleitorado(a) || a.localeCompare(b),
  );

  // Escolas por municipio: piso de um, teto do que a cidade tem, e o resto
  // em proporcao ao eleitorado amaciado.
  const cota = new Map<string, number>(cidades.map((city) => [city, 1]));
  const alvo = new Map<string, number>();
  const somaSuave = cidades.reduce((soma, city) => soma + eleitorado(city) ** 0.7, 0);
  for (const city of cidades) alvo.set(city, (total * eleitorado(city) ** 0.7) / somaSuave);

  let faltam = total - cidades.length;
  const fila = [...ranking.filter((city) => !cota.has(city))];
  while (faltam > 0) {
    const comEspaco = [...cota.keys()].filter(
      (city) => (cota.get(city) ?? 0) < (porCidade.get(city)?.length ?? 0),
    );

    if (comEspaco.length === 0) {
      // As cidades escolhidas esgotaram: abre a proxima do ranking. So
      // acontece pedindo quase todas as escolas do estado.
      const proxima = fila.shift();
      if (!proxima) break;
      cota.set(proxima, 1);
      alvo.set(proxima, 1);
      cidades.push(proxima);
      faltam -= 1;
      continue;
    }

    const vez = comEspaco.reduce((melhor, city) =>
      (alvo.get(city) ?? 0) - (cota.get(city) ?? 0) >
      (alvo.get(melhor) ?? 0) - (cota.get(melhor) ?? 0)
        ? city
        : melhor,
    );
    cota.set(vez, (cota.get(vez) ?? 0) + 1);
    faltam -= 1;
  }

  const escolhidas: DemoPollingPlace[] = [];
  for (const city of cidades) {
    const daCidade = weightedSample(
      random,
      porCidade.get(city) ?? [],
      (row) => row.sections.length,
      cota.get(city) ?? 0,
    ).sort((a, b) => b.sections.length - a.sections.length || a.name.localeCompare(b.name));

    escolhidas.push(...daCidade.map(officialToDemoPlace));
  }

  return escolhidas;
}

/* -------------------------------------------------------------------------
   Moradias
   ------------------------------------------------------------------------- */

/** Ruas de moradia por municipio, no maximo. */
export const RESIDENCE_STREETS_PER_CITY = 4;

/**
 * Enderecos de moradia para as escolas escolhidas.
 *
 * As pessoas moram PERTO de onde votam, como na vida real: a moradia sai das
 * ruas das proprias escolas do municipio — logradouros publicados pelo TSE,
 * sem numero, porque o mapa mostra a rua e nunca a casa.
 *
 * As ruas do catalogo conferido vem PRIMEIRO, quando o municipio as tem: ja
 * foram resolvidas por um Time DEMO anterior e estao no cache, entao custam
 * zero. O teto por municipio existe pelo custo: cada rua inedita e uma
 * consulta paga, uma unica vez no sistema todo — e quatro ruas por cidade ja
 * espalham os pinos da camada "Pessoas" sem virar conta.
 */
export function residenceAddressesFor(
  places: readonly DemoPollingPlace[],
  curated: readonly DemoAddress[] = DEMO_ADDRESSES,
  perCity = RESIDENCE_STREETS_PER_CITY,
): DemoAddress[] {
  const cidades = [...new Set(places.map((place) => place.city))];
  const enderecos: DemoAddress[] = [];

  for (const city of cidades) {
    const vistos = new Set<string>();
    const daCidade: DemoAddress[] = [];

    const candidatos: DemoAddress[] = [
      ...curated.filter((address) => address.city === city),
      ...places
        .filter((place): place is DemoPollingPlace & { street: string } =>
          place.city === city && Boolean(place.street),
        )
        .map((place) => ({
          id: `end-${place.id}`,
          street: place.street,
          district: place.district,
          city: place.city,
          state: place.state,
          source: place.source,
        })),
    ];

    for (const candidato of candidatos) {
      if (daCidade.length >= perCity) break;
      const chave = `${candidato.street.toLowerCase()}|${(candidato.district ?? '').toLowerCase()}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      daCidade.push(candidato);
    }

    enderecos.push(...daCidade);
  }

  return enderecos;
}
