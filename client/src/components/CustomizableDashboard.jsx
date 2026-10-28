import { useState, useEffect } from 'react';
import { GripVertical, Trash2, Settings, Maximize2, Minimize2 } from 'lucide-react';

const defaultWidgets = [
  { id: 'kpi-cards', title: 'KPI Cards', type: 'kpi', size: 'large', position: { x: 0, y: 0 } },
  { id: 'active-charts', title: 'Gráficos Ativos', type: 'chart', size: 'large', position: { x: 1, y: 0 } },
  { id: 'agent-list', title: 'Lista de Agentes', type: 'list', size: 'medium', position: { x: 0, y: 2 } },
  { id: 'queue-stats', title: 'Estatísticas de Fila', type: 'stats', size: 'medium', position: { x: 1, y: 2 } },
  { id: 'recent-chats', title: 'Chats Recentes', type: 'table', size: 'large', position: { x: 0, y: 3 } },
  { id: 'sla-monitor', title: 'Monitoramento SLA', type: 'sla', size: 'medium', position: { x: 1, y: 3 } },
];

const CustomizableDashboard = () => {
  const [widgets, setWidgets] = useState(() => {
    const saved = localStorage.getItem('dashboardWidgets');
    return saved ? JSON.parse(saved) : defaultWidgets;
  });

  const [editing, setEditing] = useState(false);
  const [draggedWidget, setDraggedWidget] = useState(null);

  useEffect(() => {
    localStorage.setItem('dashboardWidgets', JSON.stringify(widgets));
  }, [widgets]);

  const handleDragStart = (e, widget) => {
    setDraggedWidget(widget);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e, targetWidget) => {
    e.preventDefault();

    if (!draggedWidget || draggedWidget.id === targetWidget.id) return;

    const newWidgets = widgets.map(w => {
      if (w.id === draggedWidget.id) {
        return { ...w, position: targetWidget.position };
      }
      if (w.id === targetWidget.id) {
        return { ...w, position: draggedWidget.position };
      }
      return w;
    });

    setWidgets(newWidgets);
    setDraggedWidget(null);
  };

  const removeWidget = (widgetId) => {
    setWidgets(widgets.filter(w => w.id !== widgetId));
  };

  const toggleWidgetSize = (widgetId) => {
    const newWidgets = widgets.map(w => {
      if (w.id === widgetId) {
        const isLarge = w.size === 'large';
        return { ...w, size: isLarge ? 'medium' : 'large' };
      }
      return w;
    });
    setWidgets(newWidgets);
  };

  const resetToDefault = () => {
    setWidgets(defaultWidgets);
  };

  const renderWidgetContent = (widget) => {
    switch (widget.type) {
      case 'kpi':
        return (
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-value">42</div>
              <div className="kpi-label">Chats Ativos</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">8</div>
              <div className="kpi-label">Agentes Online</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">2.3min</div>
              <div className="kpi-label">Tempo Médio Resposta</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">94%</div>
              <div className="kpi-label">SLA Cumprido</div>
            </div>
          </div>
        );

      case 'chart':
        return (
          <div className="widget-chart-placeholder">
            <p>Gráfico de volume de chats</p>
          </div>
        );

      case 'list':
        return (
          <div className="widget-list">
            <div className="widget-list-item">
              <div className="avatar">JS</div>
              <div>
                <div className="name">João Silva</div>
                <div className="status online">Online</div>
              </div>
            </div>
            <div className="widget-list-item">
              <div className="avatar">MA</div>
              <div>
                <div className="name">Maria Costa</div>
                <div className="status online">Online</div>
              </div>
            </div>
            <div className="widget-list-item">
              <div className="avatar">PE</div>
              <div>
                <div className="name">Pedro Santos</div>
                <div className="status offline">Offline</div>
              </div>
            </div>
          </div>
        );

      case 'stats':
        return (
          <div className="widget-stats">
            <div className="stat-row">
              <span>Fila SUPORTE:</span>
              <strong>5 chats</strong>
            </div>
            <div className="stat-row">
              <span>Fila SAC:</span>
              <strong>3 chats</strong>
            </div>
            <div className="stat-row">
              <span>Fila COBRANÇA:</span>
              <strong>1 chat</strong>
            </div>
          </div>
        );

      case 'table':
        return (
          <div className="widget-table">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Fila</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>João Silva</td>
                  <td>SUPORTE</td>
                  <td><span className="badge badge-success">Ativo</span></td>
                </tr>
                <tr>
                  <td>Maria Costa</td>
                  <td>SAC</td>
                  <td><span className="badge badge-warning">Aguardando</span></td>
                </tr>
                <tr>
                  <td>Pedro Santos</td>
                  <td>COBRANÇA</td>
                  <td><span className="badge badge-info">Em Bot</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        );

      case 'sla':
        return (
          <div className="widget-sla">
            <div className="sla-metric">
              <div className="sla-value">94.5%</div>
              <div className="sla-label">Primeira Resposta</div>
            </div>
            <div className="sla-metric">
              <div className="sla-value">89.2%</div>
              <div className="sla-label">Resolução Total</div>
            </div>
          </div>
        );

      default:
        return <div>Widget desconhecido</div>;
    }
  };

  const getWidgetSizeClass = (size) => {
    switch (size) {
      case 'large':
        return 'widget-size-large';
      case 'medium':
        return 'widget-size-medium';
      case 'small':
        return 'widget-size-small';
      default:
        return 'widget-size-medium';
    }
  };

  return (
    <div className="custom-dashboard">
      <div className="dashboard-header">
        <h1 className="dashboard-title">Dashboard</h1>
        <div className="dashboard-actions">
          {editing ? (
            <button onClick={resetToDefault} className="btn btn-secondary">
              Resetar para Padrão
            </button>
          ) : null}
          <button
            onClick={() => setEditing(!editing)}
            className={`btn ${editing ? 'btn-danger' : 'btn-secondary'}`}
          >
            <Settings size={16} />
            {editing ? 'Sair do Modo Edição' : 'Personalizar'}
          </button>
        </div>
      </div>

      <div className="dashboard-grid">
        {widgets.map(widget => (
          <div
            key={widget.id}
            className={`dashboard-widget ${getWidgetSizeClass(widget.size)} ${editing ? 'editing' : ''}`}
            style={{
              gridColumn: `span ${widget.size === 'large' ? 2 : 1}`,
              gridRow: `span ${widget.size === 'large' ? 2 : 1}`,
            }}
            draggable={editing}
            onDragStart={(e) => handleDragStart(e, widget)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, widget)}
          >
            {editing && (
              <div className="widget-controls">
                <button
                  onClick={() => toggleWidgetSize(widget.id)}
                  className="widget-control-btn"
                  aria-label="Alternar tamanho"
                >
                  {widget.size === 'large' ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button
                  onClick={() => removeWidget(widget.id)}
                  className="widget-control-btn widget-remove-btn"
                  aria-label="Remover widget"
                >
                  <Trash2 size={16} />
                </button>
                <GripVertical size={16} className="widget-drag-handle" />
              </div>
            )}

            <div className="widget-content">
              <div className="widget-header">
                <h3 className="widget-title">{widget.title}</h3>
              </div>
              <div className="widget-body">
                {renderWidgetContent(widget)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CustomizableDashboard;
