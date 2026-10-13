import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/server/guard';
import { forbidden, jsonOk, toErrorResponse } from '@/lib/server/http';
import { completeDemoMap } from '@/lib/server/demo.service';

/**
 * Completa a camada "Pessoas" de um Time DEMO. EXCLUSIVO do ADMIN geral.
 *
 * Cada chamada resolve o que couber no prazo e diz quanto falta; a tela
 * chama de novo ate zerar. Nao refaz pessoa nenhuma e so toca vinculos de
 * moradia do proprio Time DEMO — time real e recusado em `completeDemoMap`.
 *
 * Mesmas duas barreiras da criacao: a permissao `client.create`, que nenhum
 * outro perfil tem, e o perfil ADMIN conferido aqui.
 */
export async function POST(
  _request: NextRequest,
  ctx: RouteContext<'/api/clients/demo/[id]/mapa'>,
) {
  try {
    const user = await requirePermission('client.create');
    if (user.role !== 'ADMIN') throw forbidden();

    const { id } = await ctx.params;
    return jsonOk(await completeDemoMap(id));
  } catch (error) {
    return toErrorResponse(error);
  }
}
