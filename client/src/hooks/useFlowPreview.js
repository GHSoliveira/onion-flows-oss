import { useState, useEffect } from 'react';

const useFlowPreview = (nodes, edges, triggerPreview = false) => {
  const [preview, setPreview] = useState(null);
  const [currentNode, setCurrentNode] = useState(null);
  const [previewHistory, setPreviewHistory] = useState([]);

  const startPreview = () => {
    const startNode = nodes.find(n => n.type === 'startNode');
    if (startNode) {
      setCurrentNode(startNode);
      setPreviewHistory([startNode]);
      setPreview({
        started: true,
        currentNode: startNode,
        variables: {},
        messages: [],
      });
    }
  };

  const stopPreview = () => {
    setPreview(null);
    setCurrentNode(null);
    setPreviewHistory([]);
  };

  const moveToNextNode = (output = 'default') => {
    if (!currentNode) return;

    const nextEdge = edges.find(e => e.source === currentNode.id && (e.sourceHandle === output || output === 'default'));
    if (nextEdge) {
      const nextNode = nodes.find(n => n.id === nextEdge.target);
      if (nextNode) {
        setCurrentNode(nextNode);
        setPreviewHistory(prev => [...prev, nextNode]);

        const newNodeData = processNode(nextNode, preview.variables);

        setPreview(prev => ({
          ...prev,
          currentNode: nextNode,
          messages: [...prev.messages, newNodeData],
          variables: { ...prev.variables, ...newNodeData.variables },
        }));

        if (nextNode.type === 'endNode' || nextNode.type === 'finalNode') {
          setPreview(prev => ({ ...prev, completed: true }));
        }
      }
    }
  };

  const processNode = (node, variables) => {
    switch (node.type) {
      case 'messageNode':
        return {
          type: 'message',
          text: parseVariables(node.data?.message || '', variables),
        };

      case 'inputNode':
        return {
          type: 'input',
          prompt: parseVariables(node.data?.prompt || '', variables),
          variableName: node.data?.variableName,
        };

      case 'setValueNode':
        const newValue = evaluateExpression(node.data?.value || '', variables);
        return {
          type: 'set_value',
          variableName: node.data?.variableName,
          value: newValue,
          variables: { [node.data?.variableName]: newValue },
        };
      case 'menuNode':
        return {
          type: 'menu',
          text: parseVariables(node.data?.text || '', variables),
        };
      case 'secretNode':
        const secretValue = evaluateExpression(node.data?.value || '', variables);
        return {
          type: 'set_value',
          variableName: node.data?.variableName,
          value: secretValue,
          variables: { [node.data?.variableName]: secretValue },
        };

      case 'conditionNode':
        const conditionResult = evaluateCondition(node.data?.condition || '', variables);
        return {
          type: 'condition',
          condition: node.data?.condition,
          result: conditionResult,
          output: conditionResult ? 'true' : 'false',
        };

      case 'delayNode':
        return {
          type: 'delay',
          duration: node.data?.duration || 1000,
        };

      case 'scriptNode':
        try {
          const scriptResult = evaluatePreviewExpression(node.data?.script || '', variables);
          return {
            type: 'script',
            result: scriptResult,
            variables: { ...variables, ...scriptResult },
          };
        } catch (error) {
          return {
            type: 'script_error',
            error: error.message,
          };
        }

      default:
        return { type: 'unknown', node };
    }
  };

  const parseVariables = (text, variables) => {
    return text.replace(/\{(\w+)\}/g, (match, varName) => {
      return variables[varName] !== undefined ? variables[varName] : match;
    });
  };

  const evaluateExpression = (expr, variables) => {
    try {
      const parsed = parseVariables(expr, variables);
      return Function('"use strict";return (' + parsed + ')')();
    } catch {
      return expr;
    }
  };

  const evaluateCondition = (condition, variables) => {
    try {
      const parsed = parseVariables(condition, variables);
      return Function('"use strict";return (' + parsed + ')')();
    } catch {
      return false;
    }
  };

  const evaluatePreviewExpression = (script, variables) => {
    const allowedKeys = Object.keys(variables);
    const values = Object.values(variables);

    try {
      const func = Function(...allowedKeys, 'return ' + script);
      return func(...values);
    } catch {
      return null;
    }
  };

  const resetPreview = () => {
    startPreview();
  };

  useEffect(() => {
    if (triggerPreview) {
      startPreview();
    }
  }, [triggerPreview, nodes, edges]);

  return {
    preview,
    currentNode,
    previewHistory,
    startPreview,
    stopPreview,
    moveToNextNode,
    resetPreview,
  };
};

export default useFlowPreview;
