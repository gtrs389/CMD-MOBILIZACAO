import { Document, Page, Text, View, pdf } from '@react-pdf/renderer';
import { appConfig } from '@/config/app.config';
import type { EscolaComGente, RelatorioDeGente, SecaoComGente } from '@/lib/domain/secoes-com-gente';
import { Cabecalho, Rodape, num, s, st } from './pdf-base';
import { nomeProprio, semHifen } from './ConfrontoPdf';
import { FotoNoPdf } from './FotoNoPdf';
import {
  Barra,
  CartaoDoCandidato,
  ChipDoLider,
  Icone,
  LinhaDoCandidato,
  Numero,
  PESSOAS,
  T,
  plural,
  type CandidatoDasZeradas,
} from './SecoesZeradasPdf';

/**
 * PDF das secoes com gente cadastrada: escola por escola, secao por secao,
 * quantas pessoas do time votam ali e quantas cada Lider cadastrou. Nao tem
 * voto que escolhe a secao: e o mapa do cadastro, no recorte do mapa (Lider,
 * referencia, municipio, zona). Com candidato no mapa, cada secao traz
 * tambem os votos de cada um, no mesmo desenho do PDF das secoes com 0 voto.
 */

export interface PdfDasSecoesComGenteProps {
  relatorio: RelatorioDeGente;
  /** Os candidatos do mapa, na ordem dos votos do relatorio (vazio sem candidato). */
  candidatos?: CandidatoDasZeradas[];
  /** Nome do time. */
  time: string;
  /** O recorte do mapa em palavras (Lider, referencia, municipio...), quando ha. */
  recorte?: string | null;
  geradoEm: string;
}

/** Coluna do numero na ponta da barra. */
const NUMERO = 34;

