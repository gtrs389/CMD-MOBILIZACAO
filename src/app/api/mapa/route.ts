import { after, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/server/guard';
import { forbidden, jsonOk, readJson, toErrorResponse } from '@/lib/server/http';
import {
  ensureResidenceLinks,
  mapOverview,
  resolvePending,
  retryLocation,
} from '@/lib/server/map-location.service';

/**
 * Mapa da mobilizacao.
 *
 * A resposta carrega apenas o necessario para desenhar o pino e abrir a
 * ficha: nenhum CPF, telefone, endereco completo ou retorno de consulta.
 *
 * O ADMIN ve a mobilizacao inteira, ou uma operacao quando pede. O
 * Administrador do time ve SEMPRE a propria: o recorte e imposto aqui, a
 * partir da sessao — trocar o `clientId` do endereco nao alcanca outro time.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requirePermission('map.view');

    if (user.role !== 'ADMIN') {
      // Fora do ADMIN o unico recorte possivel e a operacao da sessao, e o
      // mapa e so leitura: abrir a pagina do time nunca dispara consulta
      // paga. Quem resolve pendencia e o ADMIN.
      if (!user.candidateId) throw forbidden();
      return jsonOk(await mapOverview(user.candidateId));
    }

    // Vinculos que faltam e pendentes, um de cada vez, DEPOIS da resposta: o
    // mapa abre com o que ja existe e nao espera ate cinco consultas ao
    // provedor (cada uma leva segundos). O que for localizado agora aparece
    // na proxima abertura.
    after(async () => {
      await ensureResidenceLinks().catch(() => undefined);
      await resolvePending(5).catch(() => undefined);
    });

    const pedido = request.nextUrl.searchParams.get('clientId') ?? undefined;
    return jsonOk(await mapOverview(pedido));
  } catch (error) {
    return toErrorResponse(error);
  }
}

const actionSchema = z.union([
  z.object({ action: z.literal('pending') }),
  z.object({
    action: z.literal('retry'),
    memberId: z.string().min(1),
    kind: z.enum(['RESIDENCE', 'POLLING_PLACE']),
  }),
]);

/**
 * Localiza os cadastros pendentes ou repete um vinculo.
 *
 * Cada consulta pode gerar cobranca: nada disso acontece sozinho, e
 * `map.resolve` e exclusivo do ADMIN. O Administrador do time apenas ve o
 * mapa.
 */
export async function POST(request: NextRequest) {
  try {
    await requirePermission('map.resolve');
    const input = await readJson(request, actionSchema);

    if (input.action === 'pending') {
      return jsonOk(await resolvePending());
    }

    await retryLocation(input.memberId, input.kind);
    return jsonOk({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
