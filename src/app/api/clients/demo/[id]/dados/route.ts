import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/server/guard';
import { badRequest, forbidden, jsonOk, toErrorResponse } from '@/lib/server/http';
import { refreshDemoTeam } from '@/lib/server/demo.service';
import { demoRefreshSchema } from '@/lib/validation/server.schema';

/**
 * Corrige os dados gerados de um Time DEMO que ja existe. EXCLUSIVO do ADMIN
 * geral.
 *
 * Duas barreiras, como na criacao: a permissao `client.create`, que nenhum
 * outro perfil tem, e o perfil ADMIN conferido aqui. Administrador do time e
 * integrante recebem 403.
 *
 * O que a rotina refaz e SOMENTE o que o gerador criou (as linhas marcadas
 * com `demo_seed`). O time, os administradores, os acessos deles, os links,
 * o formulario, o questionario, as configuracoes e qualquer pessoa cadastrada
 * a mao continuam exatamente como estao.
 *
 * Chamar duas vezes nao duplica nada: a geracao anterior sai antes de a nova
 * entrar, e a semente e a mesma.
 *
 * Time real nao passa daqui: `refreshDemoTeam` recusa o que nao e `is_demo`.
 *
 * O corpo e opcional: `{ people, places }` escolhe o tamanho da nova geracao.
 * Sem corpo, vale o comportamento de sempre.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<'/api/clients/demo/[id]/dados'>,
) {
  try {
    const user = await requirePermission('client.create');
    if (user.role !== 'ADMIN') throw forbidden();

    const { id } = await ctx.params;

    const texto = await request.text().catch(() => '');
    let corpo: unknown = {};
    if (texto.trim()) {
      try {
        corpo = JSON.parse(texto);
      } catch {
        throw badRequest('Corpo da requisição inválido.');
      }
    }
    const entrada = demoRefreshSchema.safeParse(corpo);
    if (!entrada.success) {
      throw badRequest(entrada.error.issues[0]?.message ?? 'Dados inválidos.');
    }

    return jsonOk({ report: await refreshDemoTeam(id, entrada.data) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
