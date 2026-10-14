import { Document, Page, Path, Svg, Text, View, pdf } from '@react-pdf/renderer';
import { appConfig } from '@/config/app.config';
import type { EscolaComZeradas, LiderNaZerada, RelatorioDeZeradas, SecaoZerada } from '@/lib/domain/secoes-zeradas';
import { Cabecalho, Rodape, num, s, st } from './pdf-base';
import { FotoNoPdf } from './FotoNoPdf';
import { nomeProprio, semHifen } from './ConfrontoPdf';

/**
 * PDF das secoes com 0 voto, no mesmo desenho do "Seção por seção" do
 * Raio-X da escola: em cada secao, a barra da gente do time, a barra de cada
 * candidato (foto, nome, numero, cargo) e os Lideres que cadastraram gente
 * ali, com a referencia e a quantidade. Entra toda secao onde QUALQUER um dos
 * candidatos teve 0 voto — e quem zerou leva a etiqueta vermelha "0 VOTO".
 */

export interface CandidatoDasZeradas {
  nome: string;
  numero: string;
  cargo: string;
  cor: string;
  foto: string | null;
}

export interface PdfDasZeradasProps {
  relatorio: RelatorioDeZeradas;
  candidatos: CandidatoDasZeradas[];
  /** O recorte do mapa em palavras (Lider, referencia...), quando ha. */
  recorte?: string | null;
  geradoEm: string;
}

/** As cores da tela (globals.css). */
export const T = {
  navy900: '#0f1e35',
  navy800: '#16263f',
  navy300: '#8ea6c4',
  gold50: '#fdf6e3',
  gold400: '#f2c14e',
  gold500: '#e0a426',
  gold700: '#7a5410',
  ink900: '#17212b',
  ink500: '#4b5967',
  ink400: '#5a6875',
  ink200: '#c7d0d9',
  ink100: '#e7ecf1',
  ink50: '#f4f6f9',
  line: '#dde3ea',
  danger50: '#fcedec',
  danger600: '#b42318',
  danger700: '#8e1c13',
};

export const plural = (n: number, um: string, varios: string) => `${num(n)} ${n === 1 ? um : varios}`;
const iniciais = (nome: string) => {
  const partes = nome.trim().split(/\s+/).filter((p) => p.length > 2);
  return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase() || '?';
};

/* -------------------------------------------------------------------------
   Icones (os mesmos tracos do lucide da tela)
   ------------------------------------------------------------------------- */

