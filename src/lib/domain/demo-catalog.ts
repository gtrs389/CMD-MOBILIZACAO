/**
 * Catalogo do Time DEMO: locais de votacao REAIS de Alagoas.
 *
 * Substitui as escolas, ruas e coordenadas que eu havia inventado — e que
 * puseram marcador em Recife e no mar. Aqui nao ha nada inventado: cada
 * entrada e um local de votacao divulgado pela Justica Eleitoral, com o
 * endereco como ele foi publicado, e a fonte anotada linha a linha.
 *
 * O QUE NAO ESTA AQUI, E POR QUE
 *
 *   COORDENADA  nao e escrita neste arquivo. Ela vem da MESMA consulta que o
 *               sistema ja usa para pôr um integrante real no mapa, e fica
 *               no cache de `cmd_map_locations`. Coordenada digitada de
 *               memoria e exatamente o erro que gerou o print com pinos no
 *               mar.
 *   ZONA/SECAO  so aparecem quando a fonte as publicou junto do local. Onde
 *               ela nao publicou, o campo fica vazio — e a tela mostra "sem
 *               zona/secao", que e a verdade.
 *   RUA/BAIRRO  tambem sao opcionais. Ha locais divulgados so pelo nome e
 *               pelo municipio (ou por um povoado, um conjunto, um
 *               loteamento). Nesses casos a consulta de coordenada usa o
 *               NOME DO LOCAL + municipio + UF, que e como a Justica
 *               Eleitoral tambem os identifica. Completar o endereco de
 *               cabeca seria invencao.
 *
 * Nenhum dado de eleitor entra aqui: sao enderecos de predios publicos e
 * privados usados como local de votacao, ja divulgados pela Justica
 * Eleitoral.
 */

/**
 * Versao do catalogo.
 *
 * Marca, linha a linha, quais registros do Time DEMO foram GERADOS — e por
 * qual catalogo. E o que permite corrigir um Time DEMO ja criado sem tocar em
 * nada mais: a rotina de correcao regenera somente o que carrega esta marca,
 * e deixa intactos o time, os administradores, os acessos, os links, as
 * configuracoes e qualquer pessoa cadastrada a mao.
 *
 * Mude a versao sempre que o catalogo mudar de conteudo.
 */
export const DEMO_SEED_VERSION = 'al-tre-2026-2' as const;

/**
 * Marca das pessoas da SEGUNDA CAMADA: as que a equipe trouxe.
 *
 * Marca propria, e nao a mesma da geracao, por uma razao concreta: e por ela
 * que a segunda camada e refeita sem tocar em quem ja estava no time. Sem
 * essa distincao, "quem tem responsavel do perfil EQUIPE" seria o unico
 * criterio disponivel — e ele pegaria tambem as pessoas da primeira camada
 * que uma versao anterior tenha passado para a equipe, apagando gente que o
 * administrador trouxe.
 *
 * Cabe no `check` da migration 034 (`^[a-z0-9-]{3,40}$`), e a rotina de
 * "Refazer dados" continua alcancando estas pessoas: ela trata como gerado
 * tudo o que tem marca, qualquer que seja.
 */
export const DEMO_SECOND_LAYER_SEED = 'al-tre-2026-2-equipe' as const;

/** Unico estado aceito no Time DEMO. */
export const DEMO_STATE = 'AL' as const;

/**
 * Limites de Alagoas, usados para recusar qualquer ponto fora do estado.
 *
 * Retangulo folgado sobre o territorio alagoano. Ele nao decide sozinho se o
 * ponto presta: a garantia de verdade e que NENHUMA coordenada e calculada —
 * todas vem de um endereco real resolvido pelo geocodificador. O retangulo e
 * a ultima barreira contra um endereco que resolveu para o lugar errado.
 */
export const ALAGOAS_BOUNDS = {
  minLat: -10.55,
  maxLat: -8.75,
  minLng: -38.3,
  maxLng: -35.1,
} as const;

/**
 * Centro do estado, para quando nao ha ponto nenhum para enquadrar.
 *
 * Aproximadamente o centro geografico de Alagoas. Nunca Recife, nunca outro
 * estado.
 */
