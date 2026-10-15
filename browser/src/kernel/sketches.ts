import {
  CompoundSketch,
  Sketch,
  Sketches,
  draw,
  drawCircle,
  drawRectangle,
  getOC,
  measureShapeSurfaceProperties,
  type Drawing,
} from 'replicad';
import type { SketchEntity, SketchFeature, Vec2 } from '../types';

export type BuiltSketch = Sketch | CompoundSketch | Sketches;

const MAX_ENTITIES = 256;
const MAX_POLYGON_POINTS = 512;
const MAX_COORDINATE = 1_000_000;
const MIN_LENGTH = 0.000001;
const MIN_AREA = MIN_LENGTH * MIN_LENGTH;

function coordinate(value: number, name: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
    throw new Error(`${name}: introduce un número finito entre -1.000.000 y 1.000.000 mm.`);
  }
}

function dimension(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= MIN_LENGTH || value > MAX_COORDINATE) {
    throw new Error(`${name}: debe ser mayor que 0,000001 y como máximo 1.000.000 mm.`);
  }
}

function near(a: Vec2, b: Vec2): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= MIN_LENGTH;
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return Math.abs(cross(a, b, p)) <= MIN_LENGTH * length
    && p[0] >= Math.min(a[0], b[0]) - MIN_LENGTH
    && p[0] <= Math.max(a[0], b[0]) + MIN_LENGTH
    && p[1] >= Math.min(a[1], b[1]) - MIN_LENGTH
    && p[1] <= Math.max(a[1], b[1]) + MIN_LENGTH;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0)
    || onSegment(a, b, c) || onSegment(a, b, d)
    || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Accept a repeated closing vertex, but never mutate the document's points. */
function polygonPoints(entity: Extract<SketchEntity, { type: 'polygon' }>): Vec2[] {
  if (!Array.isArray(entity.points)
    || entity.points.length < 3 || entity.points.length > MAX_POLYGON_POINTS) {
    throw new Error('Un polígono necesita entre 3 y 512 puntos.');
  }
  const points = entity.points.map((point, index): Vec2 => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new Error(`Punto ${index + 1}: se necesitan dos coordenadas.`);
    }
    coordinate(point[0], `Punto ${index + 1}, X`);
    coordinate(point[1], `Punto ${index + 1}, Y`);
    return [point[0], point[1]];
  });
  if (near(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3) throw new Error('El polígono necesita tres vértices distintos.');

  // Translate the shoelace formula to the first vertex to retain precision
  // for small profiles placed far from the origin.
  const origin = points[0];
  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[(i + points.length - 1) % points.length];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (near(current, next)) throw new Error('El polígono contiene un lado de longitud nula.');
    // Adjacent collinear edges may continue straight, but must not double back.
    if (onSegment(previous, current, next) || onSegment(current, next, previous)) {
      throw new Error('El polígono contiene lados superpuestos.');
    }
    twiceArea += (current[0] - origin[0]) * (next[1] - origin[1])
      - (current[1] - origin[1]) * (next[0] - origin[0]);
    for (let j = i + 2; j < points.length; j += 1) {
      if (i === 0 && j === points.length - 1) continue;
      if (segmentsIntersect(current, next, points[j], points[(j + 1) % points.length])) {
        throw new Error('El polígono se cruza o contiene vértices repetidos.');
      }
    }
  }
  if (Math.abs(twiceArea) <= MIN_AREA * 2) {
    throw new Error('El polígono debe encerrar una superficie mayor que cero.');
  }
  return points;
}

function validateEntity(entity: SketchEntity): void {
  if (!entity || typeof entity !== 'object') throw new Error('Entidad de boceto inválida.');
  if (entity.cut !== undefined && typeof entity.cut !== 'boolean') {
    throw new Error('La opción de recorte del perfil debe ser booleana.');
  }
  switch (entity.type) {
    case 'rectangle':
      coordinate(entity.x, 'Centro X');
      coordinate(entity.y, 'Centro Y');
      dimension(entity.width, 'Anchura');
      dimension(entity.height, 'Altura');
      coordinate(entity.x - entity.width / 2, 'Extremo X');
      coordinate(entity.x + entity.width / 2, 'Extremo X');
      coordinate(entity.y - entity.height / 2, 'Extremo Y');
      coordinate(entity.y + entity.height / 2, 'Extremo Y');
      return;
    case 'circle':
      coordinate(entity.x, 'Centro X');
      coordinate(entity.y, 'Centro Y');
      dimension(entity.radius, 'Radio');
      coordinate(entity.x - entity.radius, 'Extremo X');
      coordinate(entity.x + entity.radius, 'Extremo X');
      coordinate(entity.y - entity.radius, 'Extremo Y');
      coordinate(entity.y + entity.radius, 'Extremo Y');
      return;
    case 'polygon':
      polygonPoints(entity);
      return;
    default:
      throw new Error('Tipo de entidad de boceto no compatible.');
  }
}