function LinhaDaSecao({
  z,
  candidatos,
  escala,
  ultima,
}: {
  z: SecaoComGente;
  candidatos: CandidatoDasZeradas[];
  escala: number;
  ultima: boolean;
}) {
  const semLider = Math.max(0, z.gente - z.lideres.reduce((t, l) => t + l.pessoas, 0));
  const total = z.votos.reduce((t, v) => t + v, 0);
  const maior = Math.max(0, ...z.votos);
  return (
    <View
      wrap={false}
      style={{
        flexDirection: 'row',
        paddingVertical: 7,
        paddingRight: 12,
        paddingLeft: 9,
        borderBottomWidth: ultima ? 0 : 0.6,
        borderBottomColor: T.line,
        borderLeftWidth: 3,
        borderLeftColor: T.gold500,
      }}
    >
      <View style={{ width: 66, paddingTop: 1 }}>
        <Text style={{ fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: T.ink900 }}>{s(`Seção ${z.secao}`)}</Text>
        <Text style={{ fontSize: 7, color: T.ink500, marginTop: 1.5 }}>{s(`Zona ${z.zona}`)}</Text>
      </View>

      <View style={{ flex: 1 }}>
        {candidatos.length ? (
          <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', color: T.navy900, paddingLeft: 24, marginBottom: 2 }}>
            Gente do time
            <Text style={{ fontFamily: 'Helvetica', color: T.ink500 }}>{s('  ·  cadastrados que votam aqui')}</Text>
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ width: 17, height: 17, borderRadius: 8.5, backgroundColor: T.navy900, justifyContent: 'center', alignItems: 'center', marginRight: 7 }}>
            <Icone d={PESSOAS} tamanho={8.5} cor={T.gold400} />
          </View>
          <Barra valor={z.gente} escala={escala} cor={T.navy800} />
          <Text style={{ width: NUMERO, textAlign: 'right', fontSize: 8.6, fontFamily: 'Helvetica-Bold', color: T.ink900 }}>{num(z.gente)}</Text>
        </View>

        {candidatos.map((c, i) => (
          <LinhaDoCandidato key={c.numero + c.cargo} c={c} votos={z.votos[i] ?? 0} total={total} maior={maior} varios={candidatos.length > 1} escala={escala} />
        ))}

        {/* Quem cadastrou a gente desta secao. */}
        {z.lideres.length || semLider ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: candidatos.length ? 4 : 2 }}>
            {z.lideres.map((l) => (
              <ChipDoLider key={l.id} l={l} />
            ))}
            {semLider ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 0.7, borderStyle: 'dashed', borderColor: T.ink200, borderRadius: 9, paddingVertical: 2.5, paddingHorizontal: 5, marginTop: 3 }}>
                <Text style={{ fontSize: 6.8, color: T.ink500 }}>{s('sem líder ')}</Text>
                <Text style={{ fontSize: 6.8, fontFamily: 'Helvetica-Bold', color: T.ink500 }}>{num(semLider)}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CartaoDaEscola({ e, posicao, candidatos }: { e: EscolaComGente; posicao: number; candidatos: CandidatoDasZeradas[] }) {
  return (
    <View style={{ borderWidth: 0.8, borderColor: T.line, borderRadius: 7, marginBottom: 12, overflow: 'hidden', backgroundColor: '#ffffff' }}>
      <View wrap={false} minPresenceAhead={80} style={{ backgroundColor: T.navy900, paddingVertical: 9, paddingHorizontal: 11 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: T.gold400, justifyContent: 'center', alignItems: 'center', marginRight: 8 }}>
            <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: T.navy900 }}>{posicao}</Text>
          </View>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', color: T.gold400, letterSpacing: 1.2 }}>{s('ESCOLA · SEÇÕES COM GENTE CADASTRADA')}</Text>
            <Text hyphenationCallback={semHifen} style={{ fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: '#ffffff', marginTop: 1.5 }}>
              {s(e.titulo)}
            </Text>
            <Text style={{ fontSize: 6.8, color: T.navy300, marginTop: 2 }}>
              {s([e.endereco, e.cidade, e.zonas.length ? `Zona ${e.zonas.join(', ')}` : null].filter(Boolean).join(' · '))}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <View style={{ backgroundColor: T.gold400, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2.5 }}>
              <Text style={{ fontSize: 7.4, fontFamily: 'Helvetica-Bold', color: T.navy900 }}>{s(plural(e.gente, 'pessoa', 'pessoas'))}</Text>
            </View>
            <Text style={{ fontSize: 6.8, color: T.navy300, marginTop: 3 }}>
              {s(
                [
                  plural(e.secoes.length, 'seção com gente', 'seções com gente'),
                  e.semSecao ? `${num(e.semSecao)} sem seção no cadastro` : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              )}
            </Text>
          </View>
        </View>

        {/* Os votos de cada candidato nas secoes listadas da escola. */}
        {candidatos.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 7 }}>
            {candidatos.map((c, i) => (
              <View
                key={c.numero + c.cargo}
                style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.navy800, borderRadius: 9, paddingVertical: 2, paddingLeft: 2, paddingRight: 6, marginRight: 4, marginTop: 2 }}
              >
                <FotoNoPdf src={c.foto} nome={c.nome} tamanho={13} anel={c.cor} />
                <Text style={{ fontSize: 6.6, color: T.navy300, marginLeft: 4 }}>{s(`${nomeProprio(c.nome).split(' ')[0]} nessas seções `)}</Text>
                <Text style={{ fontSize: 7.2, fontFamily: 'Helvetica-Bold', color: (e.votosNasSecoes[i] ?? 0) > 0 ? '#ffffff' : '#ff9b91' }}>
                  {num(e.votosNasSecoes[i] ?? 0)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {e.secoes.map((z, i) => (
        <LinhaDaSecao key={z.chave} z={z} candidatos={candidatos} escala={e.escala} ultima={i === e.secoes.length - 1} />
      ))}
    </View>
  );
}

/** Os Lideres do recorte: quantas pessoas, em quantas secoes e escolas. */
function QuadroDosLideres({ relatorio }: { relatorio: RelatorioDeGente }) {
  if (relatorio.lideres.length < 2) return null;
  return (
    <View style={{ borderWidth: 0.8, borderColor: T.line, borderRadius: 7, marginBottom: 12, backgroundColor: '#ffffff', padding: 10 }}>
      <Text style={{ fontSize: 6.8, fontFamily: 'Helvetica-Bold', color: T.ink500, letterSpacing: 0.8, marginBottom: 4 }}>
        {s('LÍDERES · PESSOAS CADASTRADAS, SEÇÕES E ESCOLAS')}
      </Text>
      {relatorio.lideres.map((l, i) => (
        <View
          key={l.id}
          wrap={false}
          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 3, borderTopWidth: i ? 0.5 : 0, borderTopColor: T.ink100 }}
        >
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <ChipDoLider l={l} />
          </View>
          <Text style={{ width: 80, textAlign: 'right', fontSize: 7, color: T.ink500 }}>{s(plural(l.secoes, 'seção', 'seções'))}</Text>
          <Text style={{ width: 70, textAlign: 'right', fontSize: 7, color: T.ink500 }}>{s(plural(l.escolas, 'escola', 'escolas'))}</Text>
        </View>
      ))}
    </View>
  );
}

