import type { Member } from '@/lib/types';
import type { MapOverviewPayload, PlaceMember, PlaceMembersPayload, PollingPlacePin } from '@/lib/domain/map-pin';
import type { MapQuery } from '@/lib/domain/map-filters';
import { pessoasPorEscola, rankingDeLideres, rankingDeVotos } from '@/lib/domain/votos-por-lideranca';
import {
  lideresDaEscola,
  lideresNoRaioX,
  type Comparativo,
  type Confronto,
  type EscolaNoComparativo,
  type LiderNaEscola,
  type LiderNoRaioX,
} from '@/lib/domain/confronto';
import { fotoDoCandidatoUrl, type CandidatoDaVotacao, type VotacaoNoMapa } from '@/lib/domain/votacao-tse';
import { relatorioDeZeradas, type SecoesDoMunicipioPayload } from '@/lib/domain/secoes-zeradas';
import { relatorioDeGente, votosPorSecao } from '@/lib/domain/secoes-com-gente';
import { api } from '@/lib/repositories/http/api';
import { baixarArquivo } from '@/lib/utils/download';

/**
 * Os PDFs que saem do mapa, baixados de verdade (arquivo), e nao pela janela
 * de impressao. O gerador do PDF so e carregado no clique.
 */

/** Nome de arquivo sem acento nem espaco. */
function slug(texto: string): string {
  return (
    texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'local'
  );
}

/** Todas as pessoas que votam no local, pagina por pagina (o servidor limita a 50). */
async function todasAsPessoas(
  place: Pick<PollingPlacePin, 'locationId'>,
  clientId?: string,
  /** Filtro "Lider" do mapa: so quem ele cadastrou. */
  leaderId?: string | null,
): Promise<PlaceMember[]> {
  const pessoas: PlaceMember[] = [];
  for (let pagina = 1; pagina <= 200; pagina += 1) {
    const params = new URLSearchParams({ pagina: String(pagina), tamanho: '50' });
    if (clientId) params.set('time', clientId);
    if (leaderId) params.set('lider', leaderId);
    const lote = await api<PlaceMembersPayload>(`/api/mapa/locais/${place.locationId}/integrantes?${params}`);
    pessoas.push(...lote.items);
    if (pessoas.length >= lote.total || lote.items.length === 0) break;
  }
  return pessoas;
}

/** "escola-estadual-prof-elza-soares.pdf": o nome da escola no arquivo. */
export async function baixarPdfDaEscola(place: PollingPlacePin, clientId?: string, leaderId?: string | null): Promise<void> {
  const [pessoas, { gerarPdfDaEscola }] = await Promise.all([
    todasAsPessoas(place, clientId, leaderId),
    import('@/components/neo/MapaPdf'),
  ]);
  const blob = await gerarPdfDaEscola({ escola: place, pessoas, geradoEm: new Date().toISOString() });
  baixarArquivo(`${slug(place.title ?? 'local-de-votacao')}.pdf`, blob);
}

/** O recorte do mapa em palavras, para o PDF dizer de que pedaco ele fala. */
function recorteEmPalavras(query: MapQuery | null, places: readonly PollingPlacePin[] = []): string | null {
  if (!query) return null;
  // Com o filtro de Lider, cada pino ja vem so com ele em `leaders`.
  const lider = query.leader ? places.find((p) => p.leaders?.length)?.leaders?.[0]?.name : null;
  const partes = [
    lider ? `Líder ${lider}` : null,
    query.zone ? `Zona ${query.zone}` : null,
    query.section ? `Seção ${query.section.split('/')[1]}${query.zone ? '' : ` (zona ${query.section.split('/')[0]})`}` : null,
    query.city,
    query.cities?.length ? (query.cities.length === 1 ? query.cities[0] : `Municípios: ${query.cities.join(', ')}`) : null,
    query.state,
    query.minVotes > 0 ? `a partir de ${query.minVotes} votos` : null,
    query.search.trim() ? `busca "${query.search.trim()}"` : null,
  ].filter(Boolean);
  return partes.length ? partes.join(' · ') : null;
}

