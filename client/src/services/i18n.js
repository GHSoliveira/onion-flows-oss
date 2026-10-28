const translations = {
  pt: {
    auth: {
      login: 'Entrar',
      logout: 'Sair',
      username: 'Usuário',
      password: 'Senha',
      forgotPassword: 'Esqueci minha senha',
    },
    nav: {
      monitor: 'Monitoramento',
      logs: 'Logs de Auditoria',
      flows: 'Fluxos de Conversa',
      templates: 'Templates (HSM)',
      variables: 'Variáveis',
      users: 'Gestão de Equipe',
      schedules: 'Expediente',
      simulator: 'Simulador Bot',
      agent: 'Meu Atendimento',
    },
    common: {
      save: 'Salvar',
      cancel: 'Cancelar',
      delete: 'Excluir',
      edit: 'Editar',
      create: 'Criar',
      update: 'Atualizar',
      search: 'Buscar',
      loading: 'Carregando...',
      success: 'Sucesso!',
      error: 'Erro',
      confirm: 'Confirmar',
    },
    flows: {
      title: 'Gerenciar Fluxos',
      create: 'Novo Fluxo',
      edit: 'Editar Fluxo',
      publish: 'Publicar',
      validate: 'Validar',
      preview: 'Preview',
      export: 'Exportar',
      import: 'Importar',
    },
    chat: {
      newMessage: 'Nova mensagem',
      typing: 'Digitando...',
      online: 'Online',
      offline: 'Offline',
      send: 'Enviar',
      record: 'Gravar',
    },
  },
  en: {
    auth: {
      login: 'Login',
      logout: 'Logout',
      username: 'Username',
      password: 'Password',
      forgotPassword: 'Forgot password',
    },
    nav: {
      monitor: 'Monitoring',
      logs: 'Audit Logs',
      flows: 'Conversation Flows',
      templates: 'Templates (HSM)',
      variables: 'Variables',
      users: 'Team Management',
      schedules: 'Business Hours',
      simulator: 'Bot Simulator',
      agent: 'My Workspace',
    },
    common: {
      save: 'Save',
      cancel: 'Cancel',
      delete: 'Delete',
      edit: 'Edit',
      create: 'Create',
      update: 'Update',
      search: 'Search',
      loading: 'Loading...',
      success: 'Success!',
      error: 'Error',
      confirm: 'Confirm',
    },
    flows: {
      title: 'Manage Flows',
      create: 'New Flow',
      edit: 'Edit Flow',
      publish: 'Publish',
      validate: 'Validate',
      preview: 'Preview',
      export: 'Export',
      import: 'Import',
    },
    chat: {
      newMessage: 'New message',
      typing: 'Typing...',
      online: 'Online',
      offline: 'Offline',
      send: 'Send',
      record: 'Record',
    },
  },
};

export const getTranslation = (key, lang = 'pt') => {
  const keys = key.split('.');
  let value = translations[lang];

  for (const k of keys) {
    if (value && value[k]) {
      value = value[k];
    } else {
      return key;
    }
  }

  return value;
};

export const getLanguage = () => localStorage.getItem('language') || 'pt';

export const setLanguage = (lang) => {
  localStorage.setItem('language', lang);
  document.documentElement.lang = lang;
};

export const availableLanguages = [
  { code: 'pt', name: 'Português', flag: '🇧🇷' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
];

export default { getTranslation, getLanguage, setLanguage, availableLanguages };
