import { isValidCpf } from '@/lib/utils/documents';
import { normalizePhone } from '@/lib/utils/phone';
import {
  DEMO_ADDRESSES,
  DEMO_POLLING_PLACES,
  DEMO_STATE,
  type DemoAddress,
  type DemoPollingPlace,
} from './demo-catalog';

/**
 * Dados do Time DEMO.
 *
 * Modulo PURO: nao toca no banco, nao sorteia nada de verdade e nao chama
 * servico externo nenhum. Recebe uma semente e devolve sempre o mesmo
 * conjunto — e por isso ele pode ser conferido por teste, que e onde a
 * coerencia dos numeros e garantida antes de existir uma linha no banco.
 *
 * AS PESSOAS sao ficticias: nome montado a partir de listas, telefone de uma
 * faixa de demonstracao, genero distribuido. Nao existe CPF, titulo de
 * eleitor, e-mail nem retorno de consulta cadastral — nenhum dado de pessoa
 * real entra em um Time DEMO.
 *
 * OS LUGARES NAO SAO. Escola, rua, bairro, municipio, UF, zona e secao vem
 * do catalogo (`demo-catalog.ts`), que so tem local de votacao REAL de
 * Alagoas, divulgado pelo TRE/AL, com a fonte anotada. Antes eu inventava os
 * tres — e o resultado foi um mapa em Recife com pinos no mar.
 *
 * COORDENADA NAO SE ESCREVE AQUI, e nao se calcula em lugar nenhum: este
 * modulo nao devolve latitude nem longitude. Quem as obtem e o servidor,
 * pelo MESMO caminho que ja poe um integrante real no mapa, e o resultado
 * fica no cache de coordenadas do sistema.
 */

/**
 * Marca do ponto semeado no cache de coordenadas (migration 033).
 *
 * HERANCA. Nenhuma coordenada nova nasce com esta marca: as do Time DEMO vem
 * hoje da consulta de endereco do proprio sistema, e por isso sao gravadas
 * como a consulta que realmente aconteceu. A marca continua existindo para
 * uma coisa so — reconhecer, e limpar, os pontos que a versao anterior do
 * gerador escreveu de memoria.
 */
export const DEMO_PROVIDER = 'DEMO_SEED';

/**
 * Valores iniciais do formulario de criacao. O ADMIN pode alterar.
 *
 * Um time pequeno demais nao demonstra nada: com trinta pessoas em seis
 * escolas o mapa fica ralo, o ranking de locais empata em tudo e o grafico
 * vira uma linha reta. Com a tabela oficial do TSE carregada, as escolas
 * deixaram de ser o gargalo — sao centenas, de graca e com coordenada
 * oficial —, entao o padrao e um time com cara de operacao estadual: seiscentas
 * pessoas em sessenta escolas, espalhadas por varios municipios. Sem a tabela,
 * o catalogo conferido limita os locais sozinho.
 */
export const DEMO_DEFAULTS = { people: 600, places: 60 } as const;

/**
 * Limites conferidos no servidor, e nao apenas na tela.
 *
 * Eles existem para uma apresentacao nao virar uma carga de milhares de
 * linhas por engano — e valem para o que e GERADO automaticamente.
 *
 * Administrador nao entra nesta lista de proposito: quem os cadastra e o
 * ADMIN geral, um por um, e nao ha numero certo de administradores para um
 * time. Cada um continua passando pelas mesmas regras de nome, telefone e
 * telefone unico no time.
 */
export const DEMO_LIMITS = {
  minPeople: 1,
  // Cinco mil: um time de porte real, para a apresentacao mostrar as telas
  // cheias de verdade. As escritas vao em lotes (`insertRowsInChunks`), que e
  // o que torna esse tamanho possivel sem estourar o corpo da requisicao.
  maxPeople: 5000,
  minPlaces: 1,
  // O teto de verdade e quantas escolas existem na fonte: a tabela oficial do
  // TSE (centenas em Alagoas) ou, sem ela, o catalogo conferido. Este numero
  // so existe para o servidor nao aceitar um valor absurdo vindo da tela — e
  // para o mapa continuar legivel.
  maxPlaces: 400,
} as const;

/* -------------------------------------------------------------------------
   Sorteio reproduzivel
   ------------------------------------------------------------------------- */

/** Hash simples da semente, para o gerador comecar sempre no mesmo ponto. */
function seedNumber(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Gerador determinístico (mulberry32).
 *
 * A mesma semente devolve o mesmo Time DEMO. Isso nao e detalhe: e o que
 * permite ao teste afirmar como os dados ficam distribuidos, em vez de
 * apenas contar linhas.
 */
export function createRandom(seed: string): () => number {
  let state = seedNumber(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length) % list.length];
}

