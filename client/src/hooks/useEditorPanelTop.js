import { useLayoutEffect, useState } from 'react';

// Altura onde terminam as barras do topo do editor de fluxo. As barras laterais
// (configuracao do node, integracoes) comecam ali para nao cobrir o Salvar e o
// Publicar. Sem o editor na tela, cai no topo do painel (64px).
const medir = () => {
  const cabecalho = document.querySelector('[data-flow-editor-header]');
  const fundo = cabecalho?.getBoundingClientRect().bottom;
  return fundo && fundo > 0 ? Math.round(fundo) : 64;
};

const useEditorPanelTop = (ativo = true) => {
  const [topo, setTopo] = useState(64);

  useLayoutEffect(() => {
    if (!ativo) return undefined;
    const atualizar = () => setTopo(medir());
    atualizar();
    window.addEventListener('resize', atualizar);
    return () => window.removeEventListener('resize', atualizar);
  }, [ativo]);

  return topo;
};

export default useEditorPanelTop;
