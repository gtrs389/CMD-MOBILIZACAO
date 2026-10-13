import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Time DEMO com as escolas da tabela oficial do TSE, com um banco em memoria.
 *
 * O sistema ja esta em operacao com times reais. O que estes testes protegem
 * e a fronteira: o Time DEMO LE a tabela oficial e COMPARTILHA o pino de uma
 * escola com os times reais — mas nao altera a tabela, nao reescreve o pino
 * que um time real ja usa, nao apaga ponto compartilhado e nao toca em
 * cadastro, vinculo ou mapa de time real.
 */

interface Row {
  [key: string]: unknown;
}

const db: Record<string, Row[]> = {
  cmd_clients: [],
  cmd_users: [],
  cmd_members: [],
  cmd_member_locations: [],
  cmd_map_locations: [],
  cmd_demo_seeds: [],
  cmd_polling_places: [],
};

let sequence = 0;
const nextId = (prefixo: string) => `${prefixo}-${(sequence += 1)}`;

function matches(row: Row, filters: Record<string, string> = {}): boolean {
  return Object.entries(filters).every(([coluna, expressao]) => {
    const valor = row[coluna];
    if (expressao === 'not.is.null') return valor !== null && valor !== undefined;
    if (expressao === 'is.null') return valor === null || valor === undefined;
    if (expressao === 'is.true') return valor === true;
    if (expressao.startsWith('eq.')) return String(valor) === expressao.slice(3);
    if (expressao.startsWith('in.(')) {
      return expressao
        .slice(4, -1)
        .split(',')
        .map((item) => item.replace(/^"|"$/g, ''))
        .includes(String(valor));
    }
    return true;
  });
}

const copia = (row: Row) => JSON.parse(JSON.stringify(row)) as Row;

vi.mock('@/lib/supabase/rest', () => ({
  inFilter: (values: readonly string[]) => `in.(${values.map((v) => `"${v}"`).join(',')})`,
  notInFilter: (values: readonly string[]) => `not.in.(${values.map((v) => `"${v}"`).join(',')})`,
  selectRows: async (table: string, options: { filters?: Record<string, string> } = {}) =>
    db[table].filter((row) => matches(row, options.filters)).map(copia),
  selectOne: async (table: string, options: { filters?: Record<string, string> } = {}) => {
    const row = db[table].find((item) => matches(item, options.filters));
    return row ? copia(row) : null;
  },
  insertOne: async (table: string, value: Row) => {
    if (table === 'cmd_map_locations' && db[table].some((r) => r.query_hash === value.query_hash)) {
      throw new Error('duplicate key');
    }
    const criado = { id: nextId(table), ...value };
    db[table].push(criado);
    return copia(criado);
  },
  insertRows: async (table: string, values: Row[]) => {
    const criados = values.map((v) => ({ id: nextId(table), ...v }));
    db[table].push(...criados);
    return criados.map(copia);
  },
  insertRowsInChunks: async (table: string, values: Row[]) => {
    // A unicidade de `query_hash`, como no banco de verdade.
    if (table === 'cmd_map_locations') {
      const hashes = new Set(db[table].map((r) => r.query_hash));
      if (values.some((v) => hashes.has(v.query_hash))) throw new Error('duplicate key');
    }
    const criados = values.map((v) => ({ id: nextId(table), ...v }));
    db[table].push(...criados);
    return criados.map(copia);
  },
  updateRows: async (table: string, filters: Record<string, string>, values: Row) => {
    const alterados: Row[] = [];
    for (const row of db[table]) {
      if (!matches(row, filters)) continue;
      Object.assign(row, values);
      alterados.push(copia(row));
    }
    return alterados;
  },
  deleteRows: async (table: string, filters: Record<string, string>) => {
    const removidos = db[table].filter((row) => matches(row, filters));
    db[table] = db[table].filter((row) => !matches(row, filters));
    return removidos;
  },
  callFunction: async () => null,
  SupabaseRequestError: class extends Error {
    isMissingSchema = false;
  },
}));

vi.mock('@/lib/server/client.service', () => ({
  getClient: async (id: string) => {
    const row = db.cmd_clients.find((c) => c.id === id);
    return row ? { id: row.id, name: row.name, isDemo: row.is_demo === true, form: { fields: [] } } : null;
  },
  createClient: async () => ({ id: 'novo' }),
  deleteClient: async () => undefined,
}));
vi.mock('@/lib/supabase/storage', () => ({ deleteImage: async () => undefined }));