/* -------------------------------------------------------------------------
   Listas ficticias
   ------------------------------------------------------------------------- */

/**
 * Nomes proprios e sobrenomes comuns no Nordeste.
 *
 * As listas sao grandes o bastante para um time de centenas de pessoas nao
 * repetir nome — nada aqui pertence a ninguem: sao nomes correntes,
 * combinados por sorteio, sem qualquer vinculo com pessoa real.
 */
const PRIMEIROS_NOMES = [
  'Adriana', 'Alaíde', 'Aldemir', 'Ana', 'Antônio', 'Benedita', 'Bruno',
  'Carla', 'Cícero', 'Cláudia', 'Damião', 'Daniel', 'Edvaldo', 'Elenilda',
  'Eliane', 'Fábio', 'Francisca', 'Gabriela', 'Genivaldo', 'Geraldo',
  'Givaldo', 'Heitor', 'Inácio', 'Isabel', 'Ivanildo', 'Jaqueline', 'João',
  'Joelma', 'José', 'Josefa', 'Josivaldo', 'Karina', 'Lucas', 'Luciene',
  'Manoel', 'Marcos', 'Maria', 'Marinalva', 'Marina', 'Nelson', 'Neide',
  'Olívia', 'Patrícia', 'Paulo', 'Quitéria', 'Rafael', 'Raimunda',
  'Rosineide', 'Sebastião', 'Severino', 'Silvana', 'Sônia', 'Tarcísio',
  'Tiago', 'Valdemir', 'Vanderlei', 'Verônica', 'Vinícius', 'Wagner',
  'Zenaide',
] as const;

const SOBRENOMES = [
  'Albuquerque', 'Almeida', 'Alves', 'Amorim', 'Andrade', 'Barbosa', 'Barros',
  'Bezerra', 'Brandão', 'Calheiros', 'Cardoso', 'Cavalcante', 'Correia',
  'Costa', 'Duarte', 'Falcão', 'Ferreira', 'Firmino', 'Gomes', 'Gonçalves',
  'Lima', 'Lins', 'Lopes', 'Lyra', 'Macedo', 'Malta', 'Martins', 'Melo',
  'Mendonça', 'Moura', 'Nogueira', 'Nunes', 'Oliveira', 'Pacheco', 'Peixoto',
  'Pereira', 'Pimentel', 'Ramos', 'Rocha', 'Sampaio', 'Santos', 'Silva',
  'Siqueira', 'Soares', 'Tenório', 'Teixeira', 'Vasconcelos', 'Veríssimo',
  'Vieira', 'Wanderley',
] as const;

/** Distribuicao do genero, na ordem em que as pessoas sao geradas. */
const GENEROS = ['MULHER', 'HOMEM', 'MULHER', 'HOMEM', 'NAO_INFORMAR'] as const;

export type DemoGender = (typeof GENEROS)[number];

/* -------------------------------------------------------------------------
   Formato do resultado
   ------------------------------------------------------------------------- */

/**
 * Local de votacao escolhido para o Time DEMO.
 *
 * E uma entrada do catalogo, e nao um lugar novo: nome, endereco, bairro,
 * municipio, UF, zona e secoes vem de la, ja conferidos. Sem coordenada — o
 * servidor a resolve pelo endereco, como faz com qualquer integrante real.
 */
export interface DemoPlace {
  place: DemoPollingPlace;
  /** Zona eleitoral verificada, ou nula quando a fonte nao a publicou. */
  zone: string | null;
  /** Secoes verificadas. Vazio quando a fonte nao as publicou. */
  sections: readonly string[];
}

/**
 * Endereco de moradia de demonstracao.
 *
 * Sai dos MESMOS logradouros conferidos dos locais de votacao, e sempre no
 * municipio em que a pessoa vota. Quando a divulgacao daquele municipio nao
 * trouxe rua nenhuma, a moradia fica no bairro ou no proprio municipio — que
 * e o que o sistema ja faz com um cadastro real de endereco incompleto, e
 * bem melhor do que inventar uma rua.
 */
export interface DemoResidence {
  street: string | null;
  district: string | null;
  city: string;
  state: typeof DEMO_STATE;
}

