export type MeshData = { vertices: number[][]; faces: number[][] };
export type Units = 'mm' | 'cm' | 'in';
export type ShapeKind = 'box' | 'cylinder' | 'tube' | 'plate' | 'mesh';
export type Operation = { mode: 'cut' | 'add'; shape: 'cylinder' | 'box'; axis: 'x' | 'y' | 'z'; parameters: Record<string, number> };
export type ModelSpec = { kind: ShapeKind; parameters: Record<string, number>; transform?: number[][]; reference?: MeshData; operations?: Operation[] };
export type ModelPreview = { mesh: MeshData; volume: number; faces: number; valid: boolean };
export type Recognition = ModelSpec & { error_mm: number; description: string };
export type Analysis = {
  watertight: boolean;
  triangles: number;
  dimensions: number[];
  volume: number | null;
  warnings: string[];
};
export type AnalyzeResult = {
  name: string;
  source_units: Units;
  mesh: MeshData;
  analysis: Analysis;
  recognition: Recognition | null;
  model: ModelPreview | null;
};
export type SavedProject = {
  schema: 'edu3d-project';
  version: 1;
  name: string;
  source_units: Units;
  sourceMesh: MeshData;
  analysis: Analysis;
  recognition: Recognition | null;
  params: Record<string, number> | null;
  transform?: number[][];
  operations?: Operation[];
};