function entityDrawing(entity: SketchEntity): Drawing {
  switch (entity.type) {
    case 'rectangle':
      return drawRectangle(entity.width, entity.height).translate(entity.x, entity.y);
    case 'circle':
      return drawCircle(entity.radius).translate(entity.x, entity.y);
    case 'polygon': {
      const points = polygonPoints(entity);
      const pen = draw(points[0]);
      for (const point of points.slice(1)) pen.lineTo(point);
      return pen.close();
    }
  }
}

/** Release a sketch that has not already been consumed by an operation. */
export function disposeSketch(sketch: BuiltSketch): void {
  if (sketch instanceof Sketches) {
    for (const child of sketch.sketches) child.delete();
  } else {
    sketch.delete();
  }
}

/**
 * Build closed planar profiles in millimetres. Rectangle x/y identify its
 * centre, exactly as circle x/y; polygon vertices are absolute plane-local
 * coordinates. All additive profiles are united first, then every cut profile
 * is subtracted, so entity order does not change the meaning of holes.
 *
 * Plane coordinates/normals follow Replicad: XY=(X,Y), normal +Z;
 * XZ=(X,Z), normal -Y; YZ=(Y,Z), normal +X. Offset is along that normal.
 *
 * Use result.extrude(distance) or result.revolve(axis, { origin, angle }).
 * Sketches may produce multiple solids. Build a fresh sketch for each operation:
 * Replicad consumes Sketch instances when extruding or revolving them.
 */
export function buildSketch(feature: SketchFeature): BuiltSketch {
  if (!feature || !['XY', 'XZ', 'YZ'].includes(feature.plane)) {
    throw new Error('El plano del boceto debe ser XY, XZ o YZ.');
  }
  coordinate(feature.offset, 'Desplazamiento del plano');
  if (!Array.isArray(feature.entities)
    || feature.entities.length === 0 || feature.entities.length > MAX_ENTITIES) {
    throw new Error('El boceto necesita entre 1 y 256 entidades.');
  }
  // Validate every input before allocating any OpenCascade shapes.
  feature.entities.forEach(validateEntity);
  const additive = feature.entities.filter((entity) => !entity.cut);
  if (!additive.length) throw new Error('El boceto necesita al menos un perfil sin recorte.');
  let drawing = entityDrawing(additive[0]);
  for (const entity of additive.slice(1)) drawing = drawing.fuse(entityDrawing(entity));
  for (const entity of feature.entities.filter((entity) => entity.cut)) {
    drawing = drawing.cut(entityDrawing(entity));
  }
  if (!drawing.toSVGPaths().flat().some((path) => path.length > 0)) {
    throw new Error('Los recortes han dejado el boceto vacío.');
  }
  const built = drawing.sketchOnPlane(feature.plane, feature.offset);
  if (!(built instanceof Sketch || built instanceof CompoundSketch || built instanceof Sketches)) {
    throw new Error('El núcleo no ha generado un boceto compatible.');
  }
  try {
    const profiles = built instanceof Sketches ? built.sketches : [built];
    if (!profiles.length) throw new Error('El boceto no contiene ningún perfil cerrado.');
    for (const profile of profiles) {
      const face = profile.face();
      try {
        if (face.isNull) throw new Error('El boceto contiene una superficie vacía.');
        const analyzer = new (getOC().BRepCheck_Analyzer)(face.wrapped, true, false, false);
        try {
          if (!analyzer.IsValid(face.wrapped)) throw new Error('El boceto genera una superficie inválida.');
        } finally {
          analyzer.delete();
        }
        const properties = measureShapeSurfaceProperties(face);
        try {
          if (!Number.isFinite(properties.area) || properties.area <= MIN_AREA) {
            throw new Error('El boceto debe encerrar una superficie mayor que cero.');
          }
        } finally {
          properties.delete();
        }
      } finally {
        face.delete();
      }
    }
    return built;
  } catch (error) {
    disposeSketch(built);
    throw error;
  }
}