const dataDoArquivo = () => new Date().toISOString().slice(0, 10);

/** "Onde voce tem mais votos", com o mesmo recorte que esta na tela. */
export async function baixarPdfDoRankingDeVotos(
  places: readonly PollingPlacePin[],
  query: MapQuery | null,
  time: string,
): Promise<void> {
  const { gerarPdfDoRankingDeVotos } = await import('@/components/neo/MapaPdf');
  const blob = await gerarPdfDoRankingDeVotos({
    ranking: rankingDeVotos(places, query?.zone ?? null),
    filtro: recorteEmPalavras(query, places),
    geradoEm: new Date().toISOString(),
  });
  baixarArquivo(`onde-tem-mais-votos_${slug(time)}_${dataDoArquivo()}.pdf`, blob);
}

/**
 * A votacao oficial de um candidato (TSE): locais, zonas e secoes, com o
 * mesmo recorte do mapa. Entram tambem as escolas sem coordenada, que nao
 * viram pino mas tiveram voto.
 */
export async function baixarPdfDaVotacao(
  places: readonly PollingPlacePin[],
  query: MapQuery | null,
  candidato: { rotulo: string; nome: string; numero: string },
): Promise<void> {
  const { gerarPdfDoRankingDeVotos } = await import('@/components/neo/MapaPdf');
  const blob = await gerarPdfDoRankingDeVotos({
    ranking: rankingDeVotos(places, query?.zone ?? null),
    filtro: recorteEmPalavras(query),
    geradoEm: new Date().toISOString(),
    votacao: candidato.rotulo,
  });
  baixarArquivo(`votacao_${slug(candidato.nome)}-${candidato.numero}_${dataDoArquivo()}.pdf`, blob);
}

/**
 * Quem vota em cada local do ranking: a pessoa, a zona, a secao e o Lider.
 *
 * As pessoas vem da mesma lista do "Ver pessoas", local por local — poucos
 * de cada vez, para nao despejar centenas de pedidos de uma vez no servidor.
 */
export async function baixarPdfDasPessoasPorEscola(
  places: readonly PollingPlacePin[],
  query: MapQuery | null,
  time: string,
  clientId?: string,
): Promise<void> {
  const ranking = rankingDeVotos(places, query?.zone ?? null);
  const [porLocal, { gerarPdfDasPessoasPorEscola }] = await Promise.all([
    pessoasDosLocais(ranking.escolas.map((e) => e.place), clientId, query?.leader),
    import('@/components/neo/MapaPdf'),
  ]);
  const blob = await gerarPdfDasPessoasPorEscola({
    lista: pessoasPorEscola(ranking, porLocal, query?.zone ?? null),
    filtro: recorteEmPalavras(query, places),
    geradoEm: new Date().toISOString(),
  });
  baixarArquivo(`quem-vota-em-cada-local_${slug(time)}_${dataDoArquivo()}.pdf`, blob);
}

/** As pessoas de varios locais, com no maximo `simultaneos` pedidos no ar. */
async function pessoasDosLocais(
  places: readonly Pick<PollingPlacePin, 'locationId'>[],
  clientId?: string,
  leaderId?: string | null,
  simultaneos = 6,
): Promise<Map<string, PlaceMember[]>> {
  const porLocal = new Map<string, PlaceMember[]>();
  let proximo = 0;
  async function trabalhar() {
    while (proximo < places.length) {
      const place = places[proximo];
      proximo += 1;
      porLocal.set(place.locationId, await todasAsPessoas(place, clientId, leaderId));
    }
  }
  await Promise.all(Array.from({ length: Math.min(simultaneos, places.length) }, trabalhar));
  return porLocal;
}