export const ALAGOAS_CENTER = { latitude: -9.5713, longitude: -36.782 } as const;

/** Local de votacao real, como a Justica Eleitoral o publicou. */
export interface DemoPollingPlace {
  /** Identificador estavel: e ele que torna a regeneracao idempotente. */
  id: string;
  /** Nome oficial, como divulgado. */
  name: string;
  /** Logradouro. Nulo quando a divulgacao nao trouxe rua. */
  street: string | null;
  /** Numero. Nulo quando o local e divulgado como "s/n". */
  number: string | null;
  /** Bairro, povoado, conjunto ou loteamento. Nulo quando nao publicado. */
  district: string | null;
  city: string;
  state: typeof DEMO_STATE;
  /** Zona eleitoral. Nula quando a fonte nao a publicou junto do local. */
  zone: string | null;
  /** Secoes. Vazio quando a fonte nao as publicou. */
  sections: readonly string[];
  /** Onde isto foi conferido. */
  source: string;
  /**
   * Linha da tabela oficial do TSE (`cmd_polling_places`) de onde o local
   * saiu. Ausente nas entradas do catalogo conferido abaixo. Com ela, a
   * coordenada e a OFICIAL, copiada da tabela — sem consulta paga, pelo mesmo
   * caminho que poe a escola de um integrante real no mapa.
   */
  officialId?: string;
}

/**
 * Relacao de alteracoes de locais de votacao para as Eleicoes 2026,
 * divulgada pelo TRE/AL e reproduzida pela imprensa alagoana. Cobre Maceio e
 * mais 51 municipios.
 */
const TRE_AL_2026 =
  'https://www.tre-al.jus.br/comunicacao/noticias/2026/Agosto/' +
  'tre-al-divulga-alteracoes-em-locais-de-votacao-para-as-eleicoes-2026';

/**
 * Relacao dos locais de votacao de Palmeira dos Indios (10a Zona Eleitoral),
 * publicada para as Eleicoes 2024. Municipio de zona unica: a zona vale para
 * todos os locais abaixo, e foi por isso que ela pôde ser preenchida.
 */
const PALMEIRA_2024 =
  'https://www.tribunadosertao.com.br/cidades/2024/10/06/' +
  '680513-eleicoes-2024-conheca-os-locais-de-votacao-em-palmeira-dos-indios';

/**
 * Locais de votacao conferidos, espalhados por municipios alagoanos.
 *
 * A ordem importa: ela e a ordem em que o Time DEMO escolhe os locais, entao
 * comeca pela capital e pelo maior municipio do interior, como uma operacao
 * de verdade faria, e depois abre para o agreste, o sertao e o litoral norte.
 *
 * Preferi algumas dezenas de locais conferidos a centenas inventados. Quando a fonte nao
 * publicou rua, bairro, zona ou secao, o campo fica vazio — nunca preenchido
 * de cabeca.
 */
