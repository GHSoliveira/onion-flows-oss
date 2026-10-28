import FlowEditor from './FlowEditor';

// O editor de subfluxo e o mesmo editor de fluxo em outro modo. Reaproveita
// canvas, undo, validacao, blocos visuais e o painel de variaveis; o que muda
// e a rota da API, a paleta reduzida e os trilhos fixos de entrada e saida.
export default function SubflowEditor() {
  return <FlowEditor mode="subflow" />;
}
