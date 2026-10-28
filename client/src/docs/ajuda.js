// Ajuda para quem usa o painel no dia a dia: atendente, gestor e responsavel
// pela conta. A documentacao em /docs continua sendo a referencia tecnica; aqui
// cada resposta e curta e usa o nome que aparece na tela.

import { contatoSuporte } from '../config/instancia';

export const contato = {
  whatsapp: contatoSuporte.whatsapp
    ? `https://wa.me/${contatoSuporte.whatsapp}?text=Ol%C3%A1!%20Preciso%20de%20ajuda%20com%20o%20Onion%20Flows.`
    : null,
  email: contatoSuporte.email
};

export const grupos = [
  {
    id: 'atendente',
    titulo: 'Para quem atende',
    resumo: 'O dia a dia no painel: pegar conversa, transferir, encerrar e atender ligação.',
    itens: [
      {
        pergunta: 'Como pego uma conversa que está esperando?',
        passos: [
          'Abra Meu Atendimento.',
          'Na lista de espera, clique em Puxar atendimento na conversa que quer pegar.',
          'Para pegar todas de uma vez, use Puxar todos em espera.'
        ],
        nota: 'Você só vê a espera das filas em que está cadastrado. Se a fila certa não aparece, peça ao administrador para te incluir nela.'
      },
      {
        pergunta: 'Não está chegando nenhuma conversa para mim',
        marcadores: [
          'Confira se você aparece como online: a presença vem do painel aberto.',
          'Confira em quais filas você está, no menu Usuários e filas (ou peça ao administrador).',
          'Se a conversa ainda está com o robô, ela só entra na fila quando o fluxo mandar.',
          'Se estiver com limite de atendimentos simultâneos atingido, o sistema não entrega mais nenhuma.'
        ]
      },
      {
        pergunta: 'Como passo a conversa para outra pessoa ou fila?',
        passos: [
          'Com a conversa aberta, clique em Transferir atendimento, no topo.',
          'Escolha a fila ou a pessoa que vai receber.',
          'A conversa mantém todo o histórico, e a troca fica registrada na linha do tempo.'
        ]
      },
      {
        pergunta: 'Como encerro o atendimento?',
        passos: [
          'Clique em Encerrar, no topo da conversa.',
          'Confirme na janela que aparece.'
        ],
        nota: 'Encerrar envia a mensagem de encerramento configurada, quando existir. Se o fluxo previr pesquisa de satisfação, ela é enviada depois do encerramento.'
      },
      {
        pergunta: 'O cliente não recebeu minha mensagem',
        marcadores: [
          'O WhatsApp só permite mensagem livre dentro de 24 horas desde a última mensagem do cliente.',
          'Passadas as 24 horas, o envio precisa ser por template aprovado, pelo Atendimento ativo.',
          'Se aparecer falha no envio, o motivo fica no detalhe da mensagem e em Ocorrências.',
          'Número errado ou que não tem WhatsApp também aparece como falha.'
        ]
      },
      {
        pergunta: 'Como uso mensagens prontas?',
        passos: [
          'Na conversa, abra Mensagens rápidas.',
          'Escolha a mensagem: ela entra no campo de texto e você ainda pode editar antes de enviar.'
        ],
        nota: 'Quem cadastra as mensagens é o administrador, em Usuários e filas.'
      },
      {
        pergunta: 'Como atendo uma ligação do WhatsApp?',
        marcadores: [
          'A ligação só toca para quem está com o painel aberto e faz parte da fila configurada.',
          'Quando tocar, aparece um aviso na tela com Atender e Recusar.',
          'O navegador vai pedir permissão para usar o microfone na primeira vez.',
          'Se ninguém atender, o cliente recebe a mensagem de ligação perdida, quando estiver ativada.'
        ]
      },
      {
        pergunta: 'O que o cliente vê enquanto espera?',
        paragrafos: [
          'Depende do que estiver configurado na fila: existe uma mensagem de entrada, enviada quando ele entra na espera, e uma mensagem de espera, para quando demora.',
          'Quem edita esses textos é o administrador, na tela de filas.'
        ]
      }
    ]
  },
  {
    id: 'gestor',
    titulo: 'Para quem administra',
    resumo: 'Equipe, filas, horário, acompanhamento da operação e campanhas.',
    itens: [
      {
        pergunta: 'Como adiciono uma pessoa na equipe?',
        passos: [
          'Abra Usuários e filas.',
          'Clique em Novo usuário e preencha nome, login e papel.',
          'Marque as filas em que ela vai atender.',
          'Entregue o login para a pessoa e peça para trocar a senha no primeiro acesso.'
        ],
        nota: 'Papel define o que a pessoa vê: atendente atende, gestor acompanha, administrador configura.'
      },
      {
        pergunta: 'Como crio uma fila?',
        passos: [
          'Abra Usuários e filas e vá na parte de filas.',
          'Dê um nome que o time entenda, como RECEPÇÃO ou FINANCEIRO.',
          'Escreva a mensagem de entrada e a de espera.',
          'Inclua os atendentes que vão receber dessa fila.',
          'No fluxo, aponte o nó de fila para ela.'
        ]
      },
      {
        pergunta: 'Como defino o horário de atendimento?',
        passos: [
          'Abra Expediente.',
          'Crie um horário com os dias e as faixas de hora.',
          'No fluxo, use o nó de expediente para separar o que acontece dentro e fora do horário.'
        ]
      },
      {
        pergunta: 'Onde vejo quem está esperando agora?',
        paragrafos: [
          'Em Monitoramento. Ele mostra as conversas ativas, quem está na espera, há quanto tempo e com qual atendente, além do resumo por fila.',
          'Para o que já terminou, use Histórico. Para números do mês, use Analíticas.'
        ]
      },
      {
        pergunta: 'Como funciona a nota do cliente?',
        paragrafos: [
          'A nota vem de um nó de avaliação no fluxo, normalmente depois do encerramento.',
          'Ela é registrada para o atendente que conduziu a conversa e aparece no painel dele, nas analíticas e no relatório do mês.'
        ]
      },
      {
        pergunta: 'Como disparo mensagem para vários contatos?',
        marcadores: [
          'Vá em Contatos, selecione quem vai receber e use o disparo em massa.',
          'Fora da janela de 24 horas, o WhatsApp exige template aprovado, e a Meta cobra por conversa iniciada.',
          'A campanha pausa sozinha se a Meta sinalizar queda de qualidade do número ou do template.',
          'Acompanhe o resultado em Campanhas.'
        ],
        nota: 'Só envie para quem tem relação com a empresa ou autorizou o contato. Lista comprada ou raspada coloca o número em risco.'
      },
      {
        pergunta: 'Uma mensagem falhou. Onde vejo o motivo?',
        paragrafos: [
          'Em Ocorrências ficam as falhas do sistema, com o código devolvido pelo WhatsApp e quantas vezes aconteceu.',
          'Em Auditoria fica quem fez o quê no painel.'
        ]
      }
    ]
  },
  {
    id: 'conta',
    titulo: 'Conta e acesso',
    resumo: 'Senha, dados do seu usuário e privacidade.',
    itens: [
      {
        pergunta: 'Esqueci minha senha',
        paragrafos: [
          'Peça ao administrador da sua empresa para gerar uma nova em Usuários e filas.',
          'Se você é o administrador e perdeu o acesso, fale com a Onion pelos contatos no fim desta página.'
        ]
      },
      {
        pergunta: 'Como mudo meu nome, foto ou preferências?',
        passos: [
          'Clique no ícone de configurações, no topo do painel.',
          'Ajuste o que precisar em Preferências.'
        ]
      },
      {
        pergunta: 'Quem consegue ver as conversas?',
        marcadores: [
          'Atendente vê as conversas das filas dele e as que assumiu.',
          'Gestor e administrador acompanham a operação da própria empresa.',
          'Os dados de uma empresa não aparecem para outra.',
          'Senhas, tokens e segredos nunca aparecem para atendente ou gestor.'
        ]
      },
      {
        pergunta: 'Como peço para apagar os dados de um cliente?',
        paragrafos: [
          'O administrador faz isso em Contatos, pela opção de apagar dados do titular, informando o telefone.',
          'A exclusão cobre conversas, mensagens e registros daquele contato, conforme a LGPD.'
        ]
      }
    ]
  }
];

export const textoDoItem = (item) => [
  item.pergunta,
  ...(item.paragrafos || []),
  ...(item.marcadores || []),
  ...(item.passos || []),
  item.nota
].filter(Boolean).join(' ').toLowerCase();
