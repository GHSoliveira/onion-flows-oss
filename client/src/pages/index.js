import React from 'react';
import Login from './pages/Login';
import FlowList from './pages/FlowList';
import VariableManager from './pages/VariableManager';
import TemplateManager from './pages/TemplateManager';
import AgentManager from './pages/AgentManager';
import ScheduleManager from './pages/ScheduleManager';
import SystemLogs from './pages/SystemLogs';
import MonitoringDashboard from './pages/MonitoringDashboard';
import Channels from './pages/Channels';
import Catalog from './pages/Catalog';

const FlowEditor = React.lazy(() => import('./pages/FlowEditor'));
const AgentWorkspace = React.lazy(() => import('./pages/AgentWorkspace'));

export {
  Login,
  FlowList,
  VariableManager,
  TemplateManager,
  AgentManager,
  ScheduleManager,
  SystemLogs,
  MonitoringDashboard,
  Channels,
  Catalog,
  FlowEditor,
  AgentWorkspace,
};