/**
 * Ranking dos Lideres, e de cada um: onde a Equipe vota. As escolas vem do
 * mapa do time (a secao do cadastro aponta o local), lido na hora do clique.
 */
export async function baixarPdfDoRankingDeLideres({
  time,
  clientId,
  members,
}: {
  time: string;
  clientId: string;
  members: readonly Member[];
}): Promise<void> {
  const [mapa, { gerarPdfDoRankingDeLideres }] = await Promise.all([
    api<MapOverviewPayload>(`/api/mapa?clientId=${encodeURIComponent(clientId)}`),
    import('@/components/neo/MapaPdf'),
  ]);
  const blob = await gerarPdfDoRankingDeLideres({
    ranking: rankingDeLideres(members, mapa.pollingPlaces),
    geradoEm: new Date().toISOString(),
  });
  baixarArquivo(`ranking-dos-lideres_${slug(time)}_${dataDoArquivo()}.pdf`, blob);
}

/**
 * Estimativa x apuracao: todas as escolas do time com o candidato escolhido
 * — o que o time esperava e o que o candidato teve, escola, zona e secao.
 */
export async function baixarPdfDoConfronto({
  confronto,
  candidato,
  time,
  clientId,
  fotoDe,
}: {
  confronto: Confronto;
  candidato: { rotulo: string; nome: string; numero: string };
  /** So no nome do arquivo. */
  time: string;
  /** O time do mapa: a lista de pessoas de cada escola fica nele. */
  clientId?: string;
  /** Para a foto oficial na capa (pelo numero de urna). */
  fotoDe?: Pick<CandidatoDaVotacao, 'cargoCodigo' | 'numero' | 'ano'>;
}): Promise<void> {
  // Quem cada Lider cadastrou em cada escola do time: a mesma lista do
  // "Ver pessoas", lida escola por escola (poucas de cada vez).
  const pinos = [...new Set(confronto.doTime.flatMap((e) => e.pinosDaCampanha))].map((locationId) => ({ locationId }));
  const [porPino, { gerarPdfDoConfronto }, foto] = await Promise.all([
    pessoasDosLocais(pinos, clientId),
    import('@/components/neo/ConfrontoPdf'),
    fotoDe ? fotoComoDataUrl(fotoDe) : Promise.resolve(null),
  ]);
  const lideres: Record<string, LiderNaEscola[]> = {};
  for (const escola of confronto.doTime) {
    const pessoas = escola.pinosDaCampanha.flatMap((id) => porPino.get(id) ?? []);
    lideres[escola.chave] = lideresDaEscola(
      escola,
      pessoas.map((p) => ({ nome: p.name, zona: p.zone, secao: p.section, lider: p.lider, ehLider: p.tier === 'LIDER' })),
    );
  }
  const blob = await gerarPdfDoConfronto({
    confronto,
    candidato: candidato.rotulo,
    candidatoNome: candidato.nome,
    lideres,
    foto,
    geradoEm: new Date().toISOString(),
  });
  baixarArquivo(`estimativa-x-apuracao_${slug(candidato.nome)}-${candidato.numero}_${slug(time)}_${dataDoArquivo()}.pdf`, blob);
}

/**
 * A foto oficial do candidato como data URL, pronta para o PDF. Nula quando
 * nao ha foto (outro ano, cargo sem foto, TSE fora): o PDF usa as iniciais.
 */
async function fotoComoDataUrl(c: Pick<CandidatoDaVotacao, 'cargoCodigo' | 'numero' | 'ano'>): Promise<string | null> {
  return urlComoDataUrl(fotoDoCandidatoUrl(c));
}

