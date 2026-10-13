import { describe, expect, it } from 'vitest';
import { buildDemoData } from '@/lib/domain/demo';
import { DEMO_ADDRESSES, isInAlagoas } from '@/lib/domain/demo-catalog';
import {
  MIN_OFFICIAL_PLACES,
  RESIDENCE_STREETS_PER_CITY,
  citiesForSchools,
  isUsableOfficialPlace,
  officialToDemoPlace,
  pickOfficialPlaces,
  residenceAddressesFor,
  splitTseAddress,
  tituloPt,
  type OfficialPlace,
} from '@/lib/domain/demo-tse';

/**
 * Escolas do Time DEMO a partir da tabela oficial do TSE.
 *
 * O Time DEMO tinha trinta e poucas escolas — o catalogo conferido a mao. Com
 * a tabela do TSE no banco, ele passa a sortear entre centenas. O que se
 * prova aqui e que o sorteio continua com cara de operacao de verdade: a
 * quantidade pedida, varios municipios com a capital sempre presente, nada
 * fora de Alagoas, e cada pessoa com zona e secao que existem naquela escola.
 */

/** Municipios ficticios para o teste, com o "tamanho" de cada um. */
const CIDADES = [
  { city: 'MACEIÓ', escolas: 120, secoes: 18, lat: -9.66, lng: -35.73 },
  { city: 'ARAPIRACA', escolas: 40, secoes: 14, lat: -9.75, lng: -36.66 },
  { city: 'RIO LARGO', escolas: 15, secoes: 8, lat: -9.48, lng: -35.85 },
  { city: 'PALMEIRA DOS ÍNDIOS', escolas: 15, secoes: 7, lat: -9.41, lng: -36.63 },
  { city: 'PENEDO', escolas: 12, secoes: 6, lat: -10.29, lng: -36.58 },
  { city: 'SANTANA DO IPANEMA', escolas: 10, secoes: 5, lat: -9.37, lng: -37.24 },
  { city: 'DELMIRO GOUVEIA', escolas: 10, secoes: 5, lat: -9.39, lng: -37.99 },
  { city: 'MARAGOGI', escolas: 6, secoes: 3, lat: -9.01, lng: -35.22 },
  { city: 'PARICONHA', escolas: 3, secoes: 2, lat: -9.25, lng: -37.99 },
  { city: 'MAR VERMELHO', escolas: 1, secoes: 1, lat: -9.45, lng: -36.38 },
] as const;

function linhas(): OfficialPlace[] {
  const rows: OfficialPlace[] = [];
  let secao = 1;
  CIDADES.forEach((cidade, c) => {
    for (let i = 0; i < cidade.escolas; i += 1) {
      const quantas = 1 + ((i * 7) % cidade.secoes);
      rows.push({
        id: `00000000-0000-4000-8000-${String(c * 1000 + i).padStart(12, '0')}`,
        city: cidade.city,
        zone: 10 + c,
        name: `ESCOLA ESTADUAL ${cidade.city} ${i + 1}`,
        address: i % 5 === 0 ? `POVOADO SÍTIO ${i}` : `RUA DOUTOR FULANO ${c}-${i % 4} - NUMERO ${i + 10}`,
        district: i % 3 === 0 ? 'CENTRO' : 'CONJ. JOSÉ TENÓRIO',
        latitude: cidade.lat + (i % 10) * 0.001,
        longitude: cidade.lng + (i % 10) * 0.001,
        sections: Array.from({ length: quantas }, () => secao++),
      });
    }
  });
  return rows;
}

const TODAS = linhas();