export function Icone({ d, tamanho, cor, grosso = 2 }: { d: string[]; tamanho: number; cor: string; grosso?: number }) {
  return (
    <Svg viewBox="0 0 24 24" width={tamanho} height={tamanho}>
      {d.map((p) => (
        <Path key={p} d={p} stroke={cor} strokeWidth={grosso} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}
export const PESSOAS = ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'];
const MARCADOR = ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z', 'm9 10 2 2 4-4'];
const SEM_MARCADOR = ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z', 'm14.5 7.5-5 5', 'm9.5 7.5 5 5'];
const COROA = [
  'M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z',
  'M5 21h14',
];

/* -------------------------------------------------------------------------
   As pecas da secao
   ------------------------------------------------------------------------- */

/** Coluna do numero na ponta da barra. */
const NUMERO = 34;
/** Recuo do rotulo: o tamanho da marca (foto ou icone) e o espaco ate a barra. */
const RECUO = 24;

export function Barra({ valor, escala, cor }: { valor: number; escala: number; cor: string }) {
  const largura = valor > 0 ? Math.max(2, (valor / Math.max(1, escala)) * 100) : 0;
  return (
    <View style={{ flex: 1, height: 7, backgroundColor: T.ink100, borderRadius: 3.5 }}>
      {largura ? <View style={{ width: `${largura}%`, height: 7, backgroundColor: cor, borderRadius: 3.5 }} /> : null}
    </View>
  );
}

function SeloDaReferencia({ referencia }: { referencia: string | null | undefined }) {
  if (referencia === undefined) return null;
  const texto = referencia?.replace(/\s+/g, ' ').trim() || null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 7,
        paddingVertical: 1,
        paddingHorizontal: 3.5,
        marginLeft: 3,
        backgroundColor: texto ? T.gold50 : T.danger50,
        borderWidth: 0.6,
        borderColor: texto ? '#ecd9a8' : '#e8b4af',
        borderStyle: texto ? 'solid' : 'dashed',
      }}
    >
      <Icone d={texto ? MARCADOR : SEM_MARCADOR} tamanho={5.5} cor={texto ? T.gold700 : T.danger700} grosso={2.6} />
      <Text style={{ fontSize: 5.6, fontFamily: 'Helvetica-Bold', color: texto ? T.gold700 : T.danger700, marginLeft: 1.8, letterSpacing: 0.2 }}>
        {s(texto ? texto.toUpperCase() : 'Sem referência')}
      </Text>
    </View>
  );
}

export function ChipDoLider({ l }: { l: LiderNaZerada }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0.7,
        borderColor: T.line,
        borderRadius: 9,
        paddingVertical: 1.5,
        paddingLeft: 1.5,
        paddingRight: 2,
        marginRight: 3,
        marginTop: 3,
        backgroundColor: '#ffffff',
      }}
    >
      <View style={{ width: 11, height: 11, borderRadius: 5.5, backgroundColor: T.navy900, justifyContent: 'center', alignItems: 'center', marginRight: 2.5 }}>
        <Text style={{ fontSize: 4.6, fontFamily: 'Helvetica-Bold', color: T.gold400 }}>{s(iniciais(l.nome))}</Text>
      </View>
      <Text hyphenationCallback={semHifen} style={{ fontSize: 6.8, fontFamily: 'Helvetica-Bold', color: T.ink900 }}>
        {s(nomeProprio(l.nome))}
      </Text>
      <SeloDaReferencia referencia={l.referencia} />
      <View style={{ backgroundColor: T.navy900, borderRadius: 5, paddingHorizontal: 3.5, paddingVertical: 0.8, marginLeft: 3 }}>
        <Text style={{ fontSize: 6.2, fontFamily: 'Helvetica-Bold', color: '#ffffff' }}>{num(l.pessoas)}</Text>
      </View>
    </View>
  );
}