/** O provedor de mapa: devolve sempre um ponto em Maceio, e conta as consultas. */
const consultas: string[] = [];
let provedorFora = false;
vi.mock('@/lib/server/serpapi.service', () => ({
  MapLookupError: class MapLookupError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  lookupPlace: async (query: string) => {
    consultas.push(query);
    if (provedorFora) {
      const { MapLookupError } = await import('@/lib/server/serpapi.service');
      throw new MapLookupError('PROVIDER_UNAVAILABLE');
    }
    return {
      latitude: -9.6658,
      longitude: -35.7353,
      title: query,
      address: query,
      placeId: `pl-${consultas.length}`,
      dataId: null,
      imageUrl: null,
    };
  },
}));

const DEMO = 'demo-1';
const REAL = 'real-1';

const CIDADES = [
  { city: 'MACEIÓ', escolas: 30, lat: -9.66, lng: -35.73 },
  { city: 'ARAPIRACA', escolas: 12, lat: -9.75, lng: -36.66 },
  { city: 'RIO LARGO', escolas: 6, lat: -9.48, lng: -35.85 },
  { city: 'PENEDO', escolas: 6, lat: -10.29, lng: -36.58 },
  { city: 'DELMIRO GOUVEIA', escolas: 4, lat: -9.39, lng: -37.99 },
] as const;

function seed(): void {
  for (const tabela of Object.keys(db)) db[tabela] = [];
  sequence = 0;
  consultas.length = 0;
  provedorFora = false;

  db.cmd_clients.push({ id: DEMO, name: 'Time DEMO', is_demo: true });
  db.cmd_clients.push({ id: REAL, name: 'Time oficial', is_demo: false });
  db.cmd_demo_seeds.push({ id: 'seed-1', client_id: DEMO, seed_key: 'demo_chave_123', created_at: '2026-10-01' });
  for (const [id, client] of [
    ['adm-demo', DEMO],
    ['adm-real', REAL],
  ] as const) {
    db.cmd_users.push({
      id,
      name: `Admin ${client}`,
      phone: id === 'adm-demo' ? '82999990000' : '82999990001',
      role: 'CANDIDATE',
      client_id: client,
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
    });
  }

  let secao = 1;
  CIDADES.forEach((cidade, c) => {
    for (let i = 0; i < cidade.escolas; i += 1) {
      db.cmd_polling_places.push({
        id: `pp-${c}-${i}`,
        uf: 'AL',
        city_code: 100 + c,
        city: cidade.city,
        zone: 1 + c,
        name: `ESCOLA ${cidade.city} ${i}`,
        address: `RUA ${cidade.city} ${i % 3}, ${i + 1}`,
        district: 'CENTRO',
        latitude: cidade.lat + i * 0.001,
        longitude: cidade.lng + i * 0.001,
        sections: [secao++, secao++, secao++],
      });
    }
  });

  // Um integrante REAL que vota na primeira escola de Maceio: o pino dela
  // ja existe no cache, gravado pelo caminho real.
  db.cmd_members.push({
    id: 'real-m-1',
    client_id: REAL,
    name: 'Pessoa real',
    phone: '82988880000',
    zone: '1',
    section: '1',
    city: 'Maceió',
    state: 'AL',
    demo_seed: null,
  });
}

async function pinoRealExistente(): Promise<Row> {
  const { pollingPlaceHash } = await import('@/lib/server/map-location.service');
  const pino = {
    id: 'loc-real-1',
    query_hash: pollingPlaceHash('pp-0-0'),
    latitude: -9.66,
    longitude: -35.73,
    title: 'ESCOLA MACEIÓ 0',
    address: 'RUA MACEIÓ 0, 1, CENTRO, MACEIÓ - AL',
    provider: 'CMD_LOCAIS_DE_VOTACAO',
    searched_at: '2026-09-01T00:00:00.000Z',
  };
  db.cmd_map_locations.push(pino);
  db.cmd_member_locations.push(
    {
      id: 'real-link-1',
      client_id: REAL,
      member_id: 'real-m-1',
      location_kind: 'POLLING_PLACE',
      status: 'SUCCESS',
      location_id: 'loc-real-1',
    },
    {
      id: 'real-link-2',
      client_id: REAL,
      member_id: 'real-m-1',
      location_kind: 'RESIDENCE',
      status: 'FAILED',
      error_code: 'TIMEOUT',
      location_id: null,
    },
  );
  return copia(pino);
}

beforeEach(seed);