export function PdfDasSecoesComGente({ relatorio, candidatos = [], time, recorte, geradoEm }: PdfDasSecoesComGenteProps) {
  const { totais } = relatorio;
  const quando = new Date(geradoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const titulo = recorte ?? time;
  return (
    <Document title={`Seções com gente cadastrada · ${titulo}`} author={appConfig.name}>
      <Page size="A4" style={[st.page, { backgroundColor: '#eef2f6' }]}>
        <Cabecalho esquerda={`Seções com gente cadastrada · ${titulo}`} direita={appConfig.name} />
        <Rodape texto={`Gerado em ${quando} · ${candidatos.length ? 'cadastro do time × votação oficial do TSE' : 'cadastro do time (não é voto)'}`} />

        <View style={{ backgroundColor: T.navy900, borderRadius: 8, paddingVertical: 13, paddingHorizontal: 14, marginBottom: 9 }}>
          <Text style={{ fontSize: 6.8, letterSpacing: 1.5, color: T.gold400, fontFamily: 'Helvetica-Bold' }}>{s('SEÇÕES COM GENTE CADASTRADA')}</Text>
          <Text hyphenationCallback={semHifen} style={{ fontSize: 15, color: '#ffffff', fontFamily: 'Helvetica-Bold', marginTop: 3 }}>
            {s(titulo)}
          </Text>
          <Text style={{ fontSize: 7.4, color: T.navy300, marginTop: 3, lineHeight: 1.4 }}>
            {s(
              [
                `Onde o time tem pessoas cadastradas, escola por escola e seção por seção, com quantas cada líder cadastrou${
                  candidatos.length ? (candidatos.length > 1 ? ' e os votos de cada candidato' : ' e os votos do candidato') : ''
                }`,
                recorte ? time : null,
              ]
                .filter(Boolean)
                .join(' · '),
            )}
          </Text>
          {candidatos.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 9 }}>
              {candidatos.map((c, i) => (
                <CartaoDoCandidato
                  key={c.numero + c.cargo}
                  c={c}
                  posicao={i}
                  valor={totais.votosPorCandidato[i] ?? 0}
                  rotulo="votos nessas seções"
                  cor={T.gold400}
                />
              ))}
            </View>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', marginBottom: 12 }} wrap={false}>
          <Numero valor={totais.escolas} rotulo="Escolas" nota="com gente cadastrada" cor={T.navy900} />
          <View style={{ width: 6 }} />
          <Numero valor={totais.secoes} rotulo="Seções" nota="com gente cadastrada" cor={T.navy900} />
          <View style={{ width: 6 }} />
          <Numero valor={totais.pessoas} rotulo="Pessoas" nota="cadastradas nessas escolas" cor={T.gold700} />
          <View style={{ width: 6 }} />
          <Numero valor={totais.lideres} rotulo="Líderes" nota="com gente nessas seções" cor={T.navy900} />
        </View>

        {totais.escolas === 0 ? (
          <View style={{ padding: 14, borderRadius: 7, backgroundColor: '#ffffff', borderWidth: 0.8, borderColor: T.line }}>
            <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold', color: T.ink900 }}>{s('Nenhuma pessoa cadastrada neste recorte.')}</Text>
            <Text style={{ fontSize: 8, color: T.ink500, marginTop: 3 }}>{s('Troque o líder, a referência ou o município no filtro do mapa.')}</Text>
          </View>
        ) : null}

        <QuadroDosLideres relatorio={relatorio} />

        {relatorio.escolas.map((e, i) => (
          <CartaoDaEscola key={e.chave} e={e} posicao={i + 1} candidatos={candidatos} />
        ))}
      </Page>
    </Document>
  );
}

export async function gerarPdfDasSecoesComGente(props: PdfDasSecoesComGenteProps): Promise<Blob> {
  return pdf(<PdfDasSecoesComGente {...props} />).toBlob();
}