/** Uma secao: igual a linha do "Seção por seção" da tela. */
function LinhaDaSecao({
  z,
  candidatos,
  escala,
  ultima,
}: {
  z: SecaoZerada;
  candidatos: CandidatoDasZeradas[];
  escala: number;
  ultima: boolean;
}) {
  const varios = candidatos.length > 1;
  const total = z.votos.reduce((t, v) => t + v, 0);
  const maior = Math.max(...z.votos);
  const semLider = Math.max(0, z.gente - z.lideres.reduce((t, l) => t + l.pessoas, 0));
  const alarme = z.gente > 0;
  return (
    <View
      wrap={false}
      style={{
        flexDirection: 'row',
        paddingVertical: 8,
        paddingRight: 12,
        paddingLeft: 9,
        borderBottomWidth: ultima ? 0 : 0.6,
        borderBottomColor: T.line,
        borderLeftWidth: 3,
        borderLeftColor: alarme ? T.danger600 : T.ink200,
      }}
    >
      <View style={{ width: 66, paddingTop: 2 }}>
        <Text style={{ fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: T.ink900 }}>{s(`Seção ${z.secao}`)}</Text>
        <Text style={{ fontSize: 7, color: T.ink500, marginTop: 1.5 }}>{s(`Zona ${z.zona}`)}</Text>
        {alarme ? (
          <View style={{ alignSelf: 'flex-start', marginTop: 4, backgroundColor: T.danger600, borderRadius: 6, paddingHorizontal: 4, paddingVertical: 1.2 }}>
            <Text style={{ fontSize: 5.4, fontFamily: 'Helvetica-Bold', color: '#ffffff', letterSpacing: 0.4 }}>TINHA GENTE</Text>
          </View>
        ) : (
          <View style={{ alignSelf: 'flex-start', marginTop: 4, backgroundColor: T.ink100, borderRadius: 6, paddingHorizontal: 4, paddingVertical: 1.2 }}>
            <Text style={{ fontSize: 5.4, fontFamily: 'Helvetica-Bold', color: T.ink500, letterSpacing: 0.4 }}>SEM GENTE</Text>
          </View>
        )}
      </View>

      <View style={{ flex: 1 }}>
        {/* A gente do time. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: RECUO, paddingRight: NUMERO }}>
          <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', color: T.navy900 }}>
            Gente do time
            <Text style={{ fontFamily: 'Helvetica', color: T.ink500 }}>{s('  ·  cadastrados que votam aqui')}</Text>
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
          <View style={{ width: 17, height: 17, borderRadius: 8.5, backgroundColor: T.navy900, justifyContent: 'center', alignItems: 'center', marginRight: RECUO - 17 }}>
            <Icone d={PESSOAS} tamanho={8.5} cor={T.gold400} />
          </View>
          <Barra valor={z.gente} escala={escala} cor={T.navy800} />
          <Text style={{ width: NUMERO, textAlign: 'right', fontSize: 8.6, fontFamily: 'Helvetica-Bold', color: T.ink900 }}>{num(z.gente)}</Text>
        </View>

        {/* Cada candidato: rotulo em cima, barra embaixo. */}
        {candidatos.map((c, i) => {
          const votos = z.votos[i] ?? 0;
          const zerou = votos <= 0;
          const campeao = varios && votos > 0 && votos === maior;
          return (
            <View key={c.numero + c.cargo} style={{ marginTop: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingLeft: RECUO, paddingRight: NUMERO }}>
                {campeao ? (
                  <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: T.gold400, justifyContent: 'center', alignItems: 'center', marginRight: 3 }}>
                    <Icone d={COROA} tamanho={5.5} cor={T.navy900} grosso={2.8} />
                  </View>
                ) : null}
                <Text hyphenationCallback={semHifen} style={{ fontSize: 7.4, fontFamily: 'Helvetica-Bold', color: T.ink900 }}>
                  {s(c.nome)}
                </Text>
                <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', color: T.ink400, marginLeft: 3 }}>{c.numero}</Text>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginLeft: 4,
                    borderWidth: 0.6,
                    borderColor: `${c.cor}66`,
                    backgroundColor: `${c.cor}14`,
                    borderRadius: 6,
                    paddingHorizontal: 3.5,
                    paddingVertical: 0.8,
                  }}
                >
                  <View style={{ width: 3.5, height: 3.5, borderRadius: 1.75, backgroundColor: c.cor, marginRight: 2 }} />
                  <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', color: '#334155' }}>{s(c.cargo)}</Text>
                </View>
                <View style={{ flex: 1 }} />
                {zerou ? (
                  <View style={{ backgroundColor: T.danger600, borderRadius: 6, paddingHorizontal: 4.5, paddingVertical: 1.2 }}>
                    <Text style={{ fontSize: 5.8, fontFamily: 'Helvetica-Bold', color: '#ffffff', letterSpacing: 0.4 }}>0 VOTO</Text>
                  </View>
                ) : varios && total > 0 ? (
                  <Text style={{ fontSize: 6.2, fontFamily: 'Helvetica-Bold', color: T.ink500 }}>{s(`${Math.round((votos / total) * 100)}% da seção`)}</Text>
                ) : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                <View style={{ marginRight: RECUO - 17 }}>
                  <FotoNoPdf src={c.foto} nome={c.nome} tamanho={17} anel={c.cor} />
                </View>
                <Barra valor={votos} escala={escala} cor={c.cor} />
                <Text style={{ width: NUMERO, textAlign: 'right', fontSize: 8.6, fontFamily: 'Helvetica-Bold', color: zerou ? T.danger600 : T.ink900 }}>{num(votos)}</Text>
              </View>
            </View>
          );
        })}

        {/* Quem cadastrou a gente desta secao. */}
        {z.lideres.length || semLider ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
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

/** A escola: o cabecalho (como o do Raio-X) e as secoes com 0 voto. */
function CartaoDaEscola({ e, posicao, candidatos }: { e: EscolaComZeradas; posicao: number; candidatos: CandidatoDasZeradas[] }) {
  return (
    <View style={{ borderWidth: 0.8, borderColor: T.line, borderRadius: 7, marginBottom: 12, overflow: 'hidden', backgroundColor: '#ffffff' }}>
      <View wrap={false} minPresenceAhead={120} style={{ backgroundColor: T.navy900, paddingVertical: 9, paddingHorizontal: 11 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: T.gold400, justifyContent: 'center', alignItems: 'center', marginRight: 8 }}>
            <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: T.navy900 }}>{posicao}</Text>
          </View>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', color: T.gold400, letterSpacing: 1.2 }}>{s('ESCOLA · SEÇÕES COM 0 VOTO')}</Text>
            <Text hyphenationCallback={semHifen} style={{ fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: '#ffffff', marginTop: 1.5 }}>
              {s(e.titulo)}
            </Text>
            <Text style={{ fontSize: 6.8, color: T.navy300, marginTop: 2 }}>
              {s([e.endereco, e.cidade, `Zona ${e.zonas.join(', ')}`].filter(Boolean).join(' · '))}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <View style={{ backgroundColor: T.danger600, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2.5 }}>
              <Text style={{ fontSize: 7.4, fontFamily: 'Helvetica-Bold', color: '#ffffff' }}>
                {s(`${num(e.zeradas.length)} de ${plural(e.totalDeSecoes, 'seção', 'seções')} com 0 voto`)}
              </Text>
            </View>
            <Text style={{ fontSize: 6.8, color: T.navy300, marginTop: 3 }}>
              {s(`${plural(e.genteNaEscola, 'pessoa', 'pessoas')} do time na escola · ${num(e.genteNasZeradas)} nessas seções`)}
            </Text>
          </View>
        </View>

        {/* Os votos de cada candidato na escola inteira. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 7 }}>
          {candidatos.map((c, i) => (
            <View
              key={c.numero + c.cargo}
              style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.navy800, borderRadius: 9, paddingVertical: 2, paddingLeft: 2, paddingRight: 6, marginRight: 4, marginTop: 2 }}
            >
              <FotoNoPdf src={c.foto} nome={c.nome} tamanho={13} anel={c.cor} />
              <Text style={{ fontSize: 6.6, color: T.navy300, marginLeft: 4 }}>{s(`${nomeProprio(c.nome).split(' ')[0]} na escola `)}</Text>
              <Text style={{ fontSize: 7.2, fontFamily: 'Helvetica-Bold', color: (e.votosNaEscola[i] ?? 0) > 0 ? '#ffffff' : '#ff9b91' }}>{num(e.votosNaEscola[i] ?? 0)}</Text>
            </View>
          ))}
        </View>
      </View>

      {e.zeradas.map((z, i) => (
        <LinhaDaSecao key={z.chave} z={z} candidatos={candidatos} escala={e.escala} ultima={i === e.zeradas.length - 1} />
      ))}
    </View>
  );
}

/* -------------------------------------------------------------------------
   O documento
   ------------------------------------------------------------------------- */

export function Numero({ valor, rotulo, nota, cor }: { valor: number; rotulo: string; nota: string; cor: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: '#ffffff', borderWidth: 0.8, borderColor: T.line, borderRadius: 7, paddingVertical: 8, paddingHorizontal: 10 }}>
      <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', color: T.ink500, letterSpacing: 0.8 }}>{s(rotulo.toUpperCase())}</Text>
      <Text style={{ fontSize: 18, fontFamily: 'Helvetica-Bold', color: cor, marginTop: 2 }}>{num(valor)}</Text>
      <Text style={{ fontSize: 6.6, color: T.ink400, marginTop: 1 }}>{s(nota)}</Text>
    </View>
  );
}