export const DEMO_POLLING_PLACES: readonly DemoPollingPlace[] = [
  /* ----------------------------- Maceio ----------------------------- */
  {
    id: 'mcz-maple-bear-campus-ii',
    name: 'Maple Bear Canadian School – Campus II',
    street: 'Rua Joaquim Marques Luz',
    number: '108',
    district: 'Jatiúca',
    city: 'Maceió',
    state: DEMO_STATE,
    zone: null,
    sections: ['381', '392', '395', '396', '398', '401', '403', '404', '406', '425'],
    source: TRE_AL_2026,
  },
  {
    id: 'mcz-sesi-senai',
    name: 'Escola SESI/SENAI',
    street: 'Avenida Antônio Lisboa de Amorim',
    number: '1751',
    district: 'Benedito Bentes II',
    city: 'Maceió',
    state: DEMO_STATE,
    zone: null,
    sections: ['506', '507', '511', '514', '516', '519', '521'],
    source: TRE_AL_2026,
  },
  {
    id: 'mcz-theotonio-vilela-brandao',
    name: 'Escola Estadual Prof. Theotônio Vilela Brandão',
    street: 'Rua Coronel Adauto Gomes Barbosa',
    number: null,
    // O TRE/AL publica "Santo Eduardo (Poço)"; os cadastros da propria escola
    // registram Jatiuca. Fica como a Justica Eleitoral divulgou, que e a
    // fonte do local de votacao. O municipio, esse, e o mesmo em todas as
    // fontes: Maceio.
    district: 'Poço',
    city: 'Maceió',
    state: DEMO_STATE,
    zone: null,
    sections: ['143', '144', '271', '285', '310'],
    source: TRE_AL_2026,
  },
  {
    id: 'mcz-rosalvo-ribeiro-dos-santos',
    name: 'Colégio Rosalvo Ribeiro dos Santos',
    street: 'Rua Bonfim',
    number: '344',
    district: 'Jacintinho',
    city: 'Maceió',
    state: DEMO_STATE,
    zone: null,
    sections: ['442'],
    source: TRE_AL_2026,
  },
  {
    id: 'mcz-cmei-joao-pedro',
    name: 'Creche Escola CMEI João Pedro da Silva Bernardino',
    street: 'Rua Boa Vista',
    number: null,
    district: 'Ouro Preto',
    city: 'Maceió',
    state: DEMO_STATE,
    // Divulgado como novo local da 1a Zona Eleitoral; as secoes nao foram
    // publicadas junto, entao ficam de fora.
    zone: '1',
    sections: [],
    source: TRE_AL_2026,
  },
  {
    id: 'mcz-santa-ursula-unidade-nova',
    name: 'Colégio Santa Úrsula – Unidade Nova',
    street: 'Rua Pio XII',
    number: '705',
    district: 'Jatiúca',
    city: 'Maceió',
    state: DEMO_STATE,
    zone: null,
    sections: [],
    source: TRE_AL_2026,
  },

  /* ---------------------------- Arapiraca --------------------------- */
  {
    id: 'arapiraca-renilda-de-albuquerque',
    name: 'Escola Renilda de Albuquerque',
    street: 'Rua João Alexandre dos Santos',
    number: null,
    district: 'Baixa Grande',
    city: 'Arapiraca',
    state: DEMO_STATE,
    zone: null,
    sections: ['28', '47', '48', '49', '296', '342', '343', '348', '351', '363', '364'],
    source: TRE_AL_2026,
  },
  {
    id: 'arapiraca-mario-cesar-fontes',
    name: 'Escola Prof. Mário César Fontes',
    street: 'Rua Dr. Carlos André',
    number: null,
    district: 'Planalto',
    city: 'Arapiraca',
    state: DEMO_STATE,
    zone: null,
    // Recebeu as secoes de duas escolas: as duas listas, como divulgadas.
    sections: [
      '142', '143', '144', '162', '163', '164', '301', '367', '368',
      '559', '568', '576', '582', '594', '606', '613',
    ],
    source: TRE_AL_2026,
  },
  {
    id: 'arapiraca-rotary',
    name: 'Escola Rotary',
    street: 'Rua Teodorico Costa',
    number: '329',
    district: 'Centro',
    city: 'Arapiraca',
    state: DEMO_STATE,
    zone: null,
    sections: ['585'],
    source: TRE_AL_2026,
  },

  /* ----------------------- Palmeira dos Indios ---------------------- */
  {
    id: 'palmeira-almeida-cavalcante',
    name: 'Escola Estadual Almeida Cavalcante',
    street: 'Rua Duque de Caxias',
    number: null,
    district: 'Centro',
    city: 'Palmeira dos Índios',
    state: DEMO_STATE,
    zone: '10',
    sections: [],
    source: PALMEIRA_2024,
  },
  {
    id: 'palmeira-manoel-passos-lima',
    name: 'Escola Estadual Manoel Passos Lima',
    street: 'Rua Genésio Moreira',
    number: null,
    district: 'São Francisco',
    city: 'Palmeira dos Índios',
    state: DEMO_STATE,
    zone: '10',
    sections: [],
    source: PALMEIRA_2024,
  },
  {
    id: 'palmeira-gerson-jatoba-leite',
    name: 'Escola Municipal Dr. Gerson Jatobá Leite',
    street: 'Avenida Brasília',
    number: null,
    district: 'São Cristóvão',
    city: 'Palmeira dos Índios',
    state: DEMO_STATE,
    zone: '10',
    sections: [],
    source: PALMEIRA_2024,
  },
  {
    id: 'palmeira-sagrada-familia',
    name: 'Colégio Sagrada Família',
    street: 'Rua Dom Bosco',
    number: null,
    district: 'Alto do Cruzeiro',
    city: 'Palmeira dos Índios',
    state: DEMO_STATE,
    zone: '10',
    sections: [],
    source: PALMEIRA_2024,
  },
  {
    id: 'palmeira-rosinha-pimentel',
    name: 'Escola Municipal Professora Rosinha Pimentel',
    street: 'Avenida Conselheiro Sebastião Lima',
    number: null,
    district: 'Paraíso',
    city: 'Palmeira dos Índios',
    state: DEMO_STATE,
    zone: '10',
    sections: [],
    source: PALMEIRA_2024,
  },
  {
    id: 'palmeira-uneal',
    name: 'Universidade Estadual de Alagoas – UNEAL',
    street: 'Rodovia AL-115, km 03',
    number: null,
    district: null,
    city: 'Palmeira dos Índios',
    state: DEMO_STATE,
    zone: '10',
    sections: [],
    source: PALMEIRA_2024,
  },
  {
    id: 'palmeira-pedro-rodrigues-gaia',
    name: 'Escola Municipal Pedro Rodrigues Gaia',
    street: null,
    number: null,
    district: 'Povoado Coruripe da Cal',
    city: 'Palmeira dos Índios',
    state: DEMO_STATE,
    zone: '10',
    sections: ['267', '306'],
    source: PALMEIRA_2024,
  },

  /* ------------------------ Girau do Ponciano ----------------------- */
  {
    id: 'girau-antonio-alves-dos-santos',
    name: 'Escola Vereador Antônio Alves dos Santos',
    street: 'Rua José Pereira Bezerra',
    number: null,
    district: 'Centro',
    city: 'Girau do Ponciano',
    state: DEMO_STATE,
    zone: null,
    sections: ['77', '106'],
    source: TRE_AL_2026,
  },
  {
    id: 'girau-jose-de-messias-barros',
    name: 'Complexo Municipal EB José de Messias Barros',
    street: 'Rodovia GP-1, Anel Viário Sebastião Gomes de Barros',
    number: null,
    district: null,
    city: 'Girau do Ponciano',
    state: DEMO_STATE,
    zone: null,
    sections: ['30', '31', '60', '61', '64', '187'],
    source: TRE_AL_2026,
  },

  /* ---------------------------- Ouro Branco -------------------------- */
  {
    id: 'ouro-branco-augusto-alves-da-graca',
    name: 'Escola Municipal Augusto Alves da Graça',
    street: 'Rua Augusto Graça',
    number: '184',
    district: 'Centro',
    city: 'Ouro Branco',
    state: DEMO_STATE,
    zone: null,
    sections: ['69', '70', '71', '72'],
    source: TRE_AL_2026,
  },
  {
    id: 'ouro-branco-cria-eliane-paranhos',
    name: 'Creche CRIA Eliane Alves Paranhos Ferreira',
    street: 'Rua Presidente Getúlio Vargas',
    number: null,
    district: 'Centro',
    city: 'Ouro Branco',
    state: DEMO_STATE,
    zone: null,
    sections: ['94', '95', '96', '105'],
    source: TRE_AL_2026,
  },

  /* --------------------------- Rio Largo ---------------------------- */
  {
    id: 'rio-largo-neusa-soares',
    name: 'Escola Estadual Neusa Soares',
    // Divulgada pelo conjunto, sem logradouro: a consulta usa o nome do
    // local, o conjunto e o municipio.
    street: null,
    number: null,
    district: 'Conjunto Antônio Lins',
    city: 'Rio Largo',
    state: DEMO_STATE,
    zone: null,
    sections: ['270', '274', '279', '283', '284', '288'],
    source: TRE_AL_2026,
  },

  /* ------------------------- Santana do Ipanema --------------------- */
  {
    id: 'santana-ipanema-divino-mestre',
    name: 'Colégio Divino Mestre',
    street: 'Rua Coronel Lucena Maranhão',
    number: '197',
    district: 'Monumento',
    city: 'Santana do Ipanema',
    state: DEMO_STATE,
    zone: null,
    sections: ['210', '220'],
    source: TRE_AL_2026,
  },

  /* --------------------------- Pão de Açúcar ------------------------ */
  {
    id: 'pao-de-acucar-senador-rui-palmeira',
    name: 'U.M.E. Senador Rui Palmeira',
    street: 'Avenida Ferreira de Novaes',
    number: '733',
    district: 'Centro',
    city: 'Pão de Açúcar',
    state: DEMO_STATE,
    zone: null,
    sections: ['63', '65'],
    source: TRE_AL_2026,
  },

  /* ---------------------------- Coruripe --------------------------- */
  {
    id: 'coruripe-jose-buarque-da-silva',
    name: 'Escola Municipal José Buarque da Silva',
    street: null,
    number: null,
    district: null,
    city: 'Coruripe',
    state: DEMO_STATE,
    zone: null,
    sections: ['12', '17', '18', '19', '20', '21', '22'],
    source: TRE_AL_2026,
  },
  {
    id: 'coruripe-manoel-cecilio-de-jesus',
    name: 'Escola Municipal Manoel Cecílio de Jesus',
    street: null,
    number: null,
    district: null,
    city: 'Coruripe',
    state: DEMO_STATE,
    zone: null,
    sections: ['23', '24', '54', '70', '89', '126'],
    source: TRE_AL_2026,
  },

  /* ------------------------- Marechal Deodoro ----------------------- */
  {
    id: 'marechal-deodoro-ronalt-de-sena',
    name: 'Escola Municipal Rônalt de Sena',
    street: null,
    number: null,
    district: 'Loteamento Terra da Esperança',
    city: 'Marechal Deodoro',
    state: DEMO_STATE,
    zone: null,
    sections: ['160', '164'],
    source: TRE_AL_2026,
  },

  /* --------------------------- Porto Calvo -------------------------- */
  {
    id: 'porto-calvo-cria-vovo-lila',
    name: 'Creche CRIA Vovó Lila',
    street: 'Rua do Patia',
    number: null,
    district: 'Varadouro',
    city: 'Porto Calvo',
    state: DEMO_STATE,
    zone: null,
    sections: [],
    source: TRE_AL_2026,
  },

  /* ---------------------------- Maragogi ---------------------------- */
  {
    id: 'maragogi-cmei-maria-do-carmo-coelho',
    name: 'Creche/CMEI Maria do Carmo Coelho',
    street: 'Rua Floriano Queiroz Coutinho',
    number: null,
    district: 'Barra Grande',
    city: 'Maragogi',
    state: DEMO_STATE,
    zone: null,
    sections: ['149', '150'],
    source: TRE_AL_2026,
  },

  /* ------------------------- Lagoa da Canoa ------------------------- */
  {
    id: 'lagoa-da-canoa-manoel-pereira-filho',
    name: 'Grupo Escolar Manoel Pereira Filho',
    street: 'Avenida João Angelino dos Santos',
    number: null,
    district: null,
    city: 'Lagoa da Canoa',
    state: DEMO_STATE,
    zone: null,
    sections: ['169', '170', '171', '172', '173', '174'],
    source: TRE_AL_2026,
  },

  /* ----------------------- Limoeiro de Anadia ----------------------- */
  {
    id: 'limoeiro-cei-edite-barbosa',
    name: 'CEI Edite Barbosa de Almeida',
    street: 'Rua Projetada',
    number: null,
    district: 'Alto do Cruzeiro',
    city: 'Limoeiro de Anadia',
    state: DEMO_STATE,
    zone: null,
    sections: ['100', '101', '102', '103', '104', '105', '114', '115', '118', '119'],
    source: TRE_AL_2026,
  },

  /* ---------------------------- Junqueiro --------------------------- */
  {
    id: 'junqueiro-maria-dinaura-de-alcantara',
    name: 'Escola Municipal EB Maria Dinaura de Alcantara',
    street: null,
    number: null,
    district: 'Povoado Palmeirinha',
    city: 'Junqueiro',
    state: DEMO_STATE,
    zone: null,
    sections: ['261', '262', '263'],
    source: TRE_AL_2026,
  },

  /* ---------------------------- Pariconha --------------------------- */
  {
    id: 'pariconha-nova-escola-estadual',
    name: 'Nova Escola Estadual de Pariconha',
    street: 'Travessa Francisco Souza',
    number: '377',
    district: null,
    city: 'Pariconha',
    state: DEMO_STATE,
    zone: null,
    sections: ['53', '62'],
    source: TRE_AL_2026,
  },

  /* -------------------------- Paulo Jacinto ------------------------- */
  {
    id: 'paulo-jacinto-souza-barbosa',
    name: 'Escola 1º e 2º Graus Souza Barbosa',
    street: 'Rua São José',
    number: null,
    district: 'Centro',
    city: 'Paulo Jacinto',
    state: DEMO_STATE,
    zone: null,
    sections: ['116'],
    source: TRE_AL_2026,
  },
];

