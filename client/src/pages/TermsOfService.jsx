import { Link } from 'react-router-dom';
import { ArrowLeft, ScrollText } from 'lucide-react';
import { empresa } from '../config/instancia';

/**
 * Pagina publica de termos de uso. Rota /termos, sem auth.
 *
 * Estes termos sao gerais e publicos. Cada empresa contratante assina um
 * contrato proprio, que prevalece sobre este texto quando houver divergencia.
 * Por isso valores negociaveis (SLA, teto de responsabilidade, foro) nao sao
 * fixados aqui: eles vivem no contrato.
 */

const company = empresa;

const Section = ({ title, children, id = null }) => (
  <section id={id} className="mb-8 scroll-mt-6">
    <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-2">{title}</h2>
    <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed space-y-3">{children}</div>
  </section>
);

const TermsOfService = () => (
  <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
    <header className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
      <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
        <Link to="/login" className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md">
          <ArrowLeft size={18} />
        </Link>
        <ScrollText size={20} className="text-blue-600" />
        <h1 className="text-base font-semibold text-slate-800 dark:text-slate-100">Termos de Uso</h1>
      </div>
    </header>

    <main className="max-w-3xl mx-auto px-4 py-8">
      <p className="text-xs text-slate-500 mb-6">Última atualização: {company.lastUpdated}</p>

      <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed mb-6">
        Estes termos regem o uso da plataforma <strong>{company.name}</strong>, operada pela{' '}
        <strong>{company.companyName}</strong>, inscrita no CNPJ sob o número <strong>{company.cnpj}</strong>.
      </p>

      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/40 rounded-lg p-4 mb-8 text-sm text-blue-900 dark:text-blue-200">
        O {company.name} é uma plataforma <strong>B2B</strong>. Quem a utiliza é a empresa contratante e os
        usuários que ela autoriza. O cliente final atendido por essa empresa não acessa a plataforma: ele
        interage apenas pelos canais de atendimento configurados, como WhatsApp ou Telegram.
      </div>

      <Section title="1. Aceitação">
        <p>Ao acessar ou utilizar a plataforma, você declara ter lido e concordado com estes termos. Se você acessa em nome de uma empresa, declara ter poderes para vinculá-la.</p>
        <p>Se não concordar com algum ponto, não utilize a plataforma.</p>
      </Section>

      <Section title="2. Relação com o contrato assinado" id="contrato">
        <p>Cada empresa contratante assina um contrato de prestação de serviços específico, que define escopo, plano, preço, nível de disponibilidade acordado, limite de responsabilidade e foro.</p>
        <p><strong>Em caso de divergência entre estes termos e o contrato assinado, o contrato prevalece.</strong> Estes termos aplicam-se de forma geral e supletiva.</p>
      </Section>

      <Section title="3. O que a plataforma faz">
        <p>O {company.name} oferece automação de atendimento, organização e roteamento de conversas, filas, atendimento humano, integrações com canais digitais e geração de relatórios e indicadores.</p>
        <p>A configuração de fluxos, automações e integrações pode ser conduzida pela {company.companyName} ou pela empresa contratante, conforme o escopo acordado.</p>
      </Section>

      <Section title="4. Contas e credenciais">
        <p>O acesso é individual. Cada usuário operador deve ter credenciais próprias e não deve compartilhá-las.</p>
        <p>A empresa contratante é responsável por manter atualizada a lista de usuários com acesso, revogar acessos de quem sai da operação e comunicar imediatamente qualquer suspeita de comprometimento de credencial.</p>
        <p>Ações realizadas com credenciais válidas presumem-se feitas pelo titular delas.</p>
      </Section>

      <Section title="5. Uso aceitável">
        <p>É vedado utilizar a plataforma para:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>enviar mensagens sem base legal ou sem consentimento adequado do destinatário, quando exigido;</li>
          <li>praticar spam, disparo em massa não solicitado ou contato abusivo;</li>
          <li>enviar conteúdo ilícito, fraudulento, discriminatório, enganoso ou que viole direitos de terceiros;</li>
          <li>coletar dados pessoais desnecessários, sensíveis ou incompatíveis com a finalidade do atendimento, sem acordo prévio;</li>
          <li>tentar burlar limites técnicos, acessar dados de outra empresa contratante, ou explorar falhas de segurança;</li>
          <li>revender, sublicenciar ou disponibilizar a plataforma a terceiros sem autorização escrita.</li>
        </ul>
        <p>O descumprimento pode levar à suspensão imediata do acesso, sem prejuízo das demais medidas cabíveis.</p>
      </Section>

      <Section title="6. Canais de terceiros">
        <p>A plataforma se integra a canais operados por terceiros, como a WhatsApp Business Platform (Meta) e a API do Telegram.</p>
        <p>O uso desses canais está sujeito às políticas e aos preços do respectivo provedor, que podem mudar sem aviso e sem qualquer participação da {company.companyName}. Bloqueios, limitações de qualidade, reprovação de modelos de mensagem, suspensão de número ou indisponibilidade impostos por esses terceiros não constituem falha da plataforma.</p>
        <p>A empresa contratante é responsável por manter suas próprias credenciais, conta e método de pagamento junto a esses provedores, quando aplicável.</p>
      </Section>

      <Section title="7. Mensagens ativas e conteúdo">
        <p>Quando o plano contratado incluir envio ativo de mensagens, a empresa contratante é integralmente responsável pelo conteúdo enviado, pela base de destinatários, pela existência de base legal para o contato e pelo cumprimento das políticas do canal.</p>
        <p>A {company.companyName} pode recusar, suspender ou solicitar ajuste de campanhas, fluxos ou mensagens que aparentem violar a lei, as políticas do canal ou direitos de terceiros.</p>
      </Section>

      <Section title="8. Planos, pagamento e suspensão">
        <p>Plano, preço, forma e periodicidade de pagamento são definidos no contrato assinado e na proposta comercial correspondente.</p>
        <p>O atraso no pagamento pode acarretar suspensão do acesso e da operação, mediante aviso prévio, nos termos do contrato.</p>
      </Section>

      <Section title="9. Disponibilidade">
        <p>Empregamos esforços razoáveis para manter a plataforma disponível. A meta de disponibilidade, quando houver, é a definida no plano contratado.</p>
        <p>Não são considerados indisponibilidade: manutenções programadas, falhas de provedores externos, instabilidades da Meta, WhatsApp, Telegram ou outras APIs de terceiros, problemas de conectividade fora do nosso controle, falhas causadas por credenciais inválidas ou configurações alteradas pela contratante, e eventos de força maior.</p>
        <p>Nenhuma disposição destes termos deve ser interpretada como promessa de disponibilidade de 100%.</p>
      </Section>

      <Section title="10. Propriedade intelectual">
        <p>A plataforma, seu código, sua interface, sua marca e sua documentação pertencem à {company.companyName}. O contrato concede direito de uso durante a vigência, não transfere propriedade.</p>
        <p>Os dados de atendimento, as conversas e o conteúdo inserido pela empresa contratante permanecem dela.</p>
      </Section>

      <Section title="11. Dados pessoais">
        <p>O tratamento de dados pessoais é descrito na <Link to="/privacidade" className="text-blue-600 dark:text-blue-300 underline">Política de Privacidade</Link>, que integra estes termos.</p>
        <p>Para solicitações de exclusão de dados, veja a <Link to="/privacidade#exclusao-de-dados" className="text-blue-600 dark:text-blue-300 underline">seção específica da Política de Privacidade</Link>.</p>
      </Section>

      <Section title="12. Encerramento">
        <p>O encerramento segue as condições do contrato assinado. Encerrada a relação, a empresa contratante pode solicitar a exportação dos dados de atendimento dentro do prazo previsto em contrato, após o qual os dados são eliminados ou anonimizados, observadas as obrigações legais de retenção.</p>
      </Section>

      <Section title="13. Limitação de responsabilidade">
        <p>Na máxima extensão permitida pela legislação aplicável, nossa responsabilidade por danos diretos fica limitada ao valor definido no contrato assinado.</p>
        <p>Não respondemos por danos indiretos, lucros cessantes, perda de receita, perda de oportunidade comercial, perda de reputação, interrupção de negócio ou falhas de terceiros.</p>
        <p>Essa limitação não se aplica às hipóteses em que a lei não a permita, nem a atos comprovadamente dolosos ou fraudulentos.</p>
        <p>A empresa contratante responde pelo conteúdo, pelas listas de contato, pelas bases legais, pelas campanhas, pelo atendimento humano prestado por sua equipe e pela relação comercial com seus clientes finais.</p>
      </Section>

      <Section title="14. Alterações destes termos">
        <p>Podemos atualizar estes termos. Mudanças relevantes serão comunicadas com 30 dias de antecedência por e-mail ou notificação dentro da plataforma.</p>
        <p>O uso continuado após a entrada em vigor representa concordância com a versão atualizada.</p>
      </Section>

      <Section title="15. Lei aplicável">
        <p>Estes termos são regidos pelas leis da República Federativa do Brasil. O foro é o definido no contrato assinado, salvo disposição legal obrigatória em contrário.</p>
      </Section>

      <Section title="16. Contato">
        <p>
          <a href={`mailto:${company.contactEmail}`} className="text-blue-600 dark:text-blue-300 underline">
            {company.contactEmail}
          </a>
        </p>
      </Section>
    </main>
  </div>
);

export default TermsOfService;