export function PdfDasZeradas({ relatorio, candidatos, recorte, geradoEm }: PdfDasZeradasProps) {
  const { totais } = relatorio;
  const quando = new Date(geradoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const onde = relatorio.municipios.join(', ');
  return (
    <Document title={`Seções com 0 voto · ${onde}`} author={appConfig.name}>
      <Page size="A4" style={[st.page, { backgroundColor: '#eef2f6' }]}>
        <Cabecalho esquerda={`Seções com 0 voto · ${onde}`} direita={appConfig.name} />
        <Rodape texto={`Gerado em ${quando} · votação oficial do TSE × cadastro do time`} />

        {/* Abertura: os candidatos, como no placar da tela. */}
        <View style={{ backgroundColor: T.navy900, borderRadius: 8, paddingVertical: 13, paddingHorizontal: 14, marginBottom: 9 }}>
          <Text style={{ fontSize: 6.8, letterSpacing: 1.5, color: T.gold400, fontFamily: 'Helvetica-Bold' }}>{s('SEÇÕES COM 0 VOTO · VOTAÇÃO DO TSE')}</Text>
          <Text style={{ fontSize: 15, color: '#ffffff', fontFamily: 'Helvetica-Bold', marginTop: 3 }}>{s(onde)}</Text>
          <Text style={{ fontSize: 7.4, color: T.navy300, marginTop: 3, lineHeight: 1.4 }}>
            {s(
              [
                candidatos.length > 1
                  ? 'Toda seção onde qualquer um dos candidatos teve 0 voto, escola por escola'
                  : 'Toda seção onde o candidato teve 0 voto, escola por escola',
                recorte ? `gente do time: ${recorte}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            )}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 9 }}>
            {candidatos.map((c, i) => (
              <View
                key={c.numero + c.cargo}
                style={{
                  width: '49%',
                  marginRight: i % 2 === 0 ? '2%' : 0,
                  marginTop: i >= 2 ? 6 : 0,
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: T.navy800,
                  borderRadius: 7,
                  padding: 7,
                  borderLeftWidth: 3,
                  borderLeftColor: c.cor,
                }}
              >
                <FotoNoPdf src={c.foto} nome={c.nome} tamanho={34} anel={c.cor} />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text hyphenationCallback={semHifen} style={{ fontSize: 8.6, fontFamily: 'Helvetica-Bold', color: '#ffffff', maxLines: 1, textOverflow: 'ellipsis' }}>
                    {s(c.nome)}
                  </Text>
                  <Text style={{ fontSize: 6.8, color: T.navy300, marginTop: 1.5 }}>{s(`${c.numero} · ${c.cargo}`)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', marginLeft: 6 }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Helvetica-Bold', color: '#ff9b91' }}>{num(totais.zeradasPorCandidato[i] ?? 0)}</Text>
                  <Text style={{ fontSize: 5.8, color: T.navy300 }}>{s('seções com 0')}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={{ flexDirection: 'row', marginBottom: 12 }} wrap={false}>
          <Numero valor={totais.secoesZeradas} rotulo="Seções com 0 voto" nota={`de ${num(totais.secoesDoMunicipio)} seções do município`} cor={T.danger600} />
          <View style={{ width: 6 }} />
          <Numero valor={totais.escolasComZerada} rotulo="Escolas" nota={`de ${num(totais.escolasDoMunicipio)} escolas`} cor={T.navy900} />
          <View style={{ width: 6 }} />
          <Numero valor={totais.zeradasComGente} rotulo="Tinha gente do time" nota="seções com 0 e gente cadastrada" cor={T.danger600} />
          <View style={{ width: 6 }} />
          <Numero valor={totais.genteNasZeradas} rotulo="Pessoas do time" nota="cadastradas nessas seções" cor={T.gold700} />
        </View>

        {totais.secoesZeradas === 0 ? (
          <View style={{ padding: 14, borderRadius: 7, backgroundColor: '#e6f3eb' }}>
            <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#17693a' }}>{s('Nenhuma seção com 0 voto.')}</Text>
            <Text style={{ fontSize: 8, color: T.ink500, marginTop: 3 }}>
              {s(totais.secoesDoMunicipio ? 'Os candidatos tiveram voto em todas as seções do município.' : 'A votação não tem as seções deste município.')}
            </Text>
          </View>
        ) : null}

        {relatorio.escolas.map((e, i) => (
          <CartaoDaEscola key={e.chave} e={e} posicao={i + 1} candidatos={candidatos} />
        ))}
      </Page>
    </Document>
  );
}

export async function gerarPdfDasZeradas(props: PdfDasZeradasProps): Promise<Blob> {
  return pdf(<PdfDasZeradas {...props} />).toBlob();
}