/** Pessoa ficticia, com tudo o que as telas do sistema usam. */
export interface DemoPerson {
  name: string;
  phone: string;
  gender: DemoGender;
  /** Endereco declarado. Nulos quando a fonte do municipio nao os trouxe. */
  street: string | null;
  district: string | null;
  city: string;
  state: typeof DEMO_STATE;
  /**
   * Zona e secao do local onde a pessoa vota.
   *
   * Nulas quando o TRE/AL nao publicou zona ou secao daquele local. A tela
   * mostra "sem zona/secao", que e a verdade — inventar um numero aqui
   * falsificaria a quebra por secao do mapa.
   */
  zone: string | null;
  section: string | null;
  /** Endereco (e coordenada) da moradia, por posicao em `residences`. */
  residenceIndex: number;
  /** Local de votacao, por posicao em `places`. */
  placeIndex: number;
  /** Administrador do time que aparece em "Cadastrado por". */
  adminIndex: number;
  /** Opcao de vinculo do formulario, por posicao. */
  relationshipIndex: number;
  /** Instante do cadastro, em ISO. */
  createdAt: string;
}

export interface DemoData {
  /** Municipios alcancados pelo time, na ordem do catalogo. */
  cities: string[];
  state: typeof DEMO_STATE;
  places: DemoPlace[];
  residences: DemoResidence[];
  people: DemoPerson[];
}

export interface DemoInput {
  /** Semente: o mesmo valor devolve exatamente o mesmo time. */
  seed: string;
  people: number;
  places: number;
  /**
   * Quantos administradores o time tem: as pessoas se dividem entre todos,
   * sejam dois ou vinte. Nao ha limite.
   */
  admins: number;
  /** Telefones ja usados no time (os dos administradores). */
  usedPhones?: readonly string[];
  /**
   * Locais de votacao disponiveis, na ordem de escolha.
   *
   * Sem isto, o catalogo conferido (`DEMO_POLLING_PLACES`). Com a tabela
   * oficial do TSE carregada, o servidor passa aqui as escolas que sorteou
   * dela (`demo-tse.ts`) — sempre locais reais, nunca inventados.
   */
  catalog?: readonly DemoPollingPlace[];
  /**
   * Enderecos de moradia disponiveis. Sem isto, os do catalogo conferido.
   * Sempre filtrados pelo municipio de quem mora: quem vota em Arapiraca nao
   * mora em Penedo.
   */
  addresses?: readonly DemoAddress[];
  /** Agora. Recebido de fora para o teste poder fixar o relogio. */
  now?: Date;
}

