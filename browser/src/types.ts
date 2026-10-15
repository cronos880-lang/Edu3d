export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Plane = 'XY' | 'XZ' | 'YZ';
export type Mode = 'new' | 'add' | 'cut' | 'intersect';
export type Units = 'mm' | 'cm' | 'in';
export type SketchEntity =
  | { id: string; type: 'rectangle'; x: number; y: number; width: number; height: number; cut?: boolean }
  | { id: string; type: 'circle'; x: number; y: number; radius: number; cut?: boolean }
  | { id: string; type: 'polygon'; points: Vec2[]; cut?: boolean };
export type BaseFeature = { id: string; name: string; suppressed?: boolean };
export type PrimitiveFeature = BaseFeature & {
  type: 'primitive'; kind: 'box' | 'cylinder' | 'sphere'; mode: Mode; target?: string;
  width: number; depth: number; height: number; radius: number; center: Vec3;
};
export type SketchFeature = BaseFeature & { type: 'sketch'; plane: Plane; offset: number; entities: SketchEntity[] };
export type ExtrudeFeature = BaseFeature & {
  type: 'extrude'; sketchId: string; distance: number; symmetric?: boolean; mode: Mode; target?: string;
};
export type RevolveFeature = BaseFeature & {
  type: 'revolve'; sketchId: string; angle: number; axis: 'X' | 'Y' | 'Z'; origin: Vec3; mode: Mode; target?: string;
};
export type ImportFeature = BaseFeature & { type: 'import'; assetId: string };
export type TransformFeature = BaseFeature & {
  type: 'transform'; target: string; translation: Vec3; rotation: Vec3; scale: Vec3;
};
export type FilletFeature = BaseFeature & { type: 'fillet'; target: string; radius: number; edges?: number[] };
export type ChamferFeature = BaseFeature & { type: 'chamfer'; target: string; distance: number; edges?: number[] };
export type ShellFeature = BaseFeature & { type: 'shell'; target: string; thickness: number; faces?: number[] };
export type BooleanFeature = BaseFeature & {
  type: 'boolean'; target: string; tool: string; operation: 'add' | 'cut' | 'intersect'; keepTool?: boolean;
};
export type PatternFeature = BaseFeature & {
  type: 'pattern'; target: string; kind: 'linear' | 'circular'; count: number; direction: Vec3; distance: number; angle: number; origin: Vec3;
};
export type MirrorFeature = BaseFeature & { type: 'mirror'; target: string; plane: Plane; offset: number; keepOriginal?: boolean };
export type Feature = PrimitiveFeature | SketchFeature | ExtrudeFeature | RevolveFeature | ImportFeature | TransformFeature | FilletFeature | ChamferFeature | ShellFeature | BooleanFeature | PatternFeature | MirrorFeature;
export type Asset = { id: string; name: string; format: 'stl' | 'step'; data: string; units: Units };
export type CadDocument = {
  schema: 'edu3d-cad'; version: 2; name: string; units: 'mm'; assets: Record<string, Asset>; features: Feature[];
};
export type MeshData = { vertices: Float32Array; triangles: Uint32Array; normals: Float32Array };
export type RenderBody = {
  id: string; name: string; mesh: MeshData;
  faceGroups: { start: number; count: number; faceIndex: number }[];
  edgePositions: Float32Array; edgeGroups: { start: number; count: number; edgeIndex: number }[];
  volume: number; area: number; bounds: { min: Vec3; max: Vec3 }; solids: number; imported?: boolean;
};
export type FeatureStatus = { id: string; status: 'ok' | 'suppressed' | 'error' | 'skipped'; message?: string };
export type BuildResult = { ok: boolean; bodies: RenderBody[]; features: FeatureStatus[]; warnings: string[]; durationMs: number };
export type Selection = { bodyId: string; kind: 'body' | 'face' | 'edge'; index?: number; point?: Vec3 };
export type CadProgress = { stage: string; progress?: number };
export type CadRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'build'; document: CadDocument }
  | { id: number; type: 'export'; format: 'step' | 'stl'; bodyIds?: string[] };
export type ExportResult = { data: ArrayBuffer; mime: string; extension: string };
export type CadResponse =
  | { id: number; type: 'ready' }
  | { id: number; type: 'progress'; progress: CadProgress }
  | { id: number; type: 'result'; result: BuildResult }
  | { id: number; type: 'export'; result: ExportResult }
  | { id: number; type: 'error'; message: string };