describe('Time DEMO com a tabela oficial do TSE', () => {
  it('sorteia as escolas da tabela, com zona e seção que existem nelas', async () => {
    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    const report = await refreshDemoTeam(DEMO, { people: 200, places: 25 });

    expect(report.source).toBe('TSE');
    expect(report.places).toBe(25);
    expect(report.people).toBe(200);
    expect(report.cities).toBeGreaterThan(1);

    const pessoas = db.cmd_members.filter((m) => m.client_id === DEMO);
    expect(pessoas).toHaveLength(200);
    for (const pessoa of pessoas) {
      const escola = db.cmd_polling_places.find(
        (pp) => String(pp.zone) === pessoa.zone && (pp.sections as number[]).includes(Number(pessoa.section)),
      );
      // Zona + seção acham a escola, como no caminho real.
      expect(escola).toBeDefined();
      expect(pessoa.state).toBe('AL');
    }
  });

  it('põe toda escola no mapa sem consulta paga, com o pino no formato do caminho real', async () => {
    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    const { pollingPlaceHash } = await import('@/lib/server/map-location.service');
    await refreshDemoTeam(DEMO, { people: 120, places: 20 });

    const escolas = db.cmd_member_locations.filter(
      (l) => l.client_id === DEMO && l.location_kind === 'POLLING_PLACE',
    );
    expect(escolas).toHaveLength(120);
    expect(escolas.every((l) => l.status === 'SUCCESS' && l.location_id)).toBe(true);

    const pinos = new Set(escolas.map((l) => l.location_id));
    for (const id of pinos) {
      const pino = db.cmd_map_locations.find((p) => p.id === id)!;
      expect(pino.provider).toBe('CMD_LOCAIS_DE_VOTACAO');
      const oficial = db.cmd_polling_places.find((pp) => pollingPlaceHash(pp.id as string) === pino.query_hash);
      expect(oficial).toBeDefined();
      expect(pino.latitude).toBe(oficial!.latitude);
    }
    // Nenhuma consulta foi para escola: as que houve sao de rua de moradia.
    for (const consulta of consultas) expect(consulta).not.toMatch(/ESCOLA/);
  });

  it('não altera a tabela oficial', async () => {
    const antes = db.cmd_polling_places.map(copia);
    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    await refreshDemoTeam(DEMO, { people: 150, places: 40 });
    expect(db.cmd_polling_places).toEqual(antes);
  });

  it('aproveita o pino que um time real já usa, sem reescrevê-lo nem duplicá-lo', async () => {
    const pino = await pinoRealExistente();
    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    // Todas as escolas: a de Maceio usada pelo time real entra com certeza.
    await refreshDemoTeam(DEMO, { people: 300, places: 58 });

    const mesmos = db.cmd_map_locations.filter((p) => p.query_hash === pino.query_hash);
    expect(mesmos).toHaveLength(1);
    expect(mesmos[0]).toEqual(pino);
    expect(
      db.cmd_member_locations.some((l) => l.client_id === DEMO && l.location_id === pino.id),
    ).toBe(true);
  });

  it('refazer não apaga pino compartilhado nem toca no time real', async () => {
    await pinoRealExistente();
    const realAntes = {
      membros: db.cmd_members.filter((m) => m.client_id === REAL).map(copia),
      vinculos: db.cmd_member_locations.filter((l) => l.client_id === REAL).map(copia),
    };

    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    await refreshDemoTeam(DEMO, { people: 100, places: 30 });
    const pinosOficiais = db.cmd_map_locations.filter((p) => p.provider === 'CMD_LOCAIS_DE_VOTACAO').length;
    await refreshDemoTeam(DEMO, { people: 100, places: 30 });

    expect(db.cmd_map_locations.filter((p) => p.provider === 'CMD_LOCAIS_DE_VOTACAO')).toHaveLength(
      pinosOficiais,
    );
    expect(db.cmd_members.filter((m) => m.client_id === REAL)).toEqual(realAntes.membros);
    expect(db.cmd_member_locations.filter((l) => l.client_id === REAL)).toEqual(realAntes.vinculos);
  });

  it('a mesma quantidade devolve as mesmas escolas', async () => {
    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    const escolas = () =>
      [...new Set(db.cmd_members.filter((m) => m.client_id === DEMO).map((m) => `${m.zone}:${m.section}`))].sort();

    await refreshDemoTeam(DEMO, { people: 80, places: 15 });
    const primeira = escolas();
    await refreshDemoTeam(DEMO, { people: 80, places: 15 });
    expect(escolas()).toEqual(primeira);
  });

  it('sem a tabela carregada, cai no catálogo conferido', async () => {
    db.cmd_polling_places = db.cmd_polling_places.slice(0, 10);
    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    const report = await refreshDemoTeam(DEMO, { people: 60 });
    expect(report.source).toBe('CATALOGO');
  });

  it('time real não é refeito', async () => {
    const { refreshDemoTeam } = await import('@/lib/server/demo.service');
    await expect(refreshDemoTeam(REAL)).rejects.toThrow();
  });
});