describe('endereço publicado pelo TSE', () => {
  it('separa a rua do número nos formatos da planilha', () => {
    expect(splitTseAddress('RUA BARAO DE AGUA BRANCA - NUMERO 50')).toEqual({
      street: 'RUA BARAO DE AGUA BRANCA',
      number: '50',
      rural: false,
    });
    expect(splitTseAddress('AV. FERNANDES LIMA, 123')).toMatchObject({
      street: 'AV. FERNANDES LIMA',
      number: '123',
    });
    expect(splitTseAddress('RUA SÃO JOSÉ, S/N')).toMatchObject({ street: 'RUA SÃO JOSÉ', number: null });
    expect(splitTseAddress('RUA JOSÉ AFONSO Nº 15')).toMatchObject({ street: 'RUA JOSÉ AFONSO', number: '15' });
  });

  it('não confunde o número do nome da via com o da casa', () => {
    // "AL 101" e "RUA 7" são nomes, e não endereço com número.
    expect(splitTseAddress('RODOVIA AL 101').street).toBe('RODOVIA AL 101');
    expect(splitTseAddress('RODOVIA AL-101 NORTE, KM 5').street).toBe('RODOVIA AL-101 NORTE');
    expect(splitTseAddress('RUA 7').street).toBe('RUA 7');
  });

  it('trata povoado e sítio como localidade, e não como rua', () => {
    expect(splitTseAddress('POVOADO CANAFÍSTULA').rural).toBe(true);
    const local = officialToDemoPlace({ ...TODAS[0], address: 'POVOADO CANAFÍSTULA', district: null });
    expect(local.street).toBeNull();
    expect(local.district).toBe('Povoado Canafístula');
  });

  it('vazio é vazio', () => {
    expect(splitTseAddress(null)).toEqual({ street: null, number: null, rural: false });
    expect(splitTseAddress('   ')).toEqual({ street: null, number: null, rural: false });
  });

  it('põe rua e bairro em caixa de título, sem estragar sigla nem partícula', () => {
    expect(tituloPt('RUA DR. JOSÉ DE ALENCAR')).toBe('Rua Dr. José de Alencar');
    expect(tituloPt('CONJ. JOSÉ TENÓRIO')).toBe('Conj. José Tenório');
    expect(tituloPt('RODOVIA AL-101 NORTE')).toBe('Rodovia AL-101 Norte');
    expect(tituloPt('BENEDITO BENTES II')).toBe('Benedito Bentes II');
    expect(tituloPt('PALMEIRA DOS ÍNDIOS')).toBe('Palmeira dos Índios');
    expect(tituloPt('')).toBeNull();
  });
});

describe('linha da tabela oficial', () => {
  it('só serve com coordenada em Alagoas, seções e nome', () => {
    const base = TODAS[0];
    expect(isUsableOfficialPlace(base)).toBe(true);
    // Recife: o erro que já pôs pino no mar uma vez.
    expect(isUsableOfficialPlace({ ...base, latitude: -8.0476, longitude: -34.877 })).toBe(false);
    expect(isUsableOfficialPlace({ ...base, latitude: null })).toBe(false);
    expect(isUsableOfficialPlace({ ...base, latitude: 0, longitude: 0 })).toBe(false);
    expect(isUsableOfficialPlace({ ...base, sections: [] })).toBe(false);
    expect(isUsableOfficialPlace({ ...base, name: '  ' })).toBe(false);
  });

  it('vira local do Time DEMO com zona e seções da própria escola', () => {
    const row = { ...TODAS[3], sections: [42, 7, 7, 13] };
    const local = officialToDemoPlace(row);

    expect(local.officialId).toBe(row.id);
    expect(local.state).toBe('AL');
    expect(local.zone).toBe(String(row.zone));
    // Ordenadas e sem repetição: a seção é a unidade, e existe uma vez só.
    expect(local.sections).toEqual(['7', '13', '42']);
    // O nome da escola fica como o TSE publicou: é o texto do pino, igual ao
    // que o caminho real grava para um integrante de verdade.
    expect(local.name).toBe(row.name);
    expect(local.street).toBe('Rua Doutor Fulano 0-3');
    expect(local.number).toBe('13');
  });
});

describe('escolha das escolas', () => {
  it('entrega exatamente a quantidade pedida, sem repetir escola', () => {
    for (const quantas of [1, 12, 60, 150]) {
      const escolas = pickOfficialPlaces(TODAS, quantas, 'semente-1');
      expect(escolas).toHaveLength(quantas);
      expect(new Set(escolas.map((escola) => escola.officialId)).size).toBe(quantas);
    }
  });

  it('é determinística: a mesma semente devolve as mesmas escolas', () => {
    const a = pickOfficialPlaces(TODAS, 60, 'semente-1').map((escola) => escola.id);
    const b = pickOfficialPlaces([...TODAS].reverse(), 60, 'semente-1').map((escola) => escola.id);
    // A ordem em que o banco devolveu as linhas não muda nada.
    expect(b).toEqual(a);

    const c = pickOfficialPlaces(TODAS, 60, 'outra-semente').map((escola) => escola.id);
    expect(c).not.toEqual(a);
  });

  it('espalha por vários municípios, com a capital e Arapiraca sempre presentes', () => {
    const escolas = pickOfficialPlaces(TODAS, 60, 'semente-1');
    const cidades = new Set(escolas.map((escola) => escola.city));

    expect(cidades.size).toBe(Math.min(CIDADES.length, citiesForSchools(60)));
    expect(cidades.has('Maceió')).toBe(true);
    expect(cidades.has('Arapiraca')).toBe(true);
  });

  it('dá mais escolas a quem tem mais eleitorado, sem a capital engolir tudo', () => {
    const escolas = pickOfficialPlaces(TODAS, 60, 'semente-1');
    const porCidade = new Map<string, number>();
    for (const escola of escolas) porCidade.set(escola.city, (porCidade.get(escola.city) ?? 0) + 1);

    const maceio = porCidade.get('Maceió') ?? 0;
    expect(maceio).toBeGreaterThan(porCidade.get('Arapiraca') ?? 0);
    expect(maceio).toBeLessThan(60 * 0.75);
  });

  it('nunca passa do que existe, e pedir tudo devolve tudo', () => {
    const usaveis = TODAS.filter(isUsableOfficialPlace).length;
    expect(pickOfficialPlaces(TODAS, 10_000, 's')).toHaveLength(usaveis);
    expect(pickOfficialPlaces(TODAS, 0, 's')).toHaveLength(0);
    expect(pickOfficialPlaces([], 50, 's')).toHaveLength(0);
  });

  it('deixa de fora as linhas que não servem', () => {
    const fora = TODAS.slice(0, 5).map((row) => ({ ...row, latitude: -8.05, longitude: -34.9 }));
    const escolas = pickOfficialPlaces([...fora, ...TODAS.slice(5)], 10_000, 's');
    const ids = new Set(escolas.map((escola) => escola.officialId));
    for (const row of fora) expect(ids.has(row.id)).toBe(false);
  });

  it('exige uma tabela de verdade antes de trocar o catálogo conferido', () => {
    // A troca de fonte é decidida no servidor por este piso: meia dúzia de
    // linhas de teste não é "a tabela do TSE".
    expect(MIN_OFFICIAL_PLACES).toBeGreaterThanOrEqual(20);
  });
});