/** Municipios presentes no catalogo, na ordem em que aparecem. */
export const DEMO_CITIES: readonly string[] = [
  ...new Set(DEMO_POLLING_PLACES.map((place) => place.city)),
];

/**
 * Enderecos de moradia do Time DEMO.
 *
 * Sao os MESMOS logradouros reais dos locais de votacao acima, sem numero: o
 * sistema so guarda rua, bairro, municipio e UF de um integrante, e o ponto
 * mostrado no mapa e o da RUA, nunca o da casa. Reaproveitar os logradouros
 * ja conferidos evita inventar endereco novo — e faz as pessoas morarem no
 * mesmo municipio em que votam, como na vida real.
 *
 * Entram apenas os locais cuja RUA foi publicada: sem logradouro nao ha
 * endereco de moradia, e um bairro solto viraria um ponto no meio do bairro
 * para todo mundo.
 */
export interface DemoAddress {
  id: string;
  street: string;
  district: string | null;
  city: string;
  state: typeof DEMO_STATE;
  source: string;
}

export const DEMO_ADDRESSES: readonly DemoAddress[] = DEMO_POLLING_PLACES.filter(
  (place): place is DemoPollingPlace & { street: string } => Boolean(place.street),
).map((place) => ({
  id: `end-${place.id}`,
  street: place.street,
  district: place.district,
  city: place.city,
  state: place.state,
  source: place.source,
}));