/** Qualquer foto do proprio sistema (pelo endereco) como data URL para o PDF. */
async function urlComoDataUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const resposta = await fetch(url, { credentials: 'same-origin' });
    const tipo = resposta.headers.get('content-type') ?? '';
    // O gerador do PDF so le JPEG e PNG.
    if (!resposta.ok || !/image\/(jpe?g|png)/.test(tipo)) return null;
    const blob = await resposta.blob();
    return await new Promise<string | null>((resolve) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(typeof leitor.result === 'string' ? leitor.result : null);
      leitor.onerror = () => resolve(null);
      leitor.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Varios candidatos no mesmo PDF: a estimativa do time contra os votos de
 * cada um, escola, zona e secao, com quantas pessoas cada Lider cadastrou em
 * cada escola e secao (os pinos da campanha ja trazem isso) e a foto oficial
 * de cada candidato.
 */
export async function baixarPdfDoComparativo({
  comparativo,
  candidatos,
  campanha,
  time,
}: {
  comparativo: Comparativo;
  candidatos: { candidato: CandidatoDaVotacao; cor: string }[];
  /** As escolas da campanha (sem filtro): e delas que saem os Lideres. */
  campanha: readonly PollingPlacePin[];
  /** So no nome do arquivo. */
  time: string;
}): Promise<void> {
  const [{ gerarPdfDoComparativo }, fotos] = await Promise.all([
    import('@/components/neo/ComparativoPdf'),
    Promise.all(candidatos.map(({ candidato }) => fotoComoDataUrl(candidato))),
  ]);
  const lideres = Object.fromEntries(comparativo.escolas.map((e) => [e.chave, lideresNoRaioX(e, campanha)]));
  const blob = await gerarPdfDoComparativo({
    comparativo,
    candidatos: candidatos.map(({ candidato: c, cor }, i) => ({ nome: c.nome, numero: c.numero, cargo: c.cargo, cor, foto: fotos[i] })),
    lideres,
    geradoEm: new Date().toISOString(),
  });
  const nomes = candidatos.map(({ candidato: c }) => `${slug(c.nome)}-${c.numero}`).join('_x_');
  baixarArquivo(`estimativa-x-apuracao_${nomes}_${slug(time)}_${dataDoArquivo()}.pdf`, blob);
}

/**
 * O Raio-X da escola em PDF: o mesmo quadro que esta aberto na tela —
 * estimativa contra cada candidato, a frase, os Lideres e as secoes.
 */
export async function baixarPdfDoRaioX({
  escola,
  candidatos,
  lideres,
}: {
  escola: EscolaNoComparativo;
  candidatos: { nome: string; rotulo: string; cor: string; foto?: string }[];
  lideres: LiderNoRaioX[];
}): Promise<void> {
  const [{ gerarPdfDoRaioX }, fotos] = await Promise.all([
    import('@/components/neo/RaioXPdf'),
    Promise.all(candidatos.map((c) => urlComoDataUrl(c.foto))),
  ]);
  const blob = await gerarPdfDoRaioX({
    escola,
    candidatos: candidatos.map((c, i) => ({ nome: c.nome, rotulo: c.rotulo, cor: c.cor, foto: fotos[i] })),
    lideres,
    geradoEm: new Date().toISOString(),
  });
  baixarArquivo(`raio-x_${slug(escola.titulo)}_${dataDoArquivo()}.pdf`, blob);
}

/**
 * As secoes com 0 voto do municipio escolhido: toda secao onde qualquer um
 * dos candidatos teve 0 voto, no desenho do "Seção por seção" do Raio-X, com a gente do time e quanto cada Lider
 * cadastrou na escola e em cada secao.
 */
export async function baixarPdfDasZeradas({
  candidatos,
  municipios,
  campanha,
  referencias,
  query,
  time,
}: {
  candidatos: { candidato: CandidatoDaVotacao; cor: string }[];
  municipios: string[];
  /** As escolas da campanha no recorte do mapa (Lider, referencia): delas sai a gente do time. */
  campanha: readonly PollingPlacePin[];
  /** As referencias dos Lideres (a tag ao lado do nome). */
  referencias?: Readonly<Record<string, string>>;
  query: MapQuery | null;
  time: string;
}): Promise<void> {
  const params = new URLSearchParams({ candidatos: candidatos.map(({ candidato }) => candidato.id).join(',') });
  for (const m of municipios) params.append('municipio', m);
  const [payload, { gerarPdfDasZeradas }, fotos] = await Promise.all([
    api<SecoesDoMunicipioPayload>(`/api/votacao/secoes-zeradas?${params}`),
    import('@/components/neo/SecoesZeradasPdf'),
    Promise.all(candidatos.map(({ candidato }) => fotoComoDataUrl(candidato))),
  ]);
  // A resposta vem na ordem pedida, sem quem nao foi achado.
  const achados = candidatos.flatMap((c, i) => (payload.candidatos.includes(c.candidato.id) ? [{ ...c, foto: fotos[i] }] : []));
  const relatorio = relatorioDeZeradas(payload, campanha, referencias);
  // So o recorte de gente: o municipio ja esta no titulo e a secao do filtro nao vale aqui.
  const recorte = recorteEmPalavras(query ? { ...query, cities: [], city: null, state: null, section: null, zone: null, minVotes: 0, search: '' } : null, campanha);
  const blob = await gerarPdfDasZeradas({
    relatorio,
    candidatos: achados.map(({ candidato: c, cor, foto }) => ({ nome: c.nome, numero: c.numero, cargo: c.cargo, cor, foto })),
    recorte,
    geradoEm: new Date().toISOString(),
  });
  const nomes = achados.map(({ candidato: c }) => `${slug(c.nome)}-${c.numero}`).join('_x_');
  baixarArquivo(`secoes-zeradas_${slug(municipios.join('-'))}_${nomes}_${slug(time)}_${dataDoArquivo()}.pdf`, blob);
}

/**
 * As secoes onde o time tem gente cadastrada (nao voto), escola por escola,
 * com quantas pessoas cada Lider cadastrou em cada secao. `campanha`: as
 * escolas da campanha ja no recorte do mapa (Lider, referencia, municipio).
 * Com candidatos no mapa, cada secao traz os votos de cada um (as votacoes
 * ja carregadas no mapa, sem nova consulta).
 */
export async function baixarPdfDasSecoesComGente({
  campanha,
  candidatos = [],
  referencias,
  zona,
  recorte,
  time,
}: {
  campanha: readonly PollingPlacePin[];
  /** Os candidatos do mapa, cada um com a votacao dele e a cor do placar. */
  candidatos?: { candidato: CandidatoDaVotacao; votacao: VotacaoNoMapa; cor: string }[];
  /** As referencias dos Lideres (a tag ao lado do nome). */
  referencias?: Readonly<Record<string, string>>;
  /** O filtro de zona do mapa: so as secoes dela. */
  zona: string | null;
  /** O recorte em palavras (Lider, referencia, municipio...), ou nulo sem filtro. */
  recorte: string | null;
  time: string;
}): Promise<void> {
  const [{ gerarPdfDasSecoesComGente }, fotos] = await Promise.all([
    import('@/components/neo/SecoesComGentePdf'),
    Promise.all(candidatos.map(({ candidato }) => fotoComoDataUrl(candidato))),
  ]);
  const votos = candidatos.map(({ votacao }) => votosPorSecao([...votacao.noMapa, ...votacao.foraDoMapa]));
  const blob = await gerarPdfDasSecoesComGente({
    relatorio: relatorioDeGente(campanha, referencias, zona, votos),
    candidatos: candidatos.map(({ candidato: c, cor }, i) => ({ nome: c.nome, numero: c.numero, cargo: c.cargo, cor, foto: fotos[i] })),
    time,
    recorte,
    geradoEm: new Date().toISOString(),
  });
  const nomes = candidatos.map(({ candidato: c }) => `_${slug(c.nome)}-${c.numero}`).join('');
  baixarArquivo(`secoes-com-gente_${slug(recorte ?? time)}${nomes}_${dataDoArquivo()}.pdf`, blob);
}
