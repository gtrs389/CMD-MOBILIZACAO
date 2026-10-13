import { requirePermission } from '@/lib/server/guard';
import { forbidden, jsonOk, toErrorResponse } from '@/lib/server/http';
import { demoCatalogSummary } from '@/lib/server/demo-schools';

/**
 * De onde saem as escolas de um Time DEMO, e quantas ha. EXCLUSIVO do ADMIN
 * geral — e quem cria Time DEMO, e e a ele que a tela de criacao mostra o
 * teto de escolas e de municipios.
 *
 * So leitura: a tabela oficial do TSE (ou, sem ela, o catalogo conferido).
 */
export async function GET() {
  try {
    const user = await requirePermission('client.create');
    if (user.role !== 'ADMIN') throw forbidden();

    return jsonOk(await demoCatalogSummary());
  } catch (error) {
    return toErrorResponse(error);
  }
}
