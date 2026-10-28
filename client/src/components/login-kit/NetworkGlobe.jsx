import { useEffect, useMemo, useRef } from 'react';
import createGlobe from 'cobe';
import './NetworkGlobe.css';

const HUB = [-24.18, -53.02];

const MARKERS = [
  { location: HUB, size: 0.026, color: [1, 1, 1] },
  { location: [-23.55, -46.63], size: 0.013 },
  { location: [-25.43, -49.27], size: 0.012 },
  { location: [25.76, -80.19], size: 0.012 },
  { location: [38.72, -9.14], size: 0.012 },
  { location: [35.68, 139.65], size: 0.011 }
];

const createCage = (count = 52) => {
  const points = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = goldenAngle * index;
    points.push({ x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius });
  }

  const edgeKeys = new Set();
  const edges = [];
  points.forEach((point, pointIndex) => {
    const nearest = points
      .map((candidate, candidateIndex) => ({
        candidateIndex,
        distance: Math.hypot(point.x - candidate.x, point.y - candidate.y, point.z - candidate.z)
      }))
      .filter(item => item.candidateIndex !== pointIndex)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);

    nearest.forEach(({ candidateIndex }) => {
      const from = Math.min(pointIndex, candidateIndex);
      const to = Math.max(pointIndex, candidateIndex);
      const key = `${from}-${to}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push([from, to]);
    });
  });

  return { points, edges };
};

const rotatePoint = (point, phi, theta) => {
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const x = point.x * cosPhi + point.z * sinPhi;
  const z = -point.x * sinPhi + point.z * cosPhi;

  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  return {
    x,
    y: point.y * cosTheta - z * sinTheta,
    z: point.y * sinTheta + z * cosTheta
  };
};

const NetworkGlobe = () => {
  const stageRef = useRef(null);
  const globeCanvasRef = useRef(null);
  const cageCanvasRef = useRef(null);
  const globeRef = useRef(null);
  const frameRef = useRef(null);
  const phiRef = useRef(0.6);
  const sizeRef = useRef(0);
  const cage = useMemo(() => createCage(52), []);

  useEffect(() => {
    const stage = stageRef.current;
    const globeCanvas = globeCanvasRef.current;
    const cageCanvas = cageCanvasRef.current;
    if (!stage || !globeCanvas || !cageCanvas) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = Boolean(window.navigator?.connection?.saveData);
    const dpr = Math.min(window.devicePixelRatio || 1, saveData ? 1 : 1.5);
    const theta = 0.18;

    const rebuild = () => {
      const size = Math.max(1, Math.round(stage.getBoundingClientRect().width));
      const renderSize = Math.round(size * dpr);
      sizeRef.current = size;
      cageCanvas.width = renderSize;
      cageCanvas.height = renderSize;

      globeRef.current?.destroy();
      try {
        globeRef.current = createGlobe(globeCanvas, {
          devicePixelRatio: dpr,
          width: renderSize,
          height: renderSize,
          phi: phiRef.current,
          theta,
          dark: 1,
          diffuse: 1.15,
          mapSamples: saveData ? 9000 : 18000,
          mapBrightness: 10,
          mapBaseBrightness: 0.055,
          baseColor: [0.64, 0.74, 0.94],
          markerColor: [1, 1, 1],
          glowColor: [0.16, 0.3, 0.56],
          markers: MARKERS,
          markerElevation: 0.015,
          scale: 0.82,
          opacity: 0.92,
          context: { alpha: true, antialias: false, premultipliedAlpha: true }
        });
      } catch (error) {
        console.warn('NetworkGlobe: WebGL indisponível.', error);
        globeRef.current = null;
      }
    };

    const drawCage = elapsed => {
      const size = sizeRef.current;
      const context = cageCanvas.getContext('2d');
      if (!context || !size) return;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, size, size);

      const center = size / 2;
      const radius = size * 0.445;
      const projected = cage.points.map(point => {
        const rotated = rotatePoint(point, phiRef.current * 0.82, theta * 0.65);
        return {
          x: center + rotated.x * radius,
          y: center - rotated.y * radius,
          z: rotated.z
        };
      });

      cage.edges.forEach(([fromIndex, toIndex], edgeIndex) => {
        const from = projected[fromIndex];
        const to = projected[toIndex];
        const depth = Math.max(0, Math.min(1, ((from.z + to.z) * 0.5 + 1) * 0.5));
        const alpha = 0.085 + depth * 0.28;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.strokeStyle = `rgba(255,255,255,${alpha})`;
        context.lineWidth = depth > 0.48 ? 0.95 : 0.62;
        context.stroke();

        if (edgeIndex % 11 === 0 && !reducedMotion) {
          const progress = (elapsed * 0.00012 + edgeIndex * 0.071) % 1;
          const pulseX = from.x + (to.x - from.x) * progress;
          const pulseY = from.y + (to.y - from.y) * progress;
          context.beginPath();
          context.arc(pulseX, pulseY, 1.15, 0, Math.PI * 2);
          context.fillStyle = `rgba(255,255,255,${0.2 + depth * 0.55})`;
          context.fill();
        }
      });

      projected.forEach(point => {
        const depth = Math.max(0, Math.min(1, (point.z + 1) * 0.5));
        context.beginPath();
        context.arc(point.x, point.y, 0.75 + depth * 0.65, 0, Math.PI * 2);
        context.fillStyle = `rgba(255,255,255,${0.18 + depth * 0.66})`;
        context.fill();
      });
    };

    const render = elapsed => {
      if (!document.hidden) {
        if (!reducedMotion) phiRef.current += 0.00125;
        globeRef.current?.update({ phi: phiRef.current });
        drawCage(elapsed);
      }
      if (!reducedMotion) frameRef.current = window.requestAnimationFrame(render);
    };

    rebuild();
    drawCage(0);
    if (!reducedMotion) frameRef.current = window.requestAnimationFrame(render);

    let resizeFrame = null;
    const resizeObserver = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(rebuild);
    });
    resizeObserver.observe(stage);

    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(resizeFrame);
      window.cancelAnimationFrame(frameRef.current);
      globeRef.current?.destroy();
      globeRef.current = null;
    };
  }, [cage]);

  return (
    <div className="network-globe" aria-hidden="true">
      <div ref={stageRef} className="network-globe__stage">
        <canvas ref={globeCanvasRef} className="network-globe__earth" />
        <canvas ref={cageCanvasRef} className="network-globe__cage" />
      </div>
      <div className="network-globe__veil" />
    </div>
  );
};

export default NetworkGlobe;