describe('moradias perto de onde se vota', () => {
  it('ficam nos municípios das escolas, com teto por município', () => {
    const escolas = pickOfficialPlaces(TODAS, 80, 'semente-2');
    const cidades = new Set(escolas.map((escola) => escola.city));
    const enderecos = residenceAddressesFor(escolas, []);

    expect(enderecos.length).toBeGreaterThan(0);
    for (const endereco of enderecos) {
      expect(cidades.has(endereco.city)).toBe(true);
      expect(endereco.state).toBe('AL');
      // Sem número: o mapa mostra a rua, nunca a casa.
      expect(endereco.street).not.toMatch(/numero/i);
    }

    const porCidade = new Map<string, number>();
    for (const endereco of enderecos) porCidade.set(endereco.city, (porCidade.get(endereco.city) ?? 0) + 1);
    for (const quantas of porCidade.values()) expect(quantas).toBeLessThanOrEqual(RESIDENCE_STREETS_PER_CITY);
  });

  it('aproveita primeiro as ruas do catálogo conferido, que já estão no cache', () => {
    const escolas = pickOfficialPlaces(TODAS, 60, 'semente-1');
    const enderecos = residenceAddressesFor(escolas);
    const deMaceio = enderecos.filter((endereco) => endereco.city === 'Maceió');
    const conferidas = DEMO_ADDRESSES.filter((endereco) => endereco.city === 'Maceió');

    expect(deMaceio.slice(0, Math.min(conferidas.length, RESIDENCE_STREETS_PER_CITY))).toEqual(
      conferidas.slice(0, RESIDENCE_STREETS_PER_CITY),
    );
  });
});

describe('Time DEMO com as escolas oficiais', () => {
  const escolas = pickOfficialPlaces(TODAS, 60, 'semente-1');
  const data = buildDemoData({
    seed: 'semente-1',
    people: 600,
    places: 60,
    admins: 2,
    catalog: escolas,
    addresses: residenceAddressesFor(escolas),
    now: new Date('2026-10-13T15:00:00.000Z'),
  });

  it('usa todas as escolas pedidas, e nenhuma fica vazia', () => {
    expect(data.places).toHaveLength(60);
    expect(data.people).toHaveLength(600);

    const ocupadas = new Set(data.people.map((person) => person.placeIndex));
    expect(ocupadas.size).toBe(60);
  });

  it('dá a cada pessoa a zona e uma seção que existem na escola dela', () => {
    for (const person of data.people) {
      const local = data.places[person.placeIndex];
      expect(person.zone).toBe(local.place.zone);
      expect(local.sections).toContain(person.section);
    }
  });

  it('faz cada pessoa morar no município em que vota, dentro de Alagoas', () => {
    for (const person of data.people) {
      const local = data.places[person.placeIndex];
      expect(person.city).toBe(local.place.city);
      expect(person.state).toBe('AL');
    }
    for (const local of data.places) {
      const row = TODAS.find((linha) => linha.id === local.place.officialId)!;
      expect(isInAlagoas(row.latitude, row.longitude)).toBe(true);
    }
  });

  it('alcança muitos municípios, e não um punhado', () => {
    expect(data.cities.length).toBeGreaterThanOrEqual(8);
  });
});