/** Enderecos de moradia daquele municipio. Vazio quando nao ha nenhum. */
export function addressesInCity(city: string): readonly DemoAddress[] {
  return DEMO_ADDRESSES.filter((address) => address.city === city);
}

/* -------------------------------------------------------------------------
   Barreiras de coordenada
   ------------------------------------------------------------------------- */

/** Numero utilizavel como coordenada: existe e e finito. */
function isRealNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** O ponto esta dentro do retangulo de Alagoas? */
export function isInAlagoas(latitude: number | null, longitude: number | null): boolean {
  if (!isRealNumber(latitude) || !isRealNumber(longitude)) return false;

  return (
    latitude >= ALAGOAS_BOUNDS.minLat &&
    latitude <= ALAGOAS_BOUNDS.maxLat &&
    longitude >= ALAGOAS_BOUNDS.minLng &&
    longitude <= ALAGOAS_BOUNDS.maxLng
  );
}

/**
 * Coordenada aceita para um Time DEMO.
 *
 * Recusa nula, NaN, `0,0` (a "ilha nula" no golfo da Guine, para onde vai
 * todo campo esquecido) e qualquer ponto fora de Alagoas. Deslocamento
 * aleatorio nao entra nesta conta porque deixou de existir: nenhuma
 * coordenada do Time DEMO e calculada.
 */
export function isUsableDemoCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!isRealNumber(latitude) || !isRealNumber(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  return isInAlagoas(latitude, longitude);
}