describe('completar o mapa do Time DEMO', () => {
  it('resolve as moradias que ficaram para trás, uma consulta por rua', async () => {
    const { refreshDemoTeam, completeDemoMap } = await import('@/lib/server/demo.service');
    provedorFora = true;
    await refreshDemoTeam(DEMO, { people: 90, places: 20 });

    const moradias = () =>
      db.cmd_member_locations.filter((l) => l.client_id === DEMO && l.location_kind === 'RESIDENCE');
    expect(moradias().some((l) => l.status === 'FAILED')).toBe(true);

    provedorFora = false;
    consultas.length = 0;
    const resultado = await completeDemoMap(DEMO);

    expect(resultado.remaining).toBe(0);
    expect(resultado.resolved).toBe(90);
    expect(moradias().every((l) => l.status === 'SUCCESS' && l.location_id)).toBe(true);
    // Uma consulta por endereço, e não por pessoa.
    const ruas = new Set(
      db.cmd_members
        .filter((m) => m.client_id === DEMO)
        .map((m) => `${m.street}|${m.district}|${m.city}`),
    );
    expect(consultas.length).toBe(ruas.size);
  });

  it('não toca nos vínculos de um time real, mesmo com a mesma falha', async () => {
    await pinoRealExistente();
    const { refreshDemoTeam, completeDemoMap } = await import('@/lib/server/demo.service');
    provedorFora = true;
    await refreshDemoTeam(DEMO, { people: 30, places: 10 });
    provedorFora = false;

    await completeDemoMap(DEMO);
    const real = db.cmd_member_locations.find((l) => l.id === 'real-link-2')!;
    expect(real.status).toBe('FAILED');
    expect(real.error_code).toBe('TIMEOUT');
  });

  it('time real é recusado', async () => {
    const { completeDemoMap } = await import('@/lib/server/demo.service');
    await expect(completeDemoMap(REAL)).rejects.toThrow();
  });
});

describe('segunda camada com as escolas oficiais', () => {
  it('a gente trazida pela equipe vota nas MESMAS escolas do time', async () => {
    const { refreshDemoTeam, setDemoRecruiters } = await import('@/lib/server/demo.service');
    await refreshDemoTeam(DEMO, { people: 120, places: 12 });

    const doTime = new Set(
      db.cmd_members
        .filter((m) => m.client_id === DEMO && m.demo_seed === 'al-tre-2026-2')
        .map((m) => `${m.zone}:${m.section}`),
    );
    const escolasDoTime = db.cmd_polling_places.filter((pp) =>
      (pp.sections as number[]).some((secao) => doTime.has(`${pp.zone}:${secao}`)),
    );

    await setDemoRecruiters(DEMO, { recruiters: 4, people: 80 });
    const novas = db.cmd_members.filter((m) => m.client_id === DEMO && m.recruited_by_role === 'EQUIPE');
    expect(novas).toHaveLength(80);
    for (const pessoa of novas) {
      const escola = escolasDoTime.find(
        (pp) => String(pp.zone) === pessoa.zone && (pp.sections as number[]).includes(Number(pessoa.section)),
      );
      expect(escola).toBeDefined();
    }
  });

  it('time antigo, do catálogo, continua no catálogo mesmo casando uma seção por acaso', async () => {
    // Uma pessoa antiga com zona e seção que existem na tabela, e o resto
    // sem zona — o retrato de um Time DEMO criado antes da tabela oficial.
    for (let i = 0; i < 20; i += 1) {
      db.cmd_members.push({
        id: `antiga-${i}`,
        client_id: DEMO,
        name: `Antiga ${i}`,
        phone: `8297777${String(i).padStart(4, '0')}`,
        zone: i === 0 ? '1' : null,
        section: i === 0 ? '1' : null,
        city: 'Maceió',
        state: 'AL',
        demo_seed: 'al-tre-2026-2',
        recruited_by_user_id: 'adm-demo',
        recruited_by_name: 'Admin demo-1',
        recruited_by_role: 'CANDIDATE',
        created_at: '2026-10-01T00:00:00.000Z',
      });
    }

    const { demoSchoolsOfTeam } = await import('@/lib/server/demo-schools');
    expect((await demoSchoolsOfTeam(DEMO)).source).toBe('CATALOGO');
  });
});