/** Mantem a quantidade dentro dos limites aceitos pelo servidor. */
export function clampCount(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/* -------------------------------------------------------------------------
   Datas
   ------------------------------------------------------------------------- */

const DIA = 24 * 60 * 60 * 1000;

/**
 * Distribui os cadastros entre hoje, os ultimos sete dias e o mes atual.
 *
 * Os tres indicadores da tela leem os MESMOS registros, entao a distribuicao
 * precisa cair dentro das tres janelas de verdade — e nunca no futuro nem
 * antes do inicio do mes, ou os numeros de "hoje", "7 dias" e "este mes"
 * deixariam de fechar entre si.
 */
function spreadDate(index: number, total: number, now: Date): string {
  const inicioDoMes = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const agora = now.getTime();

  // Uma em cada cinco no dia de hoje; uma em cada cinco nos seis dias
  // anteriores; o restante espalhado pelo mes.
  const posicao = index % 5;
  let alvo: number;

  if (posicao === 0) {
    // Hoje, em horas ja passadas.
    const horas = 1 + (index % 8);
    alvo = agora - horas * 60 * 60 * 1000;
  } else if (posicao === 1 || posicao === 2) {
    alvo = agora - (1 + (index % 6)) * DIA;
  } else {
    alvo = agora - (7 + (index % 20)) * DIA;
  }

  // Nunca antes do inicio do mes: os indicadores do mes contam estes mesmos
  // registros, e um cadastro do mes passado sumiria do total mensal.
  const limitado = Math.max(alvo, inicioDoMes + (index % 60) * 60 * 1000);
  return new Date(Math.min(limitado, agora - 60 * 1000)).toISOString();
}

/* -------------------------------------------------------------------------
   Geracao
   ------------------------------------------------------------------------- */

/**
 * Telefone de demonstracao.
 *
 * Faixa fixa e sequencial (9 8000 0000 + posicao), para os numeros nunca se
 * repetirem dentro do time e para serem reconheciveis como ficticios ao
 * lado de um numero real. O DDD e o de Alagoas.
 */
const DDD_ALAGOAS = '82';

function demoPhone(position: number): string {
  const sufixo = String(80000000 + position).padStart(8, '0');
  return `${DDD_ALAGOAS}9${sufixo}`;
}

/**
 * O telefone esta livre para uso?
 *
 * Duas recusas. A primeira e obvia: numero ja usado no time, inclusive pelos
 * administradores — duas pessoas entrariam pelo mesmo numero.
 *
 * A segunda so aparece em time grande, e foi um teste que a encontrou: um
 * telefone de onze digitos as vezes passa na validacao de CPF por acaso. Em
 * uma tela de apresentacao, um numero desses copiado de uma ficha vira um CPF
 * aparentemente valido que nao pertence a ninguem. O Time DEMO nao grava
 * documento nenhum, e nao vai gerar um por acidente.
 */
function phoneIsFree(phone: string, taken: ReadonlySet<string>): boolean {
  return !taken.has(phone) && !isValidCpf(phone);
}

/**
 * Reparte as pessoas entre os locais, com peso.
 *
 * Divisao igual e o jeito mais rapido de a demonstracao parecer falsa: o
 * ranking "onde voce tem mais votos" empata em tudo e o mapa vira um tabuleiro
 * regular. Aqui cada local recebe um peso sorteado pela semente, e as pessoas
 * se dividem em proporcao a ele — com PISO DE UM: nenhum local do catalogo
 * fica vazio, ou a tela mostraria uma escola sem ninguem.
 *
 * O resto da divisao vai para os maiores restos, desempatando pela posicao:
 * a soma fecha exatamente com o total, sempre, e a mesma semente reparte
 * sempre igual.
 */
function shareByWeight(total: number, weights: readonly number[]): number[] {
  const locais = weights.length;
  const sobrando = total - locais;
  if (sobrando <= 0) return weights.map(() => 1);

  const soma = weights.reduce((acumulado, peso) => acumulado + peso, 0);
  const exatos = weights.map((peso) => (sobrando * peso) / soma);
  const cotas = exatos.map((valor) => Math.floor(valor));

  const ordem = exatos
    .map((valor, index) => ({ index, resto: valor - Math.floor(valor) }))
    .sort((a, b) => b.resto - a.resto || a.index - b.index);

  let faltam = sobrando - cotas.reduce((acumulado, cota) => acumulado + cota, 0);
  for (let passo = 0; faltam > 0; passo += 1, faltam -= 1) {
    cotas[ordem[passo % locais].index] += 1;
  }

  return cotas.map((cota) => cota + 1);
}

/** Embaralha sem aleatoriedade de verdade: a mesma semente, a mesma ordem. */
function shuffle<T>(random: () => number, list: T[]): T[] {
  const copia = [...list];
  for (let index = copia.length - 1; index > 0; index -= 1) {
    const troca = Math.floor(random() * (index + 1));
    [copia[index], copia[troca]] = [copia[troca], copia[index]];
  }
  return copia;
}

/**
 * Enderecos de moradia possiveis para quem vota naquele local.
 *
 * Sempre no MESMO municipio: quem vota em Arapiraca nao mora em Penedo. Sem
 * nenhuma rua publicada naquele municipio, a moradia fica no bairro do
 * proprio local — ou so no municipio, quando nem bairro houve.
 */
function residencesFor(
  place: DemoPollingPlace,
  addresses: readonly DemoAddress[],
): DemoResidence[] {
  const doMunicipio = addresses.filter((address) => address.city === place.city);
  if (doMunicipio.length > 0) {
    return doMunicipio.map((address) => ({
      street: address.street,
      district: address.district,
      city: address.city,
      state: address.state,
    }));
  }

  return [{ street: null, district: place.district, city: place.city, state: place.state }];
}

export function buildDemoData(input: DemoInput): DemoData {
  const random = createRandom(input.seed);
  const now = input.now ?? new Date();

  const totalPessoas = clampCount(input.people, DEMO_LIMITS.minPeople, DEMO_LIMITS.maxPeople);
  const totalAdmins = Math.max(1, Math.trunc(input.admins) || 1);

  // Locais: os do catalogo, na ordem em que estao la — capital, maior
  // municipio do interior, agreste, sertao e litoral. O teto nao e escolha de
  // estilo: nao existe local de votacao alem dos conferidos, e inventar o
  // proximo seria voltar ao erro que gerou o mapa em Recife. E nunca mais
  // locais do que pessoas, senao sobraria escola sem ninguem.
  const catalogo = input.catalog && input.catalog.length > 0 ? input.catalog : DEMO_POLLING_PLACES;
  const enderecos = input.addresses ?? DEMO_ADDRESSES;
  const totalLocais = Math.min(
    clampCount(input.places, DEMO_LIMITS.minPlaces, DEMO_LIMITS.maxPlaces),
    catalogo.length,
    totalPessoas,
  );

  const escolhidos = catalogo.slice(0, totalLocais);
  const places: DemoPlace[] = escolhidos.map((place) => ({
    place,
    zone: place.zone,
    sections: place.sections,
  }));

  // Uma coordenada por endereco, compartilhada por quem mora nele — e o
  // comportamento do cache real, e e o que faz os pinos se agruparem no mapa
  // em vez de virar um borrao de pontos soltos.
  const residences: DemoResidence[] = [];
  const porChave = new Map<string, number>();
  /** Enderecos disponiveis para cada local, por posicao em `residences`. */
  const moradiasDoLocal: number[][] = escolhidos.map((place) =>
    residencesFor(place, enderecos).map((moradia) => {
      const chave = `${moradia.street ?? ''}|${moradia.district ?? ''}|${moradia.city}`;
      const existente = porChave.get(chave);
      if (existente !== undefined) return existente;

      porChave.set(chave, residences.length);
      residences.push(moradia);
      return residences.length - 1;
    }),
  );

  // Peso de cada local: e ele que faz o ranking de locais ter topo e base,
  // como em uma operacao real. Escola da tabela oficial pesa tambem pelo
  // tamanho: um colegio de trinta secoes recebe mais gente do que uma escola
  // rural de duas, como na vida real.
  const pesos = escolhidos.map((place) => {
    const sorteado = 1 + Math.floor(random() * 6);
    if (!place.officialId) return sorteado;
    return sorteado * Math.max(1, Math.round(Math.sqrt(place.sections.length)));
  });
  const cotas = shareByWeight(totalPessoas, pesos);

  // As pessoas de um mesmo local nao podem nascer em sequencia: as datas de
  // cadastro sao espalhadas pela POSICAO, e um bloco inteiro cairia todo no
  // mesmo dia — "hoje" seria uma escola so.
  const sorteio = shuffle(
    random,
    cotas.flatMap((cota, placeIndex) => Array.from({ length: cota }, () => placeIndex)),
  );

  const ocupados = new Set((input.usedPhones ?? []).map((phone) => normalizePhone(phone)));
  const usados = new Set<string>();
  const people: DemoPerson[] = [];
  let posicaoTelefone = 1;

  sorteio.forEach((placeIndex, index) => {
    const escolhido = places[placeIndex];
    const opcoes = moradiasDoLocal[placeIndex];
    const residenceIndex = opcoes[index % opcoes.length];
    const morada = residences[residenceIndex];

    // Telefone livre: nunca repete o de um administrador do proprio time,
    // senao duas pessoas entrariam pelo mesmo numero.
    let phone = demoPhone(posicaoTelefone);
    while (!phoneIsFree(phone, ocupados)) {
      posicaoTelefone += 1;
      phone = demoPhone(posicaoTelefone);
    }
    ocupados.add(phone);
    posicaoTelefone += 1;

    // Nome inedito no time. Nome e sobrenome dao algumas milhares de
    // combinacoes — pouco para um time de cinco mil pessoas, entao, quando a
    // combinacao simples ja existe, entra um SEGUNDO sobrenome, que e como
    // meio Brasil se chama mesmo. O espaco cresce cinquenta vezes, e a lista
    // de apresentacao para de ter xara.
    let name = `${pick(random, PRIMEIROS_NOMES)} ${pick(random, SOBRENOMES)}`;
    for (let tentativa = 0; usados.has(name) && tentativa < 8; tentativa += 1) {
      name = `${pick(random, PRIMEIROS_NOMES)} ${pick(random, SOBRENOMES)}`;
    }
    for (let tentativa = 0; usados.has(name) && tentativa < 24; tentativa += 1) {
      name =
        `${pick(random, PRIMEIROS_NOMES)} ${pick(random, SOBRENOMES)} ` +
        `${pick(random, SOBRENOMES)}`;
    }
    usados.add(name);

    // Secao so quando a fonte publicou as do local. Sem isso, nula.
    const section =
      escolhido.sections.length > 0
        ? escolhido.sections[index % escolhido.sections.length]
        : null;

    people.push({
      name,
      phone,
      gender: GENEROS[index % GENEROS.length],
      street: morada.street,
      district: morada.district,
      city: morada.city,
      state: DEMO_STATE,
      zone: escolhido.zone,
      section,
      residenceIndex,
      placeIndex,
      adminIndex: index % totalAdmins,
      relationshipIndex: index % 3,
      createdAt: spreadDate(index, totalPessoas, now),
    });
  });

  return {
    cities: [...new Set(escolhidos.map((place) => place.city))],
    state: DEMO_STATE,
    places,
    residences,
    people,
  };
}
