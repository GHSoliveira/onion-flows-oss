import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { empresa } from '../config/instancia';

/**
 * Página pública de privacidade. Rota /privacidade — sem auth.
 * O conteúdo espelha docs/PRIVACY_POLICY_TEMPLATE.md.
 */

// A razao social do MEI e o nome civil do titular, entao nao aparece nesta
// pagina publica de proposito: o CNPJ ja torna a empresa identificavel para
// efeito da LGPD, sem expor o nome pessoal. A razao social consta do contrato
// e do DPA, que sao instrumentos assinados.
const company = empresa;

// `id` permite linkar direto para uma secao. Usado na URL de instrucoes de
// exclusao de dados exigida pela Meta, que precisa levar a pessoa exatamente ao
// texto que explica como pedir, e nao ao topo da politica inteira.
const Section = ({ title, children, id = null }) => (
  <section id={id} className="mb-8 scroll-mt-6">
    <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-2">{title}</h2>
    <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed space-y-3">{children}</div>
  </section>
);

const PrivacyPolicy = () => (
  <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
    <header className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
      <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
        <Link to="/login" className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md">
          <ArrowLeft size={18} />
        </Link>
        <ShieldCheck size={20} className="text-blue-600" />
        <h1 className="text-base font-semibold text-slate-800 dark:text-slate-100">Política de Privacidade</h1>
      </div>
    </header>

    <main className="max-w-3xl mx-auto px-4 py-8">
      <p className="text-xs text-slate-500 mb-6">Última atualização: {company.lastUpdated}</p>

      <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed mb-6">
        Esta política descreve como tratamos dados pessoais na plataforma <strong>{company.name}</strong>, em
        conformidade com a Lei Geral de Proteção de Dados (Lei 13.709/2018 — LGPD).
      </p>

      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/40 rounded-lg p-4 mb-8 text-sm text-blue-900 dark:text-blue-200">
        A {company.name} é uma plataforma B2B de automação e atendimento conversacional. O cliente final,
        isto é, a pessoa atendida por uma empresa usuária da solução, não acessa diretamente a plataforma.
        Ele interage apenas pelos canais de atendimento configurados, como WhatsApp, Telegram ou outros
        meios digitais.
        <br /><br />
        A operação dos fluxos, automações, integrações e análises pode ser conduzida diretamente pelo
        {` ${company.name}`}, enquanto a empresa contratante utiliza a plataforma principalmente para
        atendimento humano, acompanhamento de conversas e acesso a relatórios/indicadores. Conforme o caso
        concreto, o {company.name} pode atuar como <strong>controlador</strong> de determinados tratamentos
        e/ou como <strong>operador</strong> em nome da empresa contratante.
      </div>

      <Section title="1. Quem somos">
        <p>O {company.name} é uma plataforma operada pela <strong>{company.companyName}</strong>, inscrita no CNPJ sob o número <strong>{company.cnpj}</strong>, com operação baseada no Brasil.</p>
        <p>A plataforma oferece ferramentas para automação de atendimentos, organização de conversas, roteamento de fluxos, suporte operacional, atendimento humano e geração de relatórios/indicadores via canais digitais como WhatsApp, Telegram e outros meios integrados.</p>
        <p>O endereço completo da sede consta dos contratos firmados com as empresas contratantes e pode ser solicitado a qualquer momento pelo e-mail de contato abaixo.</p>
        <p>Contato para assuntos de privacidade e proteção de dados: <a href={`mailto:${company.contactEmail}`} className="text-blue-600 dark:text-blue-300 underline">{company.contactEmail}</a>.</p>
      </Section>

      <Section title="2. Que dados tratamos">
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Cadastro de usuários operadores da plataforma</strong>: nome, e-mail corporativo, senha com hash, papel e telefone opcional.</li>
          <li><strong>Atendimentos</strong>: nome, telefone, mensagens trocadas, identificadores do canal, como WhatsApp ID, informações fornecidas pelo cliente final durante a conversa, variáveis coletadas pela automação, metadados, horário, canal, status da fila, agente responsável e, quando configurado para um caso específico, outros dados necessários ao atendimento.</li>
          <li><strong>Operacional/segurança</strong>: logs de acesso, IP, user-agent, registro de tentativas de login e mudanças administrativas.</li>
          <li><strong>Faturamento da empresa contratante</strong>: CNPJ quando aplicável, e-mail de cobrança, status de pagamento e dados necessários à gestão comercial.</li>
        </ul>
      </Section>

      <Section title="3. Por que tratamos">
        <table className="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md">
          <thead className="bg-slate-100 dark:bg-slate-800">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">Finalidade</th>
              <th className="text-left px-3 py-2 font-semibold">Base legal</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-200 dark:border-slate-700"><td className="px-3 py-2">Executar contrato de prestação de serviço com a empresa contratante</td><td className="px-3 py-2">Art. 7, V</td></tr>
            <tr className="border-t border-slate-200 dark:border-slate-700"><td className="px-3 py-2">Operar fluxos, automações, roteamentos, integrações e atendimento humano</td><td className="px-3 py-2">Execução de contrato e legítimo interesse</td></tr>
            <tr className="border-t border-slate-200 dark:border-slate-700"><td className="px-3 py-2">Gerar relatórios, métricas operacionais e análises para a empresa contratante</td><td className="px-3 py-2">Execução de contrato e legítimo interesse</td></tr>
            <tr className="border-t border-slate-200 dark:border-slate-700"><td className="px-3 py-2">Atender solicitações do titular feitas diretamente ao Onion Web Flows ou por meio da empresa contratante</td><td className="px-3 py-2">Art. 7, II</td></tr>
            <tr className="border-t border-slate-200 dark:border-slate-700"><td className="px-3 py-2">Segurança da plataforma e prevenção a fraude</td><td className="px-3 py-2">Art. 7, IX (legítimo interesse)</td></tr>
            <tr className="border-t border-slate-200 dark:border-slate-700"><td className="px-3 py-2">Faturamento</td><td className="px-3 py-2">Execução de contrato</td></tr>
          </tbody>
        </table>
      </Section>

      <Section title="4. Com quem compartilhamos">
        <p>Fornecedores e suboperadores com obrigações contratuais compatíveis com esta política: Oracle Cloud Infrastructure (hospedagem da aplicação, região Vinhedo/SP), Supabase (banco de dados PostgreSQL, sobre AWS, região São Paulo/SP), Vercel (hospedagem da interface web), Cloudflare (roteamento e proteção do tráfego), WhatsApp Business API (Meta), Telegram Bot API.</p>
        <p>Não vendemos dados pessoais. Não usamos dados de atendimentos para treinar modelos de IA ou para finalidades incompatíveis com a prestação do serviço contratado.</p>
      </Section>

      <Section title="5. Transferência internacional">
        <p>Os dados da plataforma são armazenados no Brasil: a aplicação roda na Oracle Cloud, região Vinhedo/SP, e o banco de dados no Supabase sobre AWS, região São Paulo/SP.</p>
        <p>Há transferência internacional nas integrações de mensageria: as rotas da API do WhatsApp passam por servidores da Meta e as do Telegram por servidores da Telegram, ambos fora do Brasil. Nesses casos aplicamos as garantias adequadas previstas na LGPD, como cláusulas contratuais padrão e/ou decisão de adequação.</p>
      </Section>

      <Section title="6. Retenção">
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Conversas encerradas</strong>: prazo definido conforme a operação contratada e necessidade de auditoria, histórico de atendimento ou suporte.</li>
          <li><strong>Logs do sistema</strong>: até 30 dias.</li>
          <li><strong>Backups</strong>: até 14 dias após a eliminação na base principal.</li>
        </ul>
      </Section>

      <Section title="7. Seus direitos, incluindo exclusão de dados" id="exclusao-de-dados">
        <p>Como titular, você tem direito a acesso, correção, eliminação, portabilidade, informação sobre compartilhamento, oposição e revogação de consentimento.</p>
        <p><strong>Como exercer:</strong></p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Se você é cliente final atendido por uma empresa que utiliza o {company.name}: você pode direcionar sua solicitação à empresa que te atendeu ou ao {company.name} pelo e-mail <a href={`mailto:${company.contactEmail}`} className="text-blue-600 dark:text-blue-300 underline">{company.contactEmail}</a>. Dependendo do caso, a solicitação poderá ser tratada diretamente pelo {company.name} ou encaminhada/validada com a empresa contratante.</li>
          <li>Se você é usuário operador da plataforma: <a href={`mailto:${company.contactEmail}`} className="text-blue-600 dark:text-blue-300 underline">{company.contactEmail}</a>.</li>
        </ul>
        <p>Responderemos em até 15 dias.</p>
      </Section>

      <Section title="8. Segurança">
        <p>Aplicamos medidas técnicas e organizacionais: TLS na comunicação, senhas com bcrypt, JWT, MFA para administradores, allowlist de IPs em rotas privilegiadas, criptografia at-rest de credenciais de canal, mascaramento de PII em logs, isolamento multi-tenant, auditoria de acessos administrativos.</p>
        <p>Em caso de incidente envolvendo dados pessoais, comunicamos a ANPD e os titulares conforme exigido pela LGPD.</p>
      </Section>

      <Section title="9. Cookies e armazenamento local">
        <p>Não utilizamos cookies de rastreamento nem cookies de terceiros para publicidade.</p>
        <p>Para funcionar, a plataforma guarda informações no armazenamento local do seu navegador (<code>localStorage</code>), no próprio dispositivo. Esses dados não são enviados a terceiros:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Autenticação</strong>: token de sessão e dados do seu usuário (nome, e-mail, papel e empresa vinculada), para manter você conectado entre visitas.</li>
          <li><strong>Preferências</strong>: tema, idioma, som e volume das notificações, layout do painel e empresa selecionada.</li>
          <li><strong>Estado de operação</strong>: última conversa aberta, ordenação dos cards de atendimento e quais dicas do assistente já foram exibidas.</li>
          <li><strong>Experimentos de interface</strong>: identificador da variante atribuída ao seu usuário quando um teste está ativo.</li>
        </ul>
        <p>Esse armazenamento é necessário ao funcionamento da plataforma. Ao sair da sua conta, os dados de autenticação e a empresa selecionada são removidos. Os demais podem ser apagados a qualquer momento limpando os dados do site no navegador.</p>
      </Section>

      <Section title="10. Crianças e adolescentes">
        <p>A plataforma não é dirigida a menores de 18 anos. Se uma empresa contratante atender adolescentes ou crianças via seus canais, ela deve informar previamente essa necessidade para que a operação seja configurada com base legal e cuidados adequados.</p>
      </Section>

      <Section title="11. Mudanças">
        <p>Podemos atualizar esta política. Mudanças relevantes serão comunicadas com 30 dias de antecedência por e-mail ou notificação dentro da plataforma.</p>
      </Section>

      <Section title="12. Contato">
        <p><a href={`mailto:${company.contactEmail}`} className="text-blue-600 dark:text-blue-300 underline">{company.contactEmail}</a></p>
        <p>Você também pode registrar reclamação na <a href="https://www.gov.br/anpd" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-300 underline">Autoridade Nacional de Proteção de Dados (ANPD)</a>.</p>
      </Section>
    </main>

    <footer className="bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 py-4">
      <div className="max-w-3xl mx-auto px-4 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
        <span>© {new Date().getFullYear()} {company.name}</span>
        <Link to="/login" className="hover:text-slate-700 dark:hover:text-slate-300">Voltar ao login</Link>
      </div>
    </footer>
  </div>
);

export default PrivacyPolicy;
